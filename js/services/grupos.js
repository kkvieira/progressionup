// @ts-check
/* =====================================================================
   SERVIÇO DE GRUPOS / ESQUADRÕES E METAS (`services/grupos.js`)
   ---------------------------------------------------------------------
   - Criação de grupo (`criar_grupo`), entrada por ID ou código (`entrar_grupo`),
     promoção de cargos (`promover`), expulsão (`expulsar`) e saída com
     transferência automática de liderança (`sair_grupo`)
   - Convites de clã (`convidar_para_grupo`) e aprovação de solicitações
   - Consulta de metas semanais (`group_goals`) alimentadas automaticamente
     pelas triggers em `task_logs` e `game_runs`
   - Upload de emblema customizado para o bucket público `emblemas`
   ===================================================================== */

(function initGruposService() {
  const MAX_EMBLEM_BYTES = 1 * 1024 * 1024; // 1 MB
  const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

  function getClient() {
    return window.SB.requireClient();
  }

  function handleErr(err) {
    throw new Error(window.SB.translateError(err));
  }

  const gruposService = {
    EMBLEM_PRESETS: [
      { id: 'shield_cyan', name: 'ESCUDO CIANO',   icon: 'shield' },
      { id: 'blade_lime',  name: 'LÂMINA NEON',    icon: 'sword' },
      { id: 'skull_omega', name: 'CRÂNIO ÔMEGA',   icon: 'skull' },
      { id: 'mecha_core',  name: 'NÚCLEO MECHA',   icon: 'robot' },
      { id: 'bolt_gold',   name: 'RAIO DOURADO',   icon: 'bolt' },
      { id: 'eye_cyber',   name: 'VISOR TÁTICO',   icon: 'eye' }
    ],

    /**
     * Carrega o grupo atual do usuário autenticado (dados do grupo, membros com perfil,
     * metas da semana, conversa do grupo e convites pendentes).
     * @param {string} userId
     */
    async carregarMeuGrupo(userId) {
      const sb = getClient();

      // 1. Verifica se o usuário é membro de algum grupo
      const { data: myMembership, error: memErr } = await sb
        .from('group_members')
        .select('*, groups(*)')
        .eq('user_id', userId)
        .maybeSingle();

      if (memErr) handleErr(memErr);

      // 2. Busca convites recebidos pelo usuário caso ele ainda não esteja em um grupo
      const { data: myInvites } = await sb
        .from('group_invites')
        .select('*, groups(id, nome, tag, emblema, join_type)')
        .eq('user_id', userId)
        .eq('direction', 'invite')
        .eq('status', 'pending');

      if (!myMembership || !myMembership.groups) {
        return {
          inGroup: false,
          group: null,
          myRole: null,
          members: [],
          goals: [],
          conversationId: null,
          pendingRequests: [],
          myInvites: myInvites || []
        };
      }

      const group = myMembership.groups;

      // 3. Carrega membros do grupo, metas semanais, conversa e solicitações (se oficial/líder)
      const [membersRes, goalsRes, convRes, reqsRes] = await Promise.all([
        sb.from('group_members').select('*').eq('group_id', group.id).order('xp_contribuido', { ascending: false }),
        sb.from('group_goals').select('*').eq('group_id', group.id).order('semana', { ascending: false }).limit(4),
        sb.from('conversations').select('id').eq('group_id', group.id).maybeSingle(),
        ['leader', 'officer'].includes(myMembership.role)
          ? sb.from('group_invites').select('*').eq('group_id', group.id).eq('direction', 'request').eq('status', 'pending')
          : Promise.resolve({ data: [] })
      ]);

      const rawMembers = membersRes.data || [];
      const memberIds = rawMembers.map(m => m.user_id);

      /** @type {Record<string, any>} */
      const profMap = {};
      if (memberIds.length > 0) {
        const { data: profs } = await sb
          .from('public_profiles')
          .select('*')
          .in('id', memberIds);
        (profs || []).forEach(p => { profMap[p.id] = p; });
      }

      const members = rawMembers.map(m => ({
        ...m,
        profile: profMap[m.user_id] || {
          id: m.user_id,
          username: 'agente_' + m.user_id.slice(0, 5),
          level: 1
        }
      }));

      return {
        inGroup: true,
        group,
        myRole: myMembership.role,
        members,
        goals: goalsRes.data || [],
        conversationId: convRes.data?.id || null,
        pendingRequests: reqsRes.data || [],
        myInvites: myInvites || []
      };
    },

    /**
     * Lista grupos disponíveis para descoberta/recrutamento.
     * @param {string} [busca='']
     */
    async listarGruposPublicos(busca = '') {
      const sb = getClient();
      let query = sb
        .from('v_rank_groups')
        .select('*')
        .order('posicao', { ascending: true })
        .limit(20);

      if (busca && busca.trim()) {
        query = query.ilike('nome', `%${busca.trim()}%`);
      }

      const { data, error } = await query;
      if (error) handleErr(error);
      return data || [];
    },

    /**
     * Cria um novo grupo/esquadrão via RPC `criar_grupo`.
     * @param {{ nome: string, tag: string, descricao: string, emblema: string, joinType: 'open'|'invite'|'request' }} params
     */
    async criarGrupo({ nome, tag, descricao, emblema, joinType }) {
      const sb = getClient();
      const { data, error } = await sb.rpc('criar_grupo', {
        p_nome: nome,
        p_tag: tag,
        p_descricao: descricao || '',
        p_emblema: emblema || 'shield_cyan',
        p_join_type: joinType || 'open',
        p_emblema_url: null
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Entra em um grupo pelo ID UUID ou código de recrutamento (`entrar_grupo`).
     * @param {string} targetGroupIdOrCode
     */
    async entrarGrupo(targetGroupIdOrCode) {
      const sb = getClient();
      const { data, error } = await sb.rpc('entrar_grupo', {
        p_target: targetGroupIdOrCode
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Convida um agente pelo `@username` para o grupo (`convidar_para_grupo`).
     * @param {string} username
     */
    async convidarAgente(username) {
      const sb = getClient();
      const { data, error } = await sb.rpc('convidar_para_grupo', {
        p_username: username
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Promove ou altera o cargo de um membro (`promover`: leader, officer, member).
     * @param {string} targetUserId
     * @param {'leader'|'officer'|'member'} novoRole
     */
    async promoverMembro(targetUserId, novoRole) {
      const sb = getClient();
      const { data, error } = await sb.rpc('promover', {
        p_user_id: targetUserId,
        p_role: novoRole
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Expulsa um membro do grupo (`expulsar`).
     * @param {string} targetUserId
     */
    async expulsarMembro(targetUserId) {
      const sb = getClient();
      const { data, error } = await sb.rpc('expulsar', {
        p_user_id: targetUserId
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Sai do grupo atual com transferência automática de liderança (`sair_grupo`).
     */
    async sairDoGrupo() {
      const sb = getClient();
      const { data, error } = await sb.rpc('sair_grupo');
      if (error) handleErr(error);
      return data;
    },

    /**
     * Faz upload de um ícone customizado de emblema para o bucket público `emblemas`
     * e atualiza `emblema_url` no registro do grupo (requer cargo leader/officer).
     * @param {string} groupId
     * @param {File} file
     */
    async uploadEmblemaGrupo(groupId, file) {
      if (!file) throw new Error('SELECIONE UMA IMAGEM PARA O EMBLEMA.');
      if (!ALLOWED_MIME.includes(file.type)) {
        throw new Error('FORMATO INVÁLIDO! USE PNG, JPG OU WEBP.');
      }
      if (file.size > MAX_EMBLEM_BYTES) {
        throw new Error('O EMBLEMA DEVE TER NO MÁXIMO 1 MB.');
      }

      const sb = getClient();
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png';
      const storagePath = `${groupId}/emblema_${Date.now()}.${safeExt}`;

      const { error: upErr } = await sb.storage
        .from('emblemas')
        .upload(storagePath, file, {
          cacheControl: '3600',
          upsert: true,
          contentType: file.type
        });

      if (upErr) handleErr(upErr);

      const { data: pubUrlData } = sb.storage.from('emblemas').getPublicUrl(storagePath);
      const publicUrl = pubUrlData?.publicUrl || null;

      const { data: updatedGrp, error: grpErr } = await sb
        .from('groups')
        .update({ emblema_url: publicUrl })
        .eq('id', groupId)
        .select()
        .single();

      if (grpErr) handleErr(grpErr);
      return updatedGrp;
    }
  };

  window.SB = window.SB || {};
  window.SB.services = window.SB.services || {};
  window.SB.services.grupos = gruposService;
  window.SB.grupos = gruposService;
})();
