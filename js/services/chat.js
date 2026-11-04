// @ts-check
/* =====================================================================
   SERVIÇO DE CHAT EM TEMPO REAL (`services/chat.js`)
   ---------------------------------------------------------------------
   - Canais suportados: `global` (Rede Global), `group` (Esquadrão) e `dm` (Direto)
   - Assinatura Postgres Changes em `messages` filtrada por `conversation_id`
   - Paginação eficiente por cursor (`created_at < cursor`, `ORDER BY created_at DESC`)
   - Contagem de mensagens não lidas via `message_reads`
   - Evento efêmero “digitando...” via Broadcast no canal privado `chat:{conversation_id}`
     (nunca gravado no banco de dados)
   - Upload opcional de imagens até 2 MB (png/jpg/webp) para o bucket privado
     `anexos-chat` com geração de Signed URLs
   - Limpeza obrigatória de canais ao sair da tela (`supabase.removeChannel`)
   ===================================================================== */

/**
 * @typedef {Object} ChatMessage
 * @property {string} id
 * @property {string} conversation_id
 * @property {string|null} sender_id
 * @property {string} content
 * @property {string|null} attachment_url
 * @property {string|null} [signedAttachmentUrl]
 * @property {boolean} is_system
 * @property {boolean} flagged_for_review
 * @property {string} created_at
 * @property {{ username: string, level: number, moldura_equipada?: string|null }|null} [sender]
 */

(function initChatService() {
  const GLOBAL_CONVERSATION_ID = '00000000-0000-0000-0000-000000000001';
  const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2 MB
  const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

  let activeMessagesChannel = null;
  let activeTypingBroadcastChannel = null;
  let lastTypingSentAt = 0;

  /** @type {Record<string, { username: string, level: number, moldura_equipada?: string|null }>} */
  const senderCache = {};

  function getClient() {
    return window.SB.requireClient();
  }

  function handleErr(err) {
    throw new Error(window.SB.translateError(err));
  }

  const chatService = {
    GLOBAL_CONVERSATION_ID,

    /**
     * Lista as conversas das quais o usuário participa (Global, Grupo e DMs)
     * junto com a contagem de mensagens não lidas (`message_reads`).
     * @param {string} userId
     */
    async listarConversasComNaoLidas(userId) {
      const sb = getClient();

      // Garante que o usuário veja o canal global + conversas em que é membro
      const [membershipsRes, readsRes, groupMemberRes] = await Promise.all([
        sb.from('conversation_members').select('conversation_id, conversations(*)').eq('user_id', userId),
        sb.from('message_reads').select('conversation_id, last_read_at').eq('user_id', userId),
        sb.from('group_members').select('group_id, groups(id, nome, tag)').eq('user_id', userId).maybeSingle()
      ]);

      if (membershipsRes.error) handleErr(membershipsRes.error);

      /** @type {Record<string, string>} */
      const readMap = {};
      (readsRes.data || []).forEach(r => {
        readMap[r.conversation_id] = r.last_read_at;
      });

      const convMap = new Map();
      convMap.set(GLOBAL_CONVERSATION_ID, {
        id: GLOBAL_CONVERSATION_ID,
        tipo: 'global',
        titulo: '🌐 REDE GLOBAL DE AGENTES',
        group_id: null,
        unreadCount: 0
      });

      (membershipsRes.data || []).forEach(m => {
        if (m.conversations) {
          convMap.set(m.conversation_id, {
            ...m.conversations,
            unreadCount: 0
          });
        }
      });

      // Se o usuário pertence a um grupo, garante que a conversa do grupo esteja na lista
      if (groupMemberRes.data?.group_id) {
        const { data: grpConv } = await sb
          .from('conversations')
          .select('*')
          .eq('group_id', groupMemberRes.data.group_id)
          .maybeSingle();

        if (grpConv) {
          convMap.set(grpConv.id, {
            ...grpConv,
            titulo: `🛡️ ESQUADRÃO [${groupMemberRes.data.groups?.tag || 'CLÃ'}]`,
            unreadCount: 0
          });
        }
      }

      const convList = Array.from(convMap.values());

      // Resolve nomes de parceiros em conversas DM e calcula não lidas
      await Promise.all(
        convList.map(async conv => {
          if (conv.tipo === 'dm') {
            const { data: members } = await sb
              .from('conversation_members')
              .select('user_id')
              .eq('conversation_id', conv.id);

            const otherId = (members || []).map(x => x.user_id).find(id => id !== userId);
            if (otherId) {
              const { data: prof } = await sb
                .from('public_profiles')
                .select('id, username, level, character_nome')
                .eq('id', otherId)
                .maybeSingle();

              conv.dmPartner = prof || { id: otherId, username: 'agente_' + otherId.slice(0, 5), level: 1 };
              conv.titulo = `💬 @${(conv.dmPartner.username || 'agente').toUpperCase()}`;
            }
          }

          const lastRead = readMap[conv.id];
          let countQuery = sb
            .from('messages')
            .select('id', { count: 'exact', head: true })
            .eq('conversation_id', conv.id)
            .neq('sender_id', userId);

          if (lastRead) {
            countQuery = countQuery.gt('created_at', lastRead);
          }

          const { count } = await countQuery;
          conv.unreadCount = count || 0;
        })
      );

      return convList;
    },

    /**
     * Abre ou cria uma conversa DM com um amigo via RPC `abrir_ou_criar_dm`.
     * @param {string} friendUserId
     * @returns {Promise<string>} conversation_id
     */
    async abrirOuCriarDM(friendUserId) {
      const sb = getClient();
      const { data, error } = await sb.rpc('abrir_ou_criar_dm', {
        p_friend_id: friendUserId
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Busca mensagens de uma conversa com paginação por cursor (`beforeCreatedAt`).
     * Retorna em ordem cronológica crescente para exibição no HUD, acompanhado do
     * cursor `nextCursor` (timestamp da mensagem mais antiga carregada) para buscar páginas anteriores.
     * @param {string} conversationId
     * @param {{ limit?: number, beforeCreatedAt?: string|null }} [options]
     * @returns {Promise<{ messages: ChatMessage[], nextCursor: string|null, hasMore: boolean }>}
     */
    async carregarMensagensPaginadas(conversationId, { limit = 25, beforeCreatedAt = null } = {}) {
      const sb = getClient();
      let query = sb
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (beforeCreatedAt) {
        query = query.lt('created_at', beforeCreatedAt);
      }

      const { data, error } = await query;
      if (error) handleErr(error);

      const rawDesc = data || [];
      const hasMore = rawDesc.length === limit;
      const nextCursor = rawDesc.length > 0 ? rawDesc[rawDesc.length - 1].created_at : null;

      // Hidrata perfis dos remetentes e URLs assinadas de anexos
      const enriched = await this.hidratarMensagens(rawDesc.reverse());
      return {
        messages: enriched,
        nextCursor,
        hasMore
      };
    },

    /**
     * Hidrata lista de mensagens com dados públicos do remetente e Signed URLs do bucket `anexos-chat`.
     * @param {any[]} messages
     * @returns {Promise<ChatMessage[]>}
     */
    async hidratarMensagens(messages) {
      if (!messages || !messages.length) return [];
      const sb = getClient();

      const missingSenderIds = Array.from(
        new Set(messages.map(m => m.sender_id).filter(id => id && !senderCache[id]))
      );

      if (missingSenderIds.length > 0) {
        const { data: profs } = await sb
          .from('public_profiles')
          .select('id, username, level, moldura_equipada')
          .in('id', missingSenderIds);

        (profs || []).forEach(p => {
          senderCache[p.id] = {
            username: p.username || 'agente',
            level: p.level || 1,
            moldura_equipada: p.moldura_equipada || null
          };
        });
      }

      // Resolve anexos privados se existirem
      const attachmentPaths = messages
        .map(m => m.attachment_url)
        .filter(p => p && !p.startsWith('http'));

      /** @type {Record<string, string>} */
      const signedMap = {};
      if (attachmentPaths.length > 0) {
        const { data: signedData } = await sb.storage
          .from('anexos-chat')
          .createSignedUrls(attachmentPaths, 3600);

        (signedData || []).forEach(item => {
          if (item.path && item.signedUrl) signedMap[item.path] = item.signedUrl;
        });
      }

      return messages.map(m => ({
        ...m,
        sender: m.sender_id
          ? (senderCache[m.sender_id] || { username: 'agente_' + m.sender_id.slice(0, 5), level: 1 })
          : { username: 'SISTEMA', level: 99 },
        signedAttachmentUrl: m.attachment_url
          ? (signedMap[m.attachment_url] || (m.attachment_url.startsWith('http') ? m.attachment_url : null))
          : null
      }));
    },

    /**
     * Faz upload de anexo de imagem (até 2 MB, png/jpg/webp) para o bucket privado `anexos-chat`.
     * Caminho: `{conversation_id}/{user_id}/{timestamp_nome}`
     * @param {string} conversationId
     * @param {string} userId
     * @param {File} file
     */
    async uploadAnexoChat(conversationId, userId, file) {
      if (!file) throw new Error('NENHUM ARQUIVO SELECIONADO.');
      if (!ALLOWED_MIME.includes(file.type)) {
        throw new Error('FORMATO INVÁLIDO! ENVIE APENAS PNG, JPG OU WEBP.');
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        throw new Error('A IMAGEM EXCEDE O LIMITE DE 2 MB DO CHAT.');
      }

      const sb = getClient();
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'jpg';
      const path = `${conversationId}/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${safeExt}`;

      const { error } = await sb.storage
        .from('anexos-chat')
        .upload(path, file, {
          cacheControl: '3600',
          upsert: false,
          contentType: file.type
        });

      if (error) handleErr(error);
      return path;
    },

    /**
     * Envia mensagem na conversa via RPC `enviar_mensagem` (que aplica rate limit de 2s,
     * sanitização e checagem de bloqueio) e aciona opcionalmente a Edge Function `moderar-mensagem`.
     * @param {string} conversationId
     * @param {string} content
     * @param {string|null} [attachmentPath=null]
     */
    async enviarMensagem(conversationId, content, attachmentPath = null) {
      const sb = getClient();
      const { data, error } = await sb.rpc('enviar_mensagem', {
        p_conversation_id: conversationId,
        p_content: content,
        p_attachment_url: attachmentPath
      });
      if (error) handleErr(error);

      // Aciona assincronamente a Edge Function `moderar-mensagem` caso não haja Database Webhook ativo
      if (data?.message?.id) {
        sb.functions.invoke('moderar-mensagem', {
          body: { record: data.message }
        }).catch(() => {});
      }

      return data;
    },

    /**
     * Marca a conversa como lida (`marcar_conversa_lida`).
     * @param {string} conversationId
     */
    async marcarComoLida(conversationId) {
      const sb = getClient();
      await sb.rpc('marcar_conversa_lida', {
        p_conversation_id: conversationId
      });
    },

    /**
     * Denuncia uma mensagem ou usuário para os moderadores (`denunciar_conteudo`).
     * @param {{ reportedUserId?: string|null, messageId?: string|null, reason: string }} params
     */
    async denunciarMensagem({ reportedUserId = null, messageId = null, reason }) {
      const sb = getClient();
      const { data, error } = await sb.rpc('denunciar_conteudo', {
        p_reported_user_id: reportedUserId,
        p_message_id: messageId,
        p_group_id: null,
        p_reason: reason
      });
      if (error) handleErr(error);
      return data;
    },

    /**
     * Assina em tempo real uma conversa específica:
     * 1) Postgres Changes em `messages` filtrado por `conversation_id=eq.{conversationId}`
     * 2) Broadcast no canal `chat:{conversationId}` para o evento efêmero “digitando...”
     * @param {string} conversationId
     * @param {{ onNewMessage?: (msg: ChatMessage) => void, onTyping?: (typingPayload: { user_id: string, username: string }) => void }} callbacks
     */
    assinarConversa(conversationId, callbacks = {}) {
      const sb = getClient();
      this.desconectarConversaAtiva();

      // 1. Canal Postgres Changes restrito a `messages` da conversa atual
      activeMessagesChannel = sb
        .channel(`db:messages:${conversationId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'messages',
            filter: `conversation_id=eq.${conversationId}`
          },
          async payload => {
            if (payload?.new && typeof callbacks.onNewMessage === 'function') {
              const [hydrated] = await this.hidratarMensagens([payload.new]);
              callbacks.onNewMessage(hydrated);
            }
          }
        )
        .subscribe();

      // 2. Canal Broadcast para evento efêmero "digitando..." (nunca gravado no banco)
      activeTypingBroadcastChannel = sb
        .channel(`chat:${conversationId}`, {
          config: {
            broadcast: { self: false }
          }
        })
        .on('broadcast', { event: 'typing' }, ({ payload }) => {
          if (payload && typeof callbacks.onTyping === 'function') {
            callbacks.onTyping(payload);
          }
        })
        .subscribe();

      return {
        messagesChannel: activeMessagesChannel,
        typingChannel: activeTypingBroadcastChannel
      };
    },

    /**
     * Emite evento “digitando...” via Broadcast no canal da conversa (com throttle de 1.5s).
     * Nunca grava no banco de dados.
     * @param {string} userId
     * @param {string} username
     */
    emitirDigitando(userId, username) {
      if (!activeTypingBroadcastChannel) return;
      const now = Date.now();
      if (now - lastTypingSentAt < 1500) return;
      lastTypingSentAt = now;

      activeTypingBroadcastChannel.send({
        type: 'broadcast',
        event: 'typing',
        payload: {
          user_id: userId,
          username: username || 'agente',
          ts: now
        }
      }).catch(() => {});
    },

    /**
     * Cancela todas as assinaturas da conversa ativa ao trocar de canal ou fechar a aba Social (`supabase.removeChannel`).
     */
    desconectarConversaAtiva() {
      const sb = window.SB?.init ? window.SB.init() : null;
      if (!sb) return;
      if (activeMessagesChannel) {
        sb.removeChannel(activeMessagesChannel);
        activeMessagesChannel = null;
      }
      if (activeTypingBroadcastChannel) {
        sb.removeChannel(activeTypingBroadcastChannel);
        activeTypingBroadcastChannel = null;
      }
    }
  };

  window.SB = window.SB || {};
  window.SB.services = window.SB.services || {};
  window.SB.services.chat = chatService;
  window.SB.chat = chatService;
})();
