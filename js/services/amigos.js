// @ts-check
/* =====================================================================
   SERVIÇO DE AMIZADES, BLOQUEIOS, NOTIFICAÇÕES E PRESENCE (`services/amigos.js`)
   ---------------------------------------------------------------------
   - Usa exclusivamente `@supabase/supabase-js` v2
   - Gerencia pedidos de amizade (`enviar_pedido_amizade`, `responder_pedido`),
     remoção de amigos, bloqueios (`bloquear`, `desbloquear`) e busca na
     view segura `public_profiles`
   - Presence no canal `presence:global` enviando estritamente `{ user_id, status }`
     ('online' | 'jogando' | 'offline')
   - Postgres Changes restritos a `friendships` e `notifications` filtrados
     por `user_id`
   - Cancelamento limpo de assinaturas via `supabase.removeChannel`
   ===================================================================== */

/**
 * @typedef {'online' | 'jogando' | 'offline'} AgentPresenceStatus
 *
 * @typedef {Object} PublicProfile
 * @property {string} id
 * @property {string} username
 * @property {string|null} avatar_url
 * @property {'publico'|'amigos'|'privado'} privacy
 * @property {string|null} moldura_equipada
 * @property {string} bio
 * @property {number} level
 * @property {number} xp_total
 * @property {number} streak_atual
 * @property {number} maior_streak
 * @property {string|null} character_nome
 * @property {string|null} character_genero
 * @property {number|null} character_cor_pele
 * @property {string|null} character_cabelo
 * @property {number|null} character_cor_cabelo
 * @property {string|null} character_roupa
 * @property {number|null} character_cor_roupa
 * @property {string|null} character_classe
 * @property {string|null} character_arma
 * @property {number|null} character_nivel_arma
 * @property {string|null} group_tag
 *
 * @typedef {Object} FriendshipEntry
 * @property {string} id
 * @property {string} requester_id
 * @property {string} addressee_id
 * @property {'pending'|'accepted'|'blocked'} status
 * @property {string} created_at
 * @property {PublicProfile|null} friendProfile
 * @property {'incoming'|'outgoing'|'accepted'} direction
 */

(function initAmigosService() {
  let presenceChannel = null;
  let friendshipsSubChannel = null;
  let notificationsSubChannel = null;

  /** @type {Record<string, AgentPresenceStatus>} */
  const presenceMap = {};

  /** @type {AgentPresenceStatus} */
  let currentMyStatus = 'online';

  function getClient() {
    return window.SB.requireClient();
  }

  function handleErr(err) {
    throw new Error(window.SB.translateError(err));
  }

  const amigosService = {
    /**
     * Lista todas as relações de amizade (aceitas e pendentes) e a lista de bloqueados do usuário.
     * @param {string} userId
     * @returns {Promise<{ accepted: FriendshipEntry[], incoming: FriendshipEntry[], outgoing: FriendshipEntry[], blocks: any[] }>}
     */
    async listarRelacoes(userId) {
      const sb = getClient();
      const [frRes, blkRes] = await Promise.all([
        sb
          .from('friendships')
          .select('*')
          .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
          .order('created_at', { ascending: false }),
        sb
          .from('blocks')
          .select('*')
          .eq('blocker_id', userId)
          .order('created_at', { ascending: false })
      ]);

      if (frRes.error) handleErr(frRes.error);
      if (blkRes.error) handleErr(blkRes.error);

      const rows = frRes.data || [];
      const blocks = blkRes.data || [];

      const otherIds = new Set();
      rows.forEach(r => {
        otherIds.add(r.requester_id === userId ? r.addressee_id : r.requester_id);
      });
      blocks.forEach(b => otherIds.add(b.blocked_id));

      /** @type {Record<string, PublicProfile>} */
      const profileMap = {};
      if (otherIds.size > 0) {
        const { data: profs } = await sb
          .from('public_profiles')
          .select('*')
          .in('id', Array.from(otherIds));

        (profs || []).forEach(p => {
          profileMap[p.id] = p;
        });
      }

      const accepted = [];
      const incoming = [];
      const outgoing = [];

      rows.forEach(r => {
        if (r.status === 'blocked') return;
        const otherId = r.requester_id === userId ? r.addressee_id : r.requester_id;
        const entry = {
          ...r,
          friendProfile: profileMap[otherId] || {
            id: otherId,
            username: 'agente_' + otherId.slice(0, 5),
            level: 1,
            privacy: 'privado'
          },
          direction: r.status === 'accepted' ? 'accepted' : (r.addressee_id === userId ? 'incoming' : 'outgoing')
        };

        if (r.status === 'accepted') accepted.push(entry);
        else if (r.addressee_id === userId) incoming.push(entry);
        else outgoing.push(entry);
      });

      const enrichedBlocks = blocks.map(b => ({
        ...b,
        blockedProfile: profileMap[b.blocked_id] || { id: b.blocked_id, username: 'agente_' + b.blocked_id.slice(0, 5) }
      }));

      return { accepted, incoming, outgoing, blocks: enrichedBlocks };
    },

    /**
     * Busca perfil público de um agente pelo username ou ID (respeitando privacidade e bloqueios).
     * @param {string} query
     * @returns {Promise<PublicProfile[]>}
     */
    async buscarAgentes(query) {
      const sb = getClient();
      const clean = (query || '').trim().toLowerCase().replace(/^@/, '');
      if (!clean) return [];

      const { data, error } = await sb
        .from('public_profiles')
        .select('*')
        .ilike('username', `%${clean}%`)
        .limit(12);

      if (error) handleErr(error);
      return data || [];
    },

    /**
     * Envia um pedido de amizade pelo `@username` via RPC segura (`enviar_pedido_amizade`).
     * @param {string} username
     */
    async enviarPedidoAmizade(username) {
      const sb = getClient();
      const { data, error } = await sb.rpc('enviar_pedido_amizade', {
        p_username: username
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Responde a um pedido de amizade recebido (`responder_pedido`: somente o destinatário aceita).
     * @param {string} friendshipId
     * @param {boolean} aceitar
     */
    async responderPedido(friendshipId, aceitar) {
      const sb = getClient();
      const { data, error } = await sb.rpc('responder_pedido', {
        p_friendship_id: friendshipId,
        p_aceitar: Boolean(aceitar)
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Remove uma amizade existente ou cancela um pedido enviado (ambos podem remover).
     * @param {string} friendshipId
     */
    async removerAmizade(friendshipId) {
      const sb = getClient();
      const { error } = await sb
        .from('friendships')
        .delete()
        .eq('id', friendshipId);
      if (error) handleErr(error);
      return true;
    },

    /**
     * Bloqueia um usuário via RPC (`bloquear`), impedindo DMs e convites em qualquer direção.
     * @param {string} targetUserId
     */
    async bloquearUsuario(targetUserId) {
      const sb = getClient();
      const { data, error } = await sb.rpc('bloquear', {
        p_user_id: targetUserId
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Desbloqueia um usuário anteriormente bloqueado (`desbloquear`).
     * @param {string} targetUserId
     */
    async desbloquearUsuario(targetUserId) {
      const sb = getClient();
      const { data, error } = await sb.rpc('desbloquear', {
        p_user_id: targetUserId
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Lista notificações recentes do usuário autenticado.
     * @param {string} userId
     * @param {number} [limite=25]
     */
    async listarNotificacoes(userId, limite = 25) {
      const sb = getClient();
      const { data, error } = await sb
        .from('notifications')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(limite);

      if (error) handleErr(error);
      return data || [];
    },

    /**
     * Marca todas as notificações não lidas do usuário como lidas.
     * @param {string} userId
     */
    async marcarNotificacoesComoLidas(userId) {
      const sb = getClient();
      const { error } = await sb
        .from('notifications')
        .update({ lida: true })
        .eq('user_id', userId)
        .eq('lida', false);

      if (error) handleErr(error);
      return true;
    },

    /**
     * Conecta ao canal Realtime Presence `presence:global` enviando APENAS `{ user_id, status }`.
     * @param {string} userId
     * @param {AgentPresenceStatus} initialStatus
     * @param {(map: Record<string, AgentPresenceStatus>) => void} [onPresenceSync]
     */
    conectarPresenceGlobal(userId, initialStatus = 'online', onPresenceSync) {
      const sb = getClient();
      if (presenceChannel) {
        sb.removeChannel(presenceChannel);
        presenceChannel = null;
      }

      currentMyStatus = initialStatus;

      presenceChannel = sb.channel('presence:global', {
        config: {
          presence: { key: userId }
        }
      });

      const rebuildPresenceMap = () => {
        if (!presenceChannel) return;
        const state = presenceChannel.presenceState();
        Object.keys(presenceMap).forEach(k => delete presenceMap[k]);

        Object.entries(state).forEach(([key, presences]) => {
          if (Array.isArray(presences) && presences.length > 0) {
            const latest = presences[presences.length - 1];
            const uid = latest.user_id || key;
            presenceMap[uid] = latest.status || 'online';
          }
        });

        if (typeof onPresenceSync === 'function') {
          onPresenceSync({ ...presenceMap });
        }
      };

      presenceChannel
        .on('presence', { event: 'sync' }, rebuildPresenceMap)
        .on('presence', { event: 'join' }, rebuildPresenceMap)
        .on('presence', { event: 'leave' }, rebuildPresenceMap)
        .subscribe(async status => {
          if (status === 'SUBSCRIBED' && presenceChannel) {
            // Envia estritamente user_id e status conforme especificação
            await presenceChannel.track({
              user_id: userId,
              status: currentMyStatus
            });
          }
        });

      return presenceChannel;
    },

    /**
     * Atualiza o status de presença ('online' | 'jogando' | 'offline') no canal `presence:global`.
     * @param {string} userId
     * @param {AgentPresenceStatus} newStatus
     */
    async atualizarStatusPresence(userId, newStatus) {
      currentMyStatus = newStatus;
      if (!presenceChannel) return;
      try {
        await presenceChannel.track({
          user_id: userId,
          status: newStatus
        });
      } catch {
        // Ignora falha transitória de socket
      }
    },

    /**
     * Retorna o status atual de um usuário no mapa de Presence ('online' | 'jogando' | 'offline').
     * @param {string} userId
     * @returns {AgentPresenceStatus}
     */
    obterStatusAgente(userId) {
      return presenceMap[userId] || 'offline';
    },

    /**
     * Assina Postgres Changes apenas em `friendships` e `notifications` filtrados pelo `user_id`.
     * @param {string} userId
     * @param {{ onFriendshipChange?: (payload: any) => void, onNotification?: (notif: any) => void }} handlers
     */
    assinarEventosSociais(userId, handlers = {}) {
      const sb = getClient();
      this.cancelarAssinaturasEventos();

      friendshipsSubChannel = sb
        .channel(`social:friendships:${userId}`)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'friendships', filter: `addressee_id=eq.${userId}` },
          payload => {
            if (typeof handlers.onFriendshipChange === 'function') handlers.onFriendshipChange(payload);
          }
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'friendships', filter: `requester_id=eq.${userId}` },
          payload => {
            if (typeof handlers.onFriendshipChange === 'function') handlers.onFriendshipChange(payload);
          }
        )
        .subscribe();

      notificationsSubChannel = sb
        .channel(`social:notifications:${userId}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
          payload => {
            if (payload?.new && typeof handlers.onNotification === 'function') {
              handlers.onNotification(payload.new);
            }
          }
        )
        .subscribe();
    },

    /** Cancela assinaturas de Postgres Changes de amizades e notificações */
    cancelarAssinaturasEventos() {
      if (!window.SB?.init) return;
      const sb = window.SB.init();
      if (!sb) return;
      if (friendshipsSubChannel) {
        sb.removeChannel(friendshipsSubChannel);
        friendshipsSubChannel = null;
      }
      if (notificationsSubChannel) {
        sb.removeChannel(notificationsSubChannel);
        notificationsSubChannel = null;
      }
    },

    /** Cancela todas as assinaturas (incluindo Presence) ao sair/deslogar */
    desconectarTudo() {
      this.cancelarAssinaturasEventos();
      const sb = window.SB.init();
      if (sb && presenceChannel) {
        sb.removeChannel(presenceChannel);
        presenceChannel = null;
      }
    }
  };

  window.SB = window.SB || {};
  window.SB.services = window.SB.services || {};
  window.SB.services.amigos = amigosService;
  window.SB.amigos = amigosService;
})();
