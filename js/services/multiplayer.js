// @ts-check
/* =====================================================================
   SERVIÇO DE MULTIPLAYER COOPERATIVO (`services/multiplayer.js`)
   ---------------------------------------------------------------------
   - Usa exclusivamente Supabase Realtime Broadcast no canal privado `room:{room_id}`
     configurado com `self: false`
   - Taxa de envio de posição, animação e ações do jogador: 15–20 mensagens/segundo
     (intervalo de 55 ms ≈ 18.1 Hz)
   - Autoridade do Host: o host da sala é a autoridade sobre inimigos, maletas
     e boss, retransmitindo o estado sincronizado (`world_state`) e eventos de dano
   - Interpolação linear suave (`lerp`) dos jogadores remotos no cliente a 60 FPS
   - Reconexão automática em até 30 s caso a conexão oscile durante a partida
   - Cancelamento completo de canais ao encerrar ou sair (`supabase.removeChannel`)
   ===================================================================== */

/**
 * @typedef {Object} RemoteCoopPlayer
 * @property {string} user_id
 * @property {string} username
 * @property {string} nome
 * @property {number} level
 * @property {Object} character
 * @property {number} x
 * @property {number} y
 * @property {number} targetX
 * @property {number} targetY
 * @property {number} vx
 * @property {number} vy
 * @property {number} facing
 * @property {number} hp
 * @property {number} maxHp
 * @property {number} animFrame
 * @property {boolean} crouching
 * @property {number} atkVisualTimer
 * @property {number} lastUpdatedAt
 * @property {HTMLCanvasElement|null} [spriteIdle]
 * @property {HTMLCanvasElement|null} [spriteRun1]
 * @property {HTMLCanvasElement|null} [spriteRun2]
 */

(function initMultiplayerService() {
  const BROADCAST_INTERVAL_MS = 55; // ~18.1 msgs/segundo (dentro da faixa 15–20 Hz)
  const RECONNECT_WINDOW_MS = 30000; // 30 segundos para reconexão automática

  let roomChannel = null;
  let activeRoom = null;
  let isHost = false;
  let lastPlayerBroadcastAt = 0;
  let lastWorldBroadcastAt = 0;
  let reconnectTimer = null;
  let reconnectDeadline = 0;

  /** @type {Record<string, RemoteCoopPlayer>} */
  const remotePlayers = {};

  /** @type {{ onLobbyUpdate?: (players: any[], room: any) => void, onMatchStart?: (payload: any) => void, onPlayerAction?: (payload: any) => void, onWorldState?: (payload: any) => void, onHostEnemyDamage?: (payload: any) => void, onConnectionStatus?: (status: string) => void }} */
  let listeners = {};

  function getClient() {
    return window.SB.requireClient();
  }

  function handleErr(err) {
    throw new Error(window.SB.translateError(err));
  }

  /**
   * Gerador pseudoaleatório determinístico (Mulberry32) para que a fase gerada
   * com a `seed` da sala (`iniciar_sala`) seja idêntica no Host e nos Clientes.
   * @param {number} seed
   */
  function createSeededRandom(seed) {
    let a = (seed >>> 0) || 1337;
    return function nextRandom() {
      let t = (a += 0x6D2B79F5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const multiplayerService = {
    createSeededRandom,

    /** Retorna a sala cooperativa ativa no momento (ou null se estiver jogando solo) */
    obterSalaAtiva() {
      return activeRoom;
    },

    /** Indica se o cliente atual é o Host (autoridade da sala) */
    souHost() {
      return Boolean(activeRoom && isHost);
    },

    /** Retorna o mapa de jogadores remotos para renderização e interpolação no canvas */
    obterJogadoresRemotos() {
      return remotePlayers;
    },

    /**
     * Cria uma nova sala cooperativa via RPC `criar_sala(max_players)`.
     * @param {number} [maxPlayers=4]
     * @param {typeof listeners} [callbacks]
     */
    async criarSala(maxPlayers = 4, callbacks = {}) {
      const sb = getClient();
      const { data, error } = await sb.rpc('criar_sala', {
        p_max_players: maxPlayers
      });
      if (error) handleErr(error);

      activeRoom = data.room;
      isHost = true;
      listeners = callbacks;
      this.hidratarSnapshotsJogadores(data.players || []);
      await this.conectarCanalSala(activeRoom.id);
      return data;
    },

    /**
     * Entra em uma sala existente pelo código de 6 caracteres via RPC `entrar_sala(code)`.
     * @param {string} code
     * @param {typeof listeners} [callbacks]
     */
    async entrarSala(code, callbacks = {}) {
      const sb = getClient();
      const { data, error } = await sb.rpc('entrar_sala', {
        p_code: code
      });
      if (error) handleErr(error);

      activeRoom = data.room;
      isHost = activeRoom.host_id === window.currentUser?.id;
      listeners = callbacks;
      this.hidratarSnapshotsJogadores(data.players || []);
      await this.conectarCanalSala(activeRoom.id);

      // Notifica via Broadcast que um jogador entrou/reconectou no lobby
      this.enviarEventoLobby('lobby_sync', {
        room: activeRoom,
        players: data.players || []
      });

      return data;
    },

    /**
     * Busca a lista atualizada de participantes da sala no banco.
     * @param {string} roomId
     */
    async sincronizarParticipantesBanco(roomId) {
      const sb = getClient();
      const [roomRes, playersRes] = await Promise.all([
        sb.from('game_rooms').select('*').eq('id', roomId).maybeSingle(),
        sb.from('game_room_players').select('*').eq('room_id', roomId).order('joined_at', { ascending: true })
      ]);

      if (roomRes.data) {
        activeRoom = roomRes.data;
        isHost = activeRoom.host_id === window.currentUser?.id;
      }
      const list = playersRes.data || [];
      this.hidratarSnapshotsJogadores(list);
      if (typeof listeners.onLobbyUpdate === 'function') {
        listeners.onLobbyUpdate(list, activeRoom);
      }
      return { room: activeRoom, players: list };
    },

    /**
     * Inicia a partida cooperativa (exclusivo para o Host via RPC `iniciar_sala`).
     * Gera a `seed` no servidor e transmite `match_start` para todos no canal `room:{room_id}`.
     */
    async iniciarPartidaSala() {
      if (!activeRoom) throw new Error('NENHUMA SALA SELECIONADA.');
      const sb = getClient();
      const { data, error } = await sb.rpc('iniciar_sala', {
        p_room_id: activeRoom.id
      });
      if (error) handleErr(error);

      activeRoom = data.room;
      this.hidratarSnapshotsJogadores(data.players || []);

      const payload = {
        room: activeRoom,
        seed: data.seed,
        players: data.players || [],
        startedAt: Date.now()
      };

      if (roomChannel) {
        await roomChannel.send({
          type: 'broadcast',
          event: 'match_start',
          payload
        });
      }

      return payload;
    },

    /**
     * Finaliza a partida cooperativa registrando as estatísticas com validação anti-cheat (`finalizar_partida_coop`).
     * @param {{ distancia: number, inimigos_derrotados: number, boss_vencido: boolean, sem_dano: boolean, moedas_coletadas: number, duracao: number }} resultados
     */
    async finalizarPartidaCoop(resultados) {
      if (!activeRoom) return null;
      const sb = getClient();
      const { data, error } = await sb.rpc('finalizar_partida_coop', {
        p_room_id: activeRoom.id,
        p_resultados: resultados
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Prepara o mapa de `remotePlayers` a partir dos snapshots salvos em `game_room_players`.
     * @param {any[]} playersRows
     */
    hidratarSnapshotsJogadores(playersRows) {
      const myId = window.currentUser?.id;
      const activeIds = new Set();

      (playersRows || []).forEach(row => {
        if (!row.user_id || row.user_id === myId) return;
        activeIds.add(row.user_id);
        const snap = row.character_snapshot || {};
        const existing = remotePlayers[row.user_id];

        remotePlayers[row.user_id] = {
          user_id: row.user_id,
          username: snap.username || 'agente',
          nome: snap.nome || snap.username || 'Agente',
          level: snap.level || 1,
          character: {
            nome: snap.nome || 'Agente',
            genero: snap.genero || 'f',
            pele: Number(snap.pele ?? 1),
            cabelo: snap.cabelo || 'longo',
            corCabelo: Number(snap.corCabelo ?? 1),
            roupa: snap.roupa || 'viajante',
            corRoupa: Number(snap.corRoupa ?? 0),
            classe: snap.classe || 'guerreiro',
            arma: snap.arma || 'espada_longa'
          },
          x: existing?.x ?? 28,
          y: existing?.y ?? 130,
          targetX: existing?.targetX ?? 28,
          targetY: existing?.targetY ?? 130,
          vx: existing?.vx ?? 0,
          vy: existing?.vy ?? 0,
          facing: existing?.facing ?? 1,
          hp: existing?.hp ?? 100,
          maxHp: existing?.maxHp ?? 100,
          animFrame: existing?.animFrame ?? 0,
          crouching: false,
          atkVisualTimer: 0,
          lastUpdatedAt: Date.now()
        };
      });

      Object.keys(remotePlayers).forEach(uid => {
        if (!activeIds.has(uid)) delete remotePlayers[uid];
      });
    },

    /**
     * Conecta ao canal Realtime Broadcast `room:{room_id}` com `self: false` e
     * lógica de reconexão automática em até 30 segundos.
     * @param {string} roomId
     */
    async conectarCanalSala(roomId) {
      const sb = getClient();
      if (roomChannel) {
        sb.removeChannel(roomChannel);
        roomChannel = null;
      }

      roomChannel = sb.channel(`room:${roomId}`, {
        config: {
          broadcast: {
            self: false,
            ack: false
          }
        }
      });

      roomChannel
        // 1. Atualizações de lobby (entrada/saída de jogadores)
        .on('broadcast', { event: 'lobby_sync' }, async () => {
          await this.sincronizarParticipantesBanco(roomId);
        })
        // 2. Início da partida disparado pelo Host
        .on('broadcast', { event: 'match_start' }, ({ payload }) => {
          if (!payload) return;
          activeRoom = payload.room || activeRoom;
          this.hidratarSnapshotsJogadores(payload.players || []);
          if (typeof listeners.onMatchStart === 'function') {
            listeners.onMatchStart(payload);
          }
        })
        // 3. Posição e animação dos outros jogadores (15-20 Hz)
        .on('broadcast', { event: 'player_state' }, ({ payload }) => {
          if (!payload || !payload.u || payload.u === window.currentUser?.id) return;
          let rp = remotePlayers[payload.u];
          if (!rp) {
            rp = {
              user_id: payload.u,
              username: payload.n || 'Agente',
              nome: payload.n || 'Agente',
              level: payload.lv || 1,
              character: payload.ch || { nome: payload.n || 'Agente', genero: 'f', pele: 1, cabelo: 'longo', corCabelo: 1, roupa: 'viajante', corRoupa: 0, classe: 'guerreiro', arma: 'espada_longa' },
              x: payload.x,
              y: payload.y,
              targetX: payload.x,
              targetY: payload.y,
              vx: payload.vx || 0,
              vy: payload.vy || 0,
              facing: payload.f || 1,
              hp: payload.hp ?? 100,
              maxHp: payload.mhp ?? 100,
              animFrame: payload.af || 0,
              crouching: Boolean(payload.cr),
              atkVisualTimer: 0,
              lastUpdatedAt: Date.now()
            };
            remotePlayers[payload.u] = rp;
          } else {
            // Se a distância for muito grande (teleporte/respawn), cola direto; senão interpola
            if (Math.hypot(payload.x - rp.x, payload.y - rp.y) > 90) {
              rp.x = payload.x;
              rp.y = payload.y;
            }
            rp.targetX = payload.x;
            rp.targetY = payload.y;
            rp.vx = payload.vx || 0;
            rp.vy = payload.vy || 0;
            rp.facing = payload.f || 1;
            rp.hp = payload.hp ?? rp.hp;
            rp.maxHp = payload.mhp ?? rp.maxHp;
            rp.animFrame = payload.af || 0;
            rp.crouching = Boolean(payload.cr);
            rp.lastUpdatedAt = Date.now();
          }
        })
        // 4. Ações imediatas (ataque básico, habilidade especial)
        .on('broadcast', { event: 'player_action' }, ({ payload }) => {
          if (!payload || payload.u === window.currentUser?.id) return;
          const rp = remotePlayers[payload.u];
          if (rp) {
            rp.atkVisualTimer = 0.18;
            rp.facing = payload.f || rp.facing;
          }
          if (typeof listeners.onPlayerAction === 'function') {
            listeners.onPlayerAction(payload);
          }
        })
        // 5. Dano causado por cliente remoto em inimigo/boss -> processado pelo Host (autoridade)
        .on('broadcast', { event: 'client_hit' }, ({ payload }) => {
          if (!isHost || !payload) return;
          if (typeof listeners.onHostEnemyDamage === 'function') {
            listeners.onHostEnemyDamage(payload);
          }
        })
        // 6. Estado autoritativo do mundo transmitido pelo Host (inimigos, maletas e Boss)
        .on('broadcast', { event: 'world_state' }, ({ payload }) => {
          if (isHost || !payload) return;
          if (typeof listeners.onWorldState === 'function') {
            listeners.onWorldState(payload);
          }
        })
        .subscribe(status => {
          if (typeof listeners.onConnectionStatus === 'function') {
            listeners.onConnectionStatus(status);
          }

          if (status === 'SUBSCRIBED') {
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
              reconnectDeadline = 0;
              if (typeof window.setSyncStatus === 'function') {
                window.setSyncStatus('online', 'CO-OP SINCRONIZADO');
              }
            }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            this.agendarReconexaoAutomatica(roomId);
          }
        });

      return roomChannel;
    },

    /**
     * Tenta reconectar automaticamente ao canal `room:{room_id}` por até 30 segundos.
     * @param {string} roomId
     */
    agendarReconexaoAutomatica(roomId) {
      if (!activeRoom || activeRoom.id !== roomId) return;
      const now = Date.now();
      if (!reconnectDeadline) {
        reconnectDeadline = now + RECONNECT_WINDOW_MS;
      }

      if (now >= reconnectDeadline) {
        reconnectDeadline = 0;
        if (typeof window.setSyncStatus === 'function') {
          window.setSyncStatus('error', 'RECONEXÃO CO-OP EXPIROU (30S)');
        }
        return;
      }

      const remainingSec = Math.ceil((reconnectDeadline - now) / 1000);
      if (typeof window.setSyncStatus === 'function') {
        window.setSyncStatus('syncing', `RECONECTANDO SALA (${remainingSec}s)...`);
      }

      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        if (activeRoom && activeRoom.id === roomId) {
          this.conectarCanalSala(roomId).catch(() => {});
        }
      }, 2500);
    },

    /**
     * Envia estado de posição e animação do jogador local a 15–20 msgs/s (throttle de 55 ms).
     * @param {any} player
     */
    transmitirEstadoJogador(player) {
      if (!roomChannel || !activeRoom || !window.currentUser) return;
      const now = performance.now();
      if (now - lastPlayerBroadcastAt < BROADCAST_INTERVAL_MS) return;
      lastPlayerBroadcastAt = now;

      roomChannel.send({
        type: 'broadcast',
        event: 'player_state',
        payload: {
          u: window.currentUser.id,
          n: window.state?.profile?.nome || window.state?.username || 'Agente',
          lv: window.state?.level || 1,
          x: Math.round(player.x * 10) / 10,
          y: Math.round(player.y * 10) / 10,
          vx: Math.round(player.vx),
          vy: Math.round(player.vy),
          f: player.facing,
          hp: player.hp,
          mhp: player.maxHp,
          af: player.animFrame,
          cr: player.crouching
        }
      }).catch(() => {});
    },

    /**
     * Transmite ação imediata de ataque ou habilidade especial do jogador local.
     * @param {'attack'|'skill'} actionType
     * @param {any} player
     */
    transmitirAcaoJogador(actionType, player) {
      if (!roomChannel || !activeRoom || !window.currentUser) return;
      roomChannel.send({
        type: 'broadcast',
        event: 'player_action',
        payload: {
          u: window.currentUser.id,
          act: actionType,
          x: Math.round(player.x),
          y: Math.round(player.y),
          f: player.facing,
          cls: player.clsId
        }
      }).catch(() => {});
    },

    /**
     * Quando um cliente não-host acerta um inimigo ou o Boss, notifica o Host para
     * que o Host processe na autoridade central e retransmita no `world_state`.
     * @param {{ targetType: 'enemy'|'boss', enemyIndex?: number, dmg: number }} hitData
     */
    transmitirAcertoClienteParaHost(hitData) {
      if (!roomChannel || !activeRoom || isHost) return;
      roomChannel.send({
        type: 'broadcast',
        event: 'client_hit',
        payload: hitData
      }).catch(() => {});
    },

    /**
     * Exclusivo do Host: transmite estado compacto de inimigos vivos, maletas e Boss
     * a ~15 Hz para manter todos os clientes sincronizados.
     * @param {any} gameInstance
     */
    transmitirEstadoMundoHost(gameInstance) {
      if (!roomChannel || !activeRoom || !isHost || !gameInstance) return;
      const now = performance.now();
      if (now - lastWorldBroadcastAt < 65) return; // ~15.3 msgs/s
      lastWorldBroadcastAt = now;

      const st = gameInstance.stage;
      const enemiesCompact = st.enemies.map((en, idx) => [
        idx,
        Math.round(en.x),
        Math.round(en.y),
        en.hp,
        en.facing
      ]);

      const suitcasesCompact = gameInstance.suitcases.slice(0, 16).map(sc => [
        Math.round(sc.x),
        Math.round(sc.y),
        Math.round(sc.vx),
        Math.round(sc.vy),
        sc.mega ? 1 : 0
      ]);

      const b = st.boss;
      const bossCompact = b ? {
        a: b.active ? 1 : 0,
        d: b.defeated ? 1 : 0,
        x: Math.round(b.x),
        y: Math.round(b.y),
        hp: b.hp,
        mhp: b.maxHp,
        ph: b.phase,
        st: b.state,
        ex: b.exposed ? 1 : 0
      } : null;

      roomChannel.send({
        type: 'broadcast',
        event: 'world_state',
        payload: {
          e: enemiesCompact,
          s: suitcasesCompact,
          b: bossCompact,
          over: gameInstance.over ? 1 : 0,
          won: gameInstance.won ? 1 : 0
        }
      }).catch(() => {});
    },

    /**
     * Interpola suavemente a posição (`x`, `y`) de todos os jogadores remotos no cliente
     * a cada passo de física (`dt`).
     * @param {number} dt
     */
    interpolarJogadoresRemotos(dt) {
      const interpFactor = Math.min(1, dt * 15);
      Object.values(remotePlayers).forEach(rp => {
        // Predição leve pela velocidade + interpolação em direção ao alvo
        const predictedX = rp.targetX + (rp.vx || 0) * dt * 0.25;
        const predictedY = rp.targetY + (rp.vy || 0) * dt * 0.25;
        rp.x += (predictedX - rp.x) * interpFactor;
        rp.y += (predictedY - rp.y) * interpFactor;
        if (rp.atkVisualTimer > 0) {
          rp.atkVisualTimer = Math.max(0, rp.atkVisualTimer - dt);
        }
      });
    },

    /**
     * Envia evento auxiliar de lobby.
     * @param {string} eventName
     * @param {any} payload
     */
    enviarEventoLobby(eventName, payload) {
      if (!roomChannel) return;
      roomChannel.send({
        type: 'broadcast',
        event: eventName,
        payload
      }).catch(() => {});
    },

    /**
     * Sai da sala cooperativa atual e remove o canal Realtime (`supabase.removeChannel`).
     */
    async sairDaSala() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectDeadline = 0;

      const sb = window.SB?.init ? window.SB.init() : null;
      if (sb && activeRoom && window.currentUser) {
        try {
          if (activeRoom.status === 'waiting') {
            await sb
              .from('game_room_players')
              .delete()
              .eq('room_id', activeRoom.id)
              .eq('user_id', window.currentUser.id);
          }
          if (roomChannel) {
            await roomChannel.send({
              type: 'broadcast',
              event: 'lobby_sync',
              payload: { left: window.currentUser.id }
            });
          }
        } catch {}
      }

      if (sb && roomChannel) {
        sb.removeChannel(roomChannel);
        roomChannel = null;
      }

      activeRoom = null;
      isHost = false;
      Object.keys(remotePlayers).forEach(k => delete remotePlayers[k]);
    }
  };

  window.SB = window.SB || {};
  window.SB.services = window.SB.services || {};
  window.SB.services.multiplayer = multiplayerService;
  window.SB.multiplayer = multiplayerService;
})();
