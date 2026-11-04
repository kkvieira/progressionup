-- =============================================================================
-- MIGRAÇÃO 004: FUNÇÕES RPC (SECURITY DEFINER) E TRIGGERS DE PROGRESSÃO SOCIAL
-- =============================================================================
-- Todas as funções marcadas como SECURITY DEFINER, com validação de auth.uid()
-- e SET search_path = public:
--
-- 1. Amizades e Bloqueios:
--    - enviar_pedido_amizade(p_username TEXT)
--    - responder_pedido(p_friendship_id UUID, p_aceitar BOOLEAN)
--    - bloquear(p_target_user_id UUID)
--    - desbloquear(p_target_user_id UUID)
--    - abrir_ou_criar_dm(p_friend_id UUID)
--
-- 2. Chat e Mensagens:
--    - enviar_mensagem(p_conversation_id UUID, p_content TEXT, p_attachment_url TEXT)
--      com rate limit de máx 1 mensagem a cada 2 s por usuário (verificado na
--      última mensagem), sanitização básica e checagem de bloqueio.
--    - marcar_conversa_lida(p_conversation_id UUID)
--    - denunciar_conteudo(p_reported_user_id UUID, p_message_id UUID, p_group_id UUID, p_reason TEXT)
--
-- 3. Grupos / Clãs e Metas Semanais:
--    - criar_grupo(p_nome TEXT, p_tag TEXT, p_descricao TEXT, p_emblema TEXT, p_join_type TEXT)
--    - entrar_grupo(p_target TEXT) -- aceita UUID do grupo ou código do clã
--    - promover(p_user_id UUID, p_role TEXT)
--    - expulsar(p_user_id UUID)
--    - sair_grupo() -- com transferência automática de liderança
--    - contribuir_meta_grupo(p_user_id UUID, p_tipo TEXT, p_quantidade INTEGER, p_xp_extra INTEGER)
--      + triggers automáticos em `task_logs` e `game_runs`
--
-- 4. Salas Cooperativas (Multiplayer):
--    - criar_sala(p_max_players INTEGER)
--    - entrar_sala(p_code TEXT)
--    - alternar_pronto_sala(p_room_id UUID, p_ready BOOLEAN)
--    - iniciar_sala(p_room_id UUID) -- só o host; gera seed determinística
--    - finalizar_partida_coop(p_room_id UUID, p_resultados JSONB) -- anti-cheat
--
-- 5. Rankings:
--    - obter_ranking(p_categoria TEXT, p_periodo TEXT, p_limite INTEGER, p_offset INTEGER)
--    - minha_posicao(p_categoria TEXT, p_periodo TEXT)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. AMIZADES, BLOQUEIOS E DM
-- -----------------------------------------------------------------------------

-- RPC: Enviar pedido de amizade pelo username
CREATE OR REPLACE FUNCTION public.enviar_pedido_amizade(p_username TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_clean_username TEXT := lower(trim(regexp_replace(COALESCE(p_username, ''), '^@', '')));
  v_target RECORD;
  v_existing RECORD;
  v_friendship RECORD;
  v_sender_username TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO: Faça login para adicionar amigos.';
  END IF;

  IF v_clean_username = '' THEN
    RAISE EXCEPTION 'USERNAME_INVALIDO: Informe o codinome (@username) do agente.';
  END IF;

  SELECT id, username INTO v_target
  FROM public.profiles
  WHERE lower(username) = v_clean_username;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENTE_NAO_ENCONTRADO: Nenhum agente encontrado com o codinome @%.', v_clean_username;
  END IF;

  IF v_target.id = v_uid THEN
    RAISE EXCEPTION 'PEDIDO_PROPRIO_INVALIDO: Você não pode enviar um pedido de amizade para si mesmo.';
  END IF;

  IF public.is_blocked_between(v_uid, v_target.id) THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Não é possível interagir com este agente devido a um bloqueio ativo.';
  END IF;

  SELECT * INTO v_existing
  FROM public.friendships
  WHERE LEAST(requester_id, addressee_id) = LEAST(v_uid, v_target.id)
    AND GREATEST(requester_id, addressee_id) = GREATEST(v_uid, v_target.id);

  IF FOUND THEN
    IF v_existing.status = 'accepted' THEN
      RAISE EXCEPTION 'JA_SAO_AMIGOS: Vocês já são aliados na rede.';
    ELSIF v_existing.status = 'pending' THEN
      RAISE EXCEPTION 'PEDIDO_JA_PENDENTE: Já existe uma solicitação de amizade pendente entre vocês.';
    ELSE
      RAISE EXCEPTION 'USUARIO_BLOQUEADO: Solicitação indisponível.';
    END IF;
  END IF;

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (v_uid, v_target.id, 'pending')
  RETURNING * INTO v_friendship;

  SELECT username INTO v_sender_username FROM public.profiles WHERE id = v_uid;

  INSERT INTO public.notifications (user_id, tipo, titulo, mensagem, payload)
  VALUES (
    v_target.id,
    'friend_request',
    'NOVO PEDIDO DE ALIANÇA',
    format('O agente @%s enviou um pedido de amizade.', COALESCE(v_sender_username, 'agente')),
    jsonb_build_object('friendship_id', v_friendship.id, 'from_user_id', v_uid, 'from_username', v_sender_username)
  );

  RETURN jsonb_build_object(
    'friendship', row_to_json(v_friendship),
    'target_username', v_target.username
  );
END;
$$;

-- RPC: Responder pedido de amizade (somente o destinatário aceita; se recusar, remove)
CREATE OR REPLACE FUNCTION public.responder_pedido(
  p_friendship_id UUID,
  p_aceitar BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_fr RECORD;
  v_accepter_username TEXT;
  v_dm_id UUID;
  v_pair_key TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  SELECT * INTO v_fr
  FROM public.friendships
  WHERE id = p_friendship_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PEDIDO_NAO_ENCONTRADO: Solicitação de amizade não encontrada.';
  END IF;

  IF v_fr.addressee_id <> v_uid THEN
    RAISE EXCEPTION 'APENAS_DESTINATARIO_ACEITA: Apenas o destinatário pode responder a este pedido.';
  END IF;

  IF v_fr.status <> 'pending' THEN
    RAISE EXCEPTION 'PEDIDO_JA_PROCESSADO: Este pedido já foi respondido.';
  END IF;

  IF public.is_blocked_between(v_fr.requester_id, v_fr.addressee_id) THEN
    DELETE FROM public.friendships WHERE id = p_friendship_id;
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Ação cancelada por bloqueio.';
  END IF;

  IF p_aceitar THEN
    UPDATE public.friendships
    SET status = 'accepted', updated_at = NOW()
    WHERE id = p_friendship_id
    RETURNING * INTO v_fr;

    SELECT username INTO v_accepter_username FROM public.profiles WHERE id = v_uid;

    -- Garante que exista uma conversa DM entre os dois novos amigos
    v_pair_key := LEAST(v_fr.requester_id::text, v_fr.addressee_id::text) || ':' || GREATEST(v_fr.requester_id::text, v_fr.addressee_id::text);

    INSERT INTO public.conversations (tipo, dm_pair_key, titulo)
    VALUES ('dm', v_pair_key, 'CANAL DIRETO CRIPTOGRAFADO')
    ON CONFLICT (dm_pair_key) DO UPDATE SET updated_at = NOW()
    RETURNING id INTO v_dm_id;

    INSERT INTO public.conversation_members (conversation_id, user_id)
    VALUES (v_dm_id, v_fr.requester_id), (v_dm_id, v_fr.addressee_id)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;

    INSERT INTO public.notifications (user_id, tipo, titulo, mensagem, payload)
    VALUES (
      v_fr.requester_id,
      'friend_accepted',
      'ALIANÇA CONFIRMADA!',
      format('O agente @%s aceitou seu pedido de amizade.', COALESCE(v_accepter_username, 'agente')),
      jsonb_build_object('friendship_id', v_fr.id, 'friend_id', v_uid, 'conversation_id', v_dm_id)
    );

    RETURN jsonb_build_object('status', 'accepted', 'friendship', row_to_json(v_fr), 'conversation_id', v_dm_id);
  ELSE
    DELETE FROM public.friendships WHERE id = p_friendship_id;
    RETURN jsonb_build_object('status', 'declined', 'friendship_id', p_friendship_id);
  END IF;
END;
$$;

-- RPC: Bloquear usuário (registra em `blocks`, atualiza/remove amizade e convites pendentes)
CREATE OR REPLACE FUNCTION public.bloquear(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  IF p_user_id IS NULL OR p_user_id = v_uid THEN
    RAISE EXCEPTION 'OPERACAO_INVALIDA: Não é possível bloquear a si mesmo.';
  END IF;

  INSERT INTO public.blocks (blocker_id, blocked_id)
  VALUES (v_uid, p_user_id)
  ON CONFLICT (blocker_id, blocked_id) DO NOTHING;

  -- Remove amizade ou marca bloqueio no par
  DELETE FROM public.friendships
  WHERE LEAST(requester_id, addressee_id) = LEAST(v_uid, p_user_id)
    AND GREATEST(requester_id, addressee_id) = GREATEST(v_uid, p_user_id);

  INSERT INTO public.friendships (requester_id, addressee_id, status)
  VALUES (v_uid, p_user_id, 'blocked')
  ON CONFLICT ((LEAST(requester_id, addressee_id)), (GREATEST(requester_id, addressee_id)))
  DO UPDATE SET requester_id = v_uid, addressee_id = p_user_id, status = 'blocked', updated_at = NOW();

  -- Cancela convites de grupo pendentes entre os dois
  DELETE FROM public.group_invites
  WHERE (user_id = v_uid AND invited_by = p_user_id)
     OR (user_id = p_user_id AND invited_by = v_uid);

  RETURN jsonb_build_object('status', 'blocked', 'blocked_user_id', p_user_id);
END;
$$;

-- RPC: Desbloquear usuário
CREATE OR REPLACE FUNCTION public.desbloquear(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  DELETE FROM public.blocks
  WHERE blocker_id = v_uid AND blocked_id = p_user_id;

  DELETE FROM public.friendships
  WHERE requester_id = v_uid AND addressee_id = p_user_id AND status = 'blocked';

  RETURN jsonb_build_object('status', 'unblocked', 'user_id', p_user_id);
END;
$$;

-- RPC: Abrir ou criar conversa DM com um amigo
CREATE OR REPLACE FUNCTION public.abrir_ou_criar_dm(p_friend_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_pair_key TEXT;
  v_conv_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  IF p_friend_id IS NULL OR p_friend_id = v_uid THEN
    RAISE EXCEPTION 'DESTINATARIO_INVALIDO';
  END IF;

  IF public.is_blocked_between(v_uid, p_friend_id) THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Você não pode enviar mensagens para este agente.';
  END IF;

  IF NOT public.are_friends(v_uid, p_friend_id) THEN
    RAISE EXCEPTION 'APENAS_AMIGOS_DM: Adicione o agente como amigo antes de iniciar uma conversa direta.';
  END IF;

  v_pair_key := LEAST(v_uid::text, p_friend_id::text) || ':' || GREATEST(v_uid::text, p_friend_id::text);

  INSERT INTO public.conversations (tipo, dm_pair_key, titulo)
  VALUES ('dm', v_pair_key, 'CANAL DIRETO CRIPTOGRAFADO')
  ON CONFLICT (dm_pair_key) DO UPDATE SET updated_at = NOW()
  RETURNING id INTO v_conv_id;

  INSERT INTO public.conversation_members (conversation_id, user_id)
  VALUES (v_conv_id, v_uid), (v_conv_id, p_friend_id)
  ON CONFLICT (conversation_id, user_id) DO NOTHING;

  RETURN v_conv_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. CHAT E ENVIO DE MENSAGENS COM RATE LIMIT DE 2 SEGUNDOS E SANITIZAÇÃO
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enviar_mensagem(
  p_conversation_id UUID,
  p_content TEXT,
  p_attachment_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_conv RECORD;
  v_other_id UUID;
  v_last_msg_at TIMESTAMPTZ;
  v_clean TEXT;
  v_flagged BOOLEAN := FALSE;
  v_mod_reason TEXT := NULL;
  v_msg RECORD;
  v_sender RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO: Faça login para enviar mensagens.';
  END IF;

  -- Verifica se a conversa existe
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONVERSA_NAO_ENCONTRADA: Canal de comunicação inexistente.';
  END IF;

  -- Se for conversa global, garante que o usuário esteja registrado em conversation_members
  IF v_conv.tipo = 'global' THEN
    INSERT INTO public.conversation_members (conversation_id, user_id)
    VALUES (p_conversation_id, v_uid)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
  END IF;

  -- Checa se é membro autorizado e se não há bloqueio em DM
  IF v_conv.tipo = 'dm' THEN
    SELECT cm.user_id INTO v_other_id
    FROM public.conversation_members cm
    WHERE cm.conversation_id = p_conversation_id AND cm.user_id <> v_uid
    LIMIT 1;

    IF v_other_id IS NOT NULL AND public.is_blocked_between(v_uid, v_other_id) THEN
      RAISE EXCEPTION 'USUARIO_BLOQUEADO: Mensagem recusada pois há um bloqueio ativo nesta conversa.';
    END IF;
  END IF;

  IF NOT public.is_member(p_conversation_id) THEN
    RAISE EXCEPTION 'ACESSO_NEGADO_CONVERSA: Você não faz parte deste canal de comunicação.';
  END IF;

  -- Rate limit no servidor: máximo 1 mensagem a cada 2 segundos por usuário
  SELECT MAX(created_at) INTO v_last_msg_at
  FROM public.messages
  WHERE sender_id = v_uid
    AND is_system = FALSE;

  IF v_last_msg_at IS NOT NULL AND (NOW() - v_last_msg_at) < INTERVAL '2 seconds' THEN
    RAISE EXCEPTION 'RATE_LIMIT_MENSAGEM: Aguarde 2 segundos entre o envio de mensagens.';
  END IF;

  -- Sanitização básica (remove caracteres de controle invisíveis e tags HTML/script)
  v_clean := COALESCE(p_content, '');
  v_clean := regexp_replace(v_clean, '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g');
  v_clean := regexp_replace(v_clean, '<[^>]*>', '', 'g');
  v_clean := trim(v_clean);

  IF char_length(v_clean) < 1 THEN
    RAISE EXCEPTION 'MENSAGEM_VAZIA: Digite um conteúdo válido para enviar.';
  END IF;

  IF char_length(v_clean) > 500 THEN
    RAISE EXCEPTION 'MENSAGEM_MUITO_LONGA: A mensagem deve ter no máximo 500 caracteres.';
  END IF;

  -- Filtro preventivo básico (complementado pela Edge Function `moderar-mensagem` via Webhook)
  IF v_clean ~* '(https?://[^\s]*\.(bit\.ly|tinyurl\.com|grabify|iplogger)|discord\.gg/|free\s*nitro|phishing)' THEN
    v_flagged := TRUE;
    v_mod_reason := 'LINK_SUSPEITO_DETECTADO';
  END IF;

  INSERT INTO public.messages (
    conversation_id, sender_id, content, attachment_url, is_system, flagged_for_review, moderation_reason
  ) VALUES (
    p_conversation_id, v_uid, v_clean, NULLIF(trim(COALESCE(p_attachment_url, '')), ''), FALSE, v_flagged, v_mod_reason
  )
  RETURNING * INTO v_msg;

  -- Atualiza timestamp da conversa e leitura do próprio remetente
  UPDATE public.conversations SET updated_at = NOW() WHERE id = p_conversation_id;

  INSERT INTO public.message_reads (user_id, conversation_id, last_read_at)
  VALUES (v_uid, p_conversation_id, NOW())
  ON CONFLICT (user_id, conversation_id)
  DO UPDATE SET last_read_at = NOW();

  SELECT id, username, level, moldura_equipada INTO v_sender
  FROM public.profiles
  WHERE id = v_uid;

  RETURN jsonb_build_object(
    'message', row_to_json(v_msg),
    'sender', row_to_json(v_sender)
  );
END;
$$;

-- RPC: Marcar conversa como lida
CREATE OR REPLACE FUNCTION public.marcar_conversa_lida(p_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT public.is_member(p_conversation_id) THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.message_reads (user_id, conversation_id, last_read_at)
  VALUES (v_uid, p_conversation_id, NOW())
  ON CONFLICT (user_id, conversation_id)
  DO UPDATE SET last_read_at = NOW();

  RETURN TRUE;
END;
$$;

-- RPC: Denunciar mensagem, agente ou grupo
CREATE OR REPLACE FUNCTION public.denunciar_conteudo(
  p_reported_user_id UUID DEFAULT NULL,
  p_message_id UUID DEFAULT NULL,
  p_group_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT 'Conduta inadequada'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_rep RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  IF char_length(trim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'MOTIVO_INVALIDO: Descreva o motivo da denúncia.';
  END IF;

  INSERT INTO public.reports (reporter_id, reported_user_id, message_id, group_id, reason)
  VALUES (v_uid, p_reported_user_id, p_message_id, p_group_id, substr(trim(p_reason), 1, 300))
  RETURNING * INTO v_rep;

  IF p_message_id IS NOT NULL THEN
    UPDATE public.messages
    SET flagged_for_review = TRUE,
        moderation_reason = COALESCE(moderation_reason, 'REPORTADO_POR_AGENTE')
    WHERE id = p_message_id;
  END IF;

  RETURN row_to_json(v_rep)::JSONB;
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. GRUPOS / CLÃS E METAS COLETIVAS
-- -----------------------------------------------------------------------------

-- RPC: Criar Grupo / Esquadrão (cria grupo, adiciona líder, conversa do grupo e metas semanais)
CREATE OR REPLACE FUNCTION public.criar_grupo(
  p_nome TEXT,
  p_tag TEXT DEFAULT NULL,
  p_descricao TEXT DEFAULT '',
  p_emblema TEXT DEFAULT 'shield_cyan',
  p_join_type TEXT DEFAULT 'open',
  p_emblema_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_clean_nome TEXT := trim(COALESCE(p_nome, ''));
  v_clean_tag TEXT := upper( regexp_replace(trim(COALESCE(p_tag, substr(v_clean_nome, 1, 4))), '[^A-Za-z0-9]', '', 'g') );
  v_join TEXT := COALESCE(p_join_type, 'open');
  v_group RECORD;
  v_conv RECORD;
  v_semana DATE := date_trunc('week', CURRENT_DATE)::DATE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  IF EXISTS (SELECT 1 FROM public.group_members WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'JA_POSSUI_GRUPO: Saia do seu esquadrão atual antes de fundar um novo.';
  END IF;

  IF char_length(v_clean_nome) < 3 OR char_length(v_clean_nome) > 32 THEN
    RAISE EXCEPTION 'NOME_GRUPO_INVALIDO: O nome do esquadrão deve ter entre 3 e 32 caracteres.';
  END IF;

  IF char_length(v_clean_tag) < 2 THEN
    v_clean_tag := upper(substr(replace(v_clean_nome, ' ', ''), 1, 3));
  END IF;
  v_clean_tag := substr(v_clean_tag, 1, 5);

  IF v_join NOT IN ('open', 'invite', 'request') THEN
    v_join := 'open';
  END IF;

  INSERT INTO public.groups (
    nome, tag, descricao, emblema, emblema_url, join_type, max_members, owner_id
  ) VALUES (
    v_clean_nome, v_clean_tag, substr(trim(COALESCE(p_descricao, '')), 1, 300),
    COALESCE(NULLIF(trim(p_emblema), ''), 'shield_cyan'),
    p_emblema_url,
    v_join, 30, v_uid
  )
  RETURNING * INTO v_group;

  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (v_group.id, v_uid, 'leader');

  -- Cria canal de chat exclusivo do grupo
  INSERT INTO public.conversations (tipo, group_id, titulo)
  VALUES ('group', v_group.id, 'CHAT DO ESQUADRÃO [' || v_group.tag || ']')
  RETURNING * INTO v_conv;

  INSERT INTO public.conversation_members (conversation_id, user_id)
  VALUES (v_conv.id, v_uid)
  ON CONFLICT DO NOTHING;

  -- Cria as 2 metas semanais padrão do grupo
  INSERT INTO public.group_goals (group_id, titulo, tipo, meta, progresso, recompensa_moedas, semana)
  VALUES
    (v_group.id, 'Concluir 35 Missões Diárias em Equipe', 'missoes', 35, 0, 60, v_semana),
    (v_group.id, 'Derrotar 5 Mecha-Bosses na Cidade',     'bosses',   5, 0, 80, v_semana)
  ON CONFLICT (group_id, semana, tipo) DO NOTHING;

  -- Mensagem de sistema inaugural
  INSERT INTO public.messages (conversation_id, sender_id, content, is_system)
  VALUES (
    v_conv.id,
    v_uid,
    format('⚡ ESQUADRÃO [%s] %s FUNDADO! Código de recrutamento: %s', v_group.tag, upper(v_group.nome), v_group.codigo),
    TRUE
  );

  RETURN jsonb_build_object(
    'group', row_to_json(v_group),
    'conversation_id', v_conv.id
  );
END;
$$;

-- RPC: Entrar em um grupo (por UUID ou por código de recrutamento)
CREATE OR REPLACE FUNCTION public.entrar_grupo(p_target TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_clean TEXT := trim(COALESCE(p_target, ''));
  v_group RECORD;
  v_count INTEGER;
  v_conv_id UUID;
  v_has_invite BOOLEAN := FALSE;
  v_username TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  IF EXISTS (SELECT 1 FROM public.group_members WHERE user_id = v_uid) THEN
    RAISE EXCEPTION 'JA_POSSUI_GRUPO: Você já pertence a um esquadrão. Saia dele primeiro.';
  END IF;

  -- Localiza grupo pelo ID UUID ou pelo código alfanumérico
  SELECT * INTO v_group
  FROM public.groups
  WHERE id::text = v_clean OR upper(codigo) = upper(v_clean)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GRUPO_NAO_ENCONTRADO: Esquadrão não encontrado para o código ou ID informado.';
  END IF;

  IF public.is_blocked_between(v_uid, v_group.owner_id) THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Não é possível ingressar neste esquadrão.';
  END IF;

  SELECT COUNT(*) INTO v_count FROM public.group_members WHERE group_id = v_group.id;
  IF v_count >= v_group.max_members THEN
    RAISE EXCEPTION 'GRUPO_LOTADO: Este esquadrão atingiu o limite máximo de % agentes.', v_group.max_members;
  END IF;

  -- Verifica se o usuário possui convite pendente para este grupo
  SELECT EXISTS (
    SELECT 1 FROM public.group_invites
    WHERE group_id = v_group.id AND user_id = v_uid AND direction = 'invite' AND status = 'pending'
  ) INTO v_has_invite;

  IF v_group.join_type = 'invite' AND NOT v_has_invite AND upper(v_group.codigo) <> upper(v_clean) THEN
    RAISE EXCEPTION 'GRUPO_APENAS_CONVITE: Este esquadrão aceita novos integrantes apenas por convite ou código.';
  END IF;

  IF v_group.join_type = 'request' AND NOT v_has_invite AND upper(v_group.codigo) <> upper(v_clean) THEN
    INSERT INTO public.group_invites (group_id, user_id, invited_by, direction, status)
    VALUES (v_group.id, v_uid, v_uid, 'request', 'pending')
    ON CONFLICT (group_id, user_id, direction) DO UPDATE SET status = 'pending', updated_at = NOW();

    RETURN jsonb_build_object(
      'status', 'request_sent',
      'message', 'Solicitação de entrada enviada aos oficiais do esquadrão!'
    );
  END IF;

  -- Ingressa efetivamente no grupo
  INSERT INTO public.group_members (group_id, user_id, role)
  VALUES (v_group.id, v_uid, 'member');

  UPDATE public.group_invites
  SET status = 'accepted', updated_at = NOW()
  WHERE group_id = v_group.id AND user_id = v_uid AND status = 'pending';

  SELECT id INTO v_conv_id FROM public.conversations WHERE group_id = v_group.id;
  IF v_conv_id IS NOT NULL THEN
    INSERT INTO public.conversation_members (conversation_id, user_id)
    VALUES (v_conv_id, v_uid)
    ON CONFLICT DO NOTHING;

    SELECT username INTO v_username FROM public.profiles WHERE id = v_uid;
    INSERT INTO public.messages (conversation_id, sender_id, content, is_system)
    VALUES (
      v_conv_id,
      v_uid,
      format('🤝 O agente @%s ingressou no esquadrão!', COALESCE(v_username, 'agente')),
      TRUE
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'joined',
    'group', row_to_json(v_group),
    'conversation_id', v_conv_id
  );
END;
$$;

-- RPC: Convidar agente para o grupo (líder ou oficial)
CREATE OR REPLACE FUNCTION public.convidar_para_grupo(p_username TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_my_gm RECORD;
  v_group RECORD;
  v_target RECORD;
  v_inv RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  SELECT * INTO v_my_gm FROM public.group_members WHERE user_id = v_uid;
  IF NOT FOUND OR v_my_gm.role NOT IN ('leader', 'officer') THEN
    RAISE EXCEPTION 'PERMISSAO_NEGADA: Apenas líderes e oficiais podem convidar agentes.';
  END IF;

  SELECT * INTO v_group FROM public.groups WHERE id = v_my_gm.group_id;

  SELECT id, username INTO v_target
  FROM public.profiles
  WHERE lower(username) = lower(trim(regexp_replace(COALESCE(p_username, ''), '^@', '')));

  IF NOT FOUND THEN
    RAISE EXCEPTION 'AGENTE_NAO_ENCONTRADO: Codinome não localizado.';
  END IF;

  IF public.is_blocked_between(v_uid, v_target.id) THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Não é possível convidar este agente.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.group_members WHERE user_id = v_target.id) THEN
    RAISE EXCEPTION 'AGENTE_JA_EM_GRUPO: Este agente já participa de um esquadrão.';
  END IF;

  INSERT INTO public.group_invites (group_id, user_id, invited_by, direction, status)
  VALUES (v_group.id, v_target.id, v_uid, 'invite', 'pending')
  ON CONFLICT (group_id, user_id, direction)
  DO UPDATE SET invited_by = v_uid, status = 'pending', updated_at = NOW()
  RETURNING * INTO v_inv;

  INSERT INTO public.notifications (user_id, tipo, titulo, mensagem, payload)
  VALUES (
    v_target.id,
    'group_invite',
    'CONVITE DE ESQUADRÃO',
    format('Você foi convidado para o esquadrão [%s] %s!', v_group.tag, v_group.nome),
    jsonb_build_object('group_id', v_group.id, 'group_nome', v_group.nome, 'codigo', v_group.codigo, 'invite_id', v_inv.id)
  );

  RETURN row_to_json(v_inv)::JSONB;
END;
$$;

-- RPC: Promover ou alterar cargo de membro no grupo (`officer` | `member` | `leader`)
CREATE OR REPLACE FUNCTION public.promover(
  p_user_id UUID,
  p_role TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_my_gm RECORD;
  v_target_gm RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  IF p_role NOT IN ('leader', 'officer', 'member') THEN
    RAISE EXCEPTION 'CARGO_INVALIDO: Use leader, officer ou member.';
  END IF;

  SELECT * INTO v_my_gm FROM public.group_members WHERE user_id = v_uid;
  IF NOT FOUND OR v_my_gm.role <> 'leader' THEN
    RAISE EXCEPTION 'APENAS_LIDER_PROMOVE: Apenas o líder do esquadrão pode alterar cargos.';
  END IF;

  SELECT * INTO v_target_gm
  FROM public.group_members
  WHERE group_id = v_my_gm.group_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBRO_NAO_ENCONTRADO: O agente não pertence ao seu esquadrão.';
  END IF;

  IF p_role = 'leader' THEN
    -- Transfere liderança para o alvo e torna o líder atual oficial
    UPDATE public.group_members SET role = 'officer', updated_at = NOW() WHERE id = v_my_gm.id;
    UPDATE public.group_members SET role = 'leader', updated_at = NOW() WHERE id = v_target_gm.id;
    UPDATE public.groups SET owner_id = p_user_id, updated_at = NOW() WHERE id = v_my_gm.group_id;
  ELSE
    UPDATE public.group_members
    SET role = p_role, updated_at = NOW()
    WHERE id = v_target_gm.id;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'user_id', p_user_id, 'new_role', p_role);
END;
$$;

-- RPC: Expulsar membro do grupo (líder expulsa oficial/membro; oficial expulsa apenas membro)
CREATE OR REPLACE FUNCTION public.expulsar(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_my_gm RECORD;
  v_target_gm RECORD;
  v_conv_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  IF p_user_id = v_uid THEN
    RAISE EXCEPTION 'OPERACAO_INVALIDA: Use sair_grupo() para deixar o esquadrão.';
  END IF;

  SELECT * INTO v_my_gm FROM public.group_members WHERE user_id = v_uid;
  IF NOT FOUND OR v_my_gm.role NOT IN ('leader', 'officer') THEN
    RAISE EXCEPTION 'PERMISSAO_NEGADA: Apenas líderes e oficiais podem expulsar integrantes.';
  END IF;

  SELECT * INTO v_target_gm
  FROM public.group_members
  WHERE group_id = v_my_gm.group_id AND user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'MEMBRO_NAO_ENCONTRADO';
  END IF;

  IF v_target_gm.role = 'leader' OR (v_my_gm.role = 'officer' AND v_target_gm.role = 'officer') THEN
    RAISE EXCEPTION 'HIERARQUIA_INSUFICIENTE: Você não pode expulsar um integrante de patente igual ou superior.';
  END IF;

  DELETE FROM public.group_members WHERE id = v_target_gm.id;

  SELECT id INTO v_conv_id FROM public.conversations WHERE group_id = v_my_gm.group_id;
  IF v_conv_id IS NOT NULL THEN
    DELETE FROM public.conversation_members WHERE conversation_id = v_conv_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object('status', 'kicked', 'user_id', p_user_id);
END;
$$;

-- RPC: Sair do grupo com transferência automática de liderança
CREATE OR REPLACE FUNCTION public.sair_grupo()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_my_gm RECORD;
  v_next_leader RECORD;
  v_conv_id UUID;
  v_username TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  SELECT * INTO v_my_gm
  FROM public.group_members
  WHERE user_id = v_uid
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'NAO_ESTA_EM_GRUPO: Você não pertence a nenhum esquadrão no momento.';
  END IF;

  SELECT id INTO v_conv_id FROM public.conversations WHERE group_id = v_my_gm.group_id;

  DELETE FROM public.group_members WHERE id = v_my_gm.id;

  IF v_conv_id IS NOT NULL THEN
    DELETE FROM public.conversation_members WHERE conversation_id = v_conv_id AND user_id = v_uid;
  END IF;

  -- Se era o líder, escolhe o próximo líder (oficial mais antigo ou membro mais antigo)
  IF v_my_gm.role = 'leader' THEN
    SELECT * INTO v_next_leader
    FROM public.group_members
    WHERE group_id = v_my_gm.group_id
    ORDER BY (CASE WHEN role = 'officer' THEN 0 ELSE 1 END) ASC,
             xp_contribuido DESC,
             created_at ASC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      UPDATE public.group_members
      SET role = 'leader', updated_at = NOW()
      WHERE id = v_next_leader.id;

      UPDATE public.groups
      SET owner_id = v_next_leader.user_id, updated_at = NOW()
      WHERE id = v_my_gm.group_id;

      IF v_conv_id IS NOT NULL THEN
        SELECT username INTO v_username FROM public.profiles WHERE id = v_next_leader.user_id;
        INSERT INTO public.messages (conversation_id, sender_id, content, is_system)
        VALUES (
          v_conv_id,
          v_next_leader.user_id,
          format('👑 Liderança do esquadrão transferida automaticamente para @%s.', COALESCE(v_username, 'agente')),
          TRUE
        );
      END IF;

      RETURN jsonb_build_object(
        'status', 'left_and_transferred',
        'new_leader_id', v_next_leader.user_id
      );
    ELSE
      -- Último membro saiu: dissolve o grupo
      DELETE FROM public.groups WHERE id = v_my_gm.group_id;
      RETURN jsonb_build_object('status', 'group_dissolved');
    END IF;
  END IF;

  RETURN jsonb_build_object('status', 'left');
END;
$$;

-- Função Interna / RPC: Contribuir para a meta semanal do grupo e somar XP coletivo
-- Acionada automaticamente via triggers quando um membro conclui tarefas (`task_logs`)
-- ou vence partidas/bosses (`game_runs`).
CREATE OR REPLACE FUNCTION public.contribuir_meta_grupo(
  p_user_id UUID,
  p_tipo TEXT,
  p_quantidade INTEGER DEFAULT 1,
  p_xp_extra INTEGER DEFAULT 0
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gm RECORD;
  v_goal RECORD;
  v_conv_id UUID;
  v_semana DATE := date_trunc('week', CURRENT_DATE)::DATE;
  v_new_prog INTEGER;
  v_member RECORD;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  SELECT * INTO v_gm FROM public.group_members WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Atualiza XP contribuído pelo membro e XP total do grupo
  IF COALESCE(p_xp_extra, 0) > 0 THEN
    UPDATE public.group_members
    SET xp_contribuido = xp_contribuido + p_xp_extra,
        updated_at = NOW()
    WHERE id = v_gm.id;

    UPDATE public.groups
    SET xp_total_grupo = xp_total_grupo + p_xp_extra,
        updated_at = NOW()
    WHERE id = v_gm.group_id;
  END IF;

  -- Atualiza metas semanais correspondentes ao tipo ('missoes', 'bosses', 'xp')
  FOR v_goal IN
    SELECT * FROM public.group_goals
    WHERE group_id = v_gm.group_id
      AND semana = v_semana
      AND tipo = p_tipo
      AND concluida = FALSE
    FOR UPDATE
  LOOP
    v_new_prog := LEAST(v_goal.meta, v_goal.progresso + GREATEST(1, COALESCE(p_quantidade, 1)));

    UPDATE public.group_goals
    SET progresso = v_new_prog,
        concluida = (v_new_prog >= v_goal.meta),
        updated_at = NOW()
    WHERE id = v_goal.id;

    -- Se acabou de atingir a meta, premia todos os membros do grupo com moedas e avisa no chat
    IF v_new_prog >= v_goal.meta AND NOT v_goal.concluida THEN
      FOR v_member IN SELECT user_id FROM public.group_members WHERE group_id = v_gm.group_id LOOP
        UPDATE public.profiles
        SET moedas = moedas + v_goal.recompensa_moedas
        WHERE id = v_member.user_id;

        INSERT INTO public.notifications (user_id, tipo, titulo, mensagem, payload)
        VALUES (
          v_member.user_id,
          'group_goal',
          'META DO ESQUADRÃO CONCLUÍDA!',
          format('Meta "%s" atingida! Recompensa coletiva: +%s moedas.', v_goal.titulo, v_goal.recompensa_moedas),
          jsonb_build_object('group_id', v_gm.group_id, 'goal_id', v_goal.id, 'moedas', v_goal.recompensa_moedas)
        );
      END LOOP;

      SELECT id INTO v_conv_id FROM public.conversations WHERE group_id = v_gm.group_id;
      IF v_conv_id IS NOT NULL THEN
        INSERT INTO public.messages (conversation_id, sender_id, content, is_system)
        VALUES (
          v_conv_id,
          p_user_id,
          format('🏆 META SEMANAL CONCLUÍDA: "%s"! Todos os integrantes receberam +%s 🪙 Moedas Cyber!', v_goal.titulo, v_goal.recompensa_moedas),
          TRUE
        );
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- Trigger em `task_logs` para alimentar `contribuir_meta_grupo` ao concluir missão
CREATE OR REPLACE FUNCTION public.trg_fn_task_log_group_contribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.contribuir_meta_grupo(NEW.user_id, 'missoes', 1, COALESCE(NEW.xp_ganho, 0));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_task_logs_group_goal ON public.task_logs;
CREATE TRIGGER trg_task_logs_group_goal
  AFTER INSERT ON public.task_logs
  FOR EACH ROW EXECUTE FUNCTION public.trg_fn_task_log_group_contribution();

-- Trigger em `game_runs` para alimentar `contribuir_meta_grupo` e avisar no chat do grupo ao derrotar Boss
CREATE OR REPLACE FUNCTION public.trg_fn_game_run_group_contribution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gm RECORD;
  v_conv_id UUID;
  v_username TEXT;
BEGIN
  IF NEW.boss_vencido THEN
    PERFORM public.contribuir_meta_grupo(NEW.user_id, 'bosses', 1, COALESCE(NEW.xp_ganho, 0));

    SELECT * INTO v_gm FROM public.group_members WHERE user_id = NEW.user_id;
    IF FOUND THEN
      SELECT id INTO v_conv_id FROM public.conversations WHERE group_id = v_gm.group_id;
      SELECT username INTO v_username FROM public.profiles WHERE id = NEW.user_id;
      IF v_conv_id IS NOT NULL THEN
        INSERT INTO public.messages (conversation_id, sender_id, content, is_system)
        VALUES (
          v_conv_id,
          NEW.user_id,
          format('🤖 O agente @%s derrotou um Mecha-Boss na Cidade (%sm percorridos)!', COALESCE(v_username, 'agente'), NEW.distancia),
          TRUE
        );
      END IF;
    END IF;
  ELSIF COALESCE(NEW.xp_ganho, 0) > 0 THEN
    PERFORM public.contribuir_meta_grupo(NEW.user_id, 'xp', NEW.xp_ganho, NEW.xp_ganho);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_game_runs_group_goal ON public.game_runs;
CREATE TRIGGER trg_game_runs_group_goal
  AFTER INSERT ON public.game_runs
  FOR EACH ROW EXECUTE FUNCTION public.trg_fn_game_run_group_contribution();

-- Trigger em `profiles` quando um agente sobe de nível: avisa no chat do grupo e notifica amigos
CREATE OR REPLACE FUNCTION public.trg_fn_profile_levelup_social()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_gm RECORD;
  v_conv_id UUID;
  v_friend_id UUID;
BEGIN
  IF NEW.level > OLD.level THEN
    -- Mensagem de sistema no chat do grupo
    SELECT * INTO v_gm FROM public.group_members WHERE user_id = NEW.id;
    IF FOUND THEN
      SELECT id INTO v_conv_id FROM public.conversations WHERE group_id = v_gm.group_id;
      IF v_conv_id IS NOT NULL THEN
        INSERT INTO public.messages (conversation_id, sender_id, content, is_system)
        VALUES (
          v_conv_id,
          NEW.id,
          format('⚡ LEVEL UP! O agente @%s alcançou o NÍVEL %s!', COALESCE(NEW.username, 'agente'), NEW.level),
          TRUE
        );
      END IF;
    END IF;

    -- Notifica amigos aceitos
    FOR v_friend_id IN
      SELECT CASE WHEN requester_id = NEW.id THEN addressee_id ELSE requester_id END
      FROM public.friendships
      WHERE status = 'accepted' AND (requester_id = NEW.id OR addressee_id = NEW.id)
    LOOP
      INSERT INTO public.notifications (user_id, tipo, titulo, mensagem, payload)
      VALUES (
        v_friend_id,
        'friend_levelup',
        'ALIADO SUBIU DE NÍVEL!',
        format('Seu amigo @%s subiu para o Nível %s!', COALESCE(NEW.username, 'agente'), NEW.level),
        jsonb_build_object('friend_id', NEW.id, 'username', NEW.username, 'new_level', NEW.level)
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_levelup_social ON public.profiles;
CREATE TRIGGER trg_profile_levelup_social
  AFTER UPDATE OF level ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.trg_fn_profile_levelup_social();

-- -----------------------------------------------------------------------------
-- 4. SALAS MULTIPLAYER COOPERATIVO (`criar_sala`, `entrar_sala`, `iniciar_sala`, `finalizar_partida_coop`)
-- -----------------------------------------------------------------------------

-- RPC: Criar sala cooperativa (max_players entre 2 e 4)
CREATE OR REPLACE FUNCTION public.criar_sala(p_max_players INTEGER DEFAULT 4)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_max INTEGER := GREATEST(2, LEAST(COALESCE(p_max_players, 4), 4));
  v_code TEXT;
  v_seed INTEGER := floor(100000 + random() * 900000000)::INTEGER;
  v_room RECORD;
  v_prof RECORD;
  v_char RECORD;
  v_snap JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO: Faça login para criar uma sala.';
  END IF;

  -- Fecha eventuais salas antigas em espera do mesmo host
  UPDATE public.game_rooms
  SET status = 'abandoned', updated_at = NOW()
  WHERE host_id = v_uid AND status = 'waiting';

  -- Gera código curto único de 6 caracteres
  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  SELECT id, username, level, moldura_equipada INTO v_prof FROM public.profiles WHERE id = v_uid;
  SELECT * INTO v_char FROM public.characters WHERE user_id = v_uid;

  v_snap := jsonb_build_object(
    'username', v_prof.username,
    'level', v_prof.level,
    'moldura', v_prof.moldura_equipada,
    'nome', COALESCE(v_char.nome, v_prof.username, 'Agente'),
    'genero', COALESCE(v_char.genero, 'f'),
    'pele', COALESCE(v_char.cor_pele, 1),
    'cabelo', COALESCE(v_char.cabelo, 'longo'),
    'corCabelo', COALESCE(v_char.cor_cabelo, 1),
    'roupa', COALESCE(v_char.roupa, 'viajante'),
    'corRoupa', COALESCE(v_char.cor_roupa, 0),
    'classe', COALESCE(v_char.classe, 'guerreiro'),
    'arma', COALESCE(v_char.arma, 'espada_longa')
  );

  INSERT INTO public.game_rooms (code, host_id, seed, status, max_players)
  VALUES (v_code, v_uid, v_seed, 'waiting', v_max)
  RETURNING * INTO v_room;

  INSERT INTO public.game_room_players (room_id, user_id, is_ready, character_snapshot)
  VALUES (v_room.id, v_uid, TRUE, v_snap);

  RETURN jsonb_build_object(
    'room', row_to_json(v_room),
    'players', (
      SELECT COALESCE(jsonb_agg(row_to_json(grp)), '[]'::jsonb)
      FROM public.game_room_players grp
      WHERE grp.room_id = v_room.id
    )
  );
END;
$$;

-- RPC: Entrar em uma sala pelo código
CREATE OR REPLACE FUNCTION public.entrar_sala(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_clean_code TEXT := upper(trim(COALESCE(p_code, '')));
  v_room RECORD;
  v_count INTEGER;
  v_prof RECORD;
  v_char RECORD;
  v_snap JSONB;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  SELECT * INTO v_room
  FROM public.game_rooms
  WHERE upper(code) = v_clean_code
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALA_NAO_ENCONTRADA: Nenhuma sala localizada com o código %.', v_clean_code;
  END IF;

  IF v_room.status <> 'waiting' THEN
    -- Permite reconexão se o jogador já estava registrado na sala em andamento
    IF v_room.status = 'playing' AND EXISTS (
      SELECT 1 FROM public.game_room_players WHERE room_id = v_room.id AND user_id = v_uid
    ) THEN
      RETURN jsonb_build_object(
        'room', row_to_json(v_room),
        'reconnected', TRUE,
        'players', (
          SELECT COALESCE(jsonb_agg(row_to_json(grp)), '[]'::jsonb)
          FROM public.game_room_players grp
          WHERE grp.room_id = v_room.id
        )
      );
    END IF;
    RAISE EXCEPTION 'SALA_INDISPONIVEL: Esta missão cooperativa já foi iniciada ou encerrada.';
  END IF;

  IF public.is_blocked_between(v_uid, v_room.host_id) THEN
    RAISE EXCEPTION 'USUARIO_BLOQUEADO: Você não pode entrar na sala deste host.';
  END IF;

  SELECT COUNT(*) INTO v_count
  FROM public.game_room_players
  WHERE room_id = v_room.id AND user_id <> v_uid;

  IF v_count >= v_room.max_players THEN
    RAISE EXCEPTION 'SALA_LOTADA: A sala já atingiu o limite de % jogadores.', v_room.max_players;
  END IF;

  SELECT id, username, level, moldura_equipada INTO v_prof FROM public.profiles WHERE id = v_uid;
  SELECT * INTO v_char FROM public.characters WHERE user_id = v_uid;

  v_snap := jsonb_build_object(
    'username', v_prof.username,
    'level', v_prof.level,
    'moldura', v_prof.moldura_equipada,
    'nome', COALESCE(v_char.nome, v_prof.username, 'Agente'),
    'genero', COALESCE(v_char.genero, 'f'),
    'pele', COALESCE(v_char.cor_pele, 1),
    'cabelo', COALESCE(v_char.cabelo, 'longo'),
    'corCabelo', COALESCE(v_char.cor_cabelo, 1),
    'roupa', COALESCE(v_char.roupa, 'viajante'),
    'corRoupa', COALESCE(v_char.cor_roupa, 0),
    'classe', COALESCE(v_char.classe, 'guerreiro'),
    'arma', COALESCE(v_char.arma, 'espada_longa')
  );

  INSERT INTO public.game_room_players (room_id, user_id, is_ready, character_snapshot)
  VALUES (v_room.id, v_uid, TRUE, v_snap)
  ON CONFLICT (room_id, user_id)
  DO UPDATE SET is_ready = TRUE, character_snapshot = EXCLUDED.character_snapshot;

  RETURN jsonb_build_object(
    'room', row_to_json(v_room),
    'reconnected', FALSE,
    'players', (
      SELECT COALESCE(jsonb_agg(row_to_json(grp)), '[]'::jsonb)
      FROM public.game_room_players grp
      WHERE grp.room_id = v_room.id
    )
  );
END;
$$;

-- RPC: Iniciar Sala Cooperativa (somente o host; gera seed oficial e marca started_at)
CREATE OR REPLACE FUNCTION public.iniciar_sala(p_room_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_room RECORD;
  v_new_seed INTEGER := floor(100000 + random() * 900000000)::INTEGER;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  SELECT * INTO v_room
  FROM public.game_rooms
  WHERE id = p_room_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALA_NAO_ENCONTRADA';
  END IF;

  IF v_room.host_id <> v_uid THEN
    RAISE EXCEPTION 'APENAS_HOST_INICIA: Somente o líder da sala (host) pode iniciar a missão.';
  END IF;

  IF v_room.status <> 'waiting' THEN
    RAISE EXCEPTION 'SALA_JA_INICIADA: A sala não está mais em espera.';
  END IF;

  UPDATE public.game_rooms
  SET status = 'playing',
      seed = v_new_seed,
      started_at = NOW(),
      updated_at = NOW()
  WHERE id = p_room_id
  RETURNING * INTO v_room;

  RETURN jsonb_build_object(
    'room', row_to_json(v_room),
    'seed', v_new_seed,
    'players', (
      SELECT COALESCE(jsonb_agg(row_to_json(grp)), '[]'::jsonb)
      FROM public.game_room_players grp
      WHERE grp.room_id = v_room.id
    )
  );
END;
$$;

-- RPC: Finalizar Partida Cooperativa com Validações Anti-Trapaça (tempo mínimo, limites de XP diário)
CREATE OR REPLACE FUNCTION public.finalizar_partida_coop(
  p_room_id UUID,
  p_resultados JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_room RECORD;
  v_prof RECORD;
  v_elapsed_sec INTEGER;
  v_dist INTEGER;
  v_kills INTEGER;
  v_boss BOOLEAN;
  v_sem_dano BOOLEAN;
  v_coins INTEGER;
  v_dur INTEGER;
  v_raw_xp INTEGER;
  v_daily_cap INTEGER;
  v_xp_hoje INTEGER;
  v_rem_xp INTEGER;
  v_xp_concedido INTEGER;
  v_new_xp_atual INTEGER;
  v_new_xp_total INTEGER;
  v_new_level INTEGER;
  v_levels_gained INTEGER := 0;
  v_today DATE := CURRENT_DATE;
  v_run RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  SELECT * INTO v_room
  FROM public.game_rooms
  WHERE id = p_room_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SALA_NAO_ENCONTRADA';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.game_room_players
    WHERE room_id = p_room_id AND user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'NAO_MEMBRO_SALA: Você não participou desta sala cooperativa.';
  END IF;

  -- Evita submissão duplicada do mesmo jogador na mesma sala
  IF EXISTS (
    SELECT 1 FROM public.game_room_players
    WHERE room_id = p_room_id AND user_id = v_uid AND resultado IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'RESULTADO_JA_REGISTRADO: Seu resultado nesta missão cooperativa já foi contabilizado.';
  END IF;

  -- Anti-trapaça 1: Tempo mínimo decorrido desde started_at
  v_elapsed_sec := GREATEST(1, EXTRACT(EPOCH FROM (NOW() - COALESCE(v_room.started_at, v_room.created_at)))::INTEGER);
  v_dur := GREATEST(1, LEAST(COALESCE((p_resultados->>'duracao')::INTEGER, v_elapsed_sec), 7200));
  v_boss := COALESCE((p_resultados->>'boss_vencido')::BOOLEAN, FALSE);

  -- Se alegar que derrotou o Boss em menos de 10 segundos reais de sala, rejeita por anti-cheat
  IF v_boss AND v_elapsed_sec < 10 AND v_dur < 10 THEN
    RAISE EXCEPTION 'ANTI_CHEAT_TEMPO_MINIMO: Tempo de missão incompatível com vitória contra o Boss.';
  END IF;

  -- Anti-trapaça 2: Teto físico para distância, abates e moedas
  v_dist := GREATEST(0, LEAST(COALESCE((p_resultados->>'distancia')::INTEGER, 0), 5000));
  v_kills := GREATEST(0, LEAST(COALESCE((p_resultados->>'inimigos_derrotados')::INTEGER, 0), 250));
  v_sem_dano := COALESCE((p_resultados->>'sem_dano')::BOOLEAN, FALSE);
  v_coins := GREATEST(0, LEAST(COALESCE((p_resultados->>'moedas_coletadas')::INTEGER, 0), 600));

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_uid FOR UPDATE;

  -- Bônus cooperativo de +15% de XP bruto
  v_raw_xp := ROUND(((v_kills * 6) + (LEAST(8, FLOOR(v_dist / 45.0)::INTEGER) * 8) + (CASE WHEN v_boss THEN 55 ELSE 0 END)) * 1.15)::INTEGER;

  -- Anti-trapaça 3: Teto diário de XP de combate (30% do nível atual, mínimo 30)
  v_daily_cap := GREATEST(30, ROUND(public.calc_xp_to_next(v_prof.level) * 0.30)::INTEGER);
  v_xp_hoje := CASE WHEN v_prof.data_xp_jogo = v_today THEN v_prof.xp_jogo_hoje ELSE 0 END;
  v_rem_xp := GREATEST(0, v_daily_cap - v_xp_hoje);
  v_xp_concedido := LEAST(v_rem_xp, v_raw_xp);

  -- Registra em `game_runs` (dispara automaticamente trigger de metas do grupo)
  INSERT INTO public.game_runs (
    user_id, distancia, inimigos_derrotados, boss_vencido,
    sem_dano, xp_ganho, moedas_ganhas, duracao
  ) VALUES (
    v_uid, v_dist, v_kills, v_boss,
    v_sem_dano, v_xp_concedido, v_coins, v_dur
  )
  RETURNING * INTO v_run;

  -- Atualiza perfil
  v_new_xp_atual := v_prof.xp_nivel_atual + v_xp_concedido;
  v_new_xp_total := v_prof.xp_total + v_xp_concedido;
  v_new_level := v_prof.level;

  WHILE v_new_xp_atual >= public.calc_xp_to_next(v_new_level) LOOP
    v_new_xp_atual := v_new_xp_atual - public.calc_xp_to_next(v_new_level);
    v_new_level := v_new_level + 1;
    v_levels_gained := v_levels_gained + 1;
  END LOOP;

  UPDATE public.profiles
  SET level = v_new_level,
      xp_total = v_new_xp_total,
      xp_nivel_atual = v_new_xp_atual,
      moedas = moedas + v_coins,
      xp_jogo_hoje = v_xp_hoje + v_xp_concedido,
      data_xp_jogo = v_today
  WHERE id = v_uid
  RETURNING * INTO v_prof;

  -- Salva resultado individual em `game_room_players`
  UPDATE public.game_room_players
  SET resultado = jsonb_build_object(
    'distancia', v_dist,
    'inimigos_derrotados', v_kills,
    'boss_vencido', v_boss,
    'xp_ganho', v_xp_concedido,
    'moedas_ganhas', v_coins,
    'finished_at', NOW()
  )
  WHERE room_id = p_room_id AND user_id = v_uid;

  -- Se o host finalizou ou todos finalizaram, marca a sala como finished
  IF v_room.host_id = v_uid OR NOT EXISTS (
    SELECT 1 FROM public.game_room_players WHERE room_id = p_room_id AND resultado IS NULL
  ) THEN
    UPDATE public.game_rooms
    SET status = 'finished', finished_at = NOW(), updated_at = NOW()
    WHERE id = p_room_id;
  END IF;

  RETURN jsonb_build_object(
    'run', row_to_json(v_run),
    'profile', row_to_json(v_prof),
    'xp_ganho', v_xp_concedido,
    'moedas_ganhas', v_coins,
    'levels_gained', v_levels_gained
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. RANKINGS (`obter_ranking` E `minha_posicao`)
-- -----------------------------------------------------------------------------

-- RPC: Obter ranking paginado por categoria e período
CREATE OR REPLACE FUNCTION public.obter_ranking(
  p_categoria TEXT DEFAULT 'xp',
  p_periodo TEXT DEFAULT 'all',
  p_limite INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_lim INTEGER := GREATEST(1, LEAST(COALESCE(p_limite, 20), 100));
  v_off INTEGER := GREATEST(0, COALESCE(p_offset, 0));
  v_rows JSONB := '[]'::JSONB;
  v_season RECORD;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  SELECT * INTO v_season
  FROM public.seasons
  WHERE period = (CASE WHEN p_periodo = 'monthly' THEN 'monthly' ELSE 'weekly' END)
    AND status = 'active'
  ORDER BY starts_at DESC
  LIMIT 1;

  IF p_categoria = 'xp' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM public.v_rank_xp ORDER BY posicao ASC LIMIT v_lim OFFSET v_off) r;
  ELSIF p_categoria = 'streak' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM public.v_rank_streak ORDER BY posicao ASC LIMIT v_lim OFFSET v_off) r;
  ELSIF p_categoria = 'missions_week' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM public.v_rank_missions_week ORDER BY posicao ASC LIMIT v_lim OFFSET v_off) r;
  ELSIF p_categoria = 'distance' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM public.v_rank_distance ORDER BY posicao ASC LIMIT v_lim OFFSET v_off) r;
  ELSIF p_categoria = 'bosses' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM public.v_rank_bosses ORDER BY posicao ASC LIMIT v_lim OFFSET v_off) r;
  ELSIF p_categoria = 'groups' THEN
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb) INTO v_rows
    FROM (SELECT * FROM public.v_rank_groups ORDER BY posicao ASC LIMIT v_lim OFFSET v_off) r;
  ELSE
    RAISE EXCEPTION 'CATEGORIA_RANKING_INVALIDA: Use xp, streak, missions_week, distance, bosses ou groups.';
  END IF;

  RETURN jsonb_build_object(
    'categoria', p_categoria,
    'periodo', p_periodo,
    'season', CASE WHEN v_season.id IS NOT NULL THEN row_to_json(v_season)::jsonb ELSE NULL END,
    'items', v_rows
  );
END;
$$;

-- RPC: Minha posição atual no ranking selecionado
CREATE OR REPLACE FUNCTION public.minha_posicao(
  p_categoria TEXT DEFAULT 'xp',
  p_periodo TEXT DEFAULT 'all'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_res JSONB := NULL;
  v_my_group_id UUID;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  IF p_categoria = 'xp' THEN
    SELECT row_to_json(r)::jsonb INTO v_res FROM public.v_rank_xp r WHERE r.user_id = v_uid;
  ELSIF p_categoria = 'streak' THEN
    SELECT row_to_json(r)::jsonb INTO v_res FROM public.v_rank_streak r WHERE r.user_id = v_uid;
  ELSIF p_categoria = 'missions_week' THEN
    SELECT row_to_json(r)::jsonb INTO v_res FROM public.v_rank_missions_week r WHERE r.user_id = v_uid;
  ELSIF p_categoria = 'distance' THEN
    SELECT row_to_json(r)::jsonb INTO v_res FROM public.v_rank_distance r WHERE r.user_id = v_uid;
  ELSIF p_categoria = 'bosses' THEN
    SELECT row_to_json(r)::jsonb INTO v_res FROM public.v_rank_bosses r WHERE r.user_id = v_uid;
  ELSIF p_categoria = 'groups' THEN
    SELECT group_id INTO v_my_group_id FROM public.group_members WHERE user_id = v_uid;
    IF v_my_group_id IS NOT NULL THEN
      SELECT row_to_json(r)::jsonb INTO v_res FROM public.v_rank_groups r WHERE r.group_id = v_my_group_id;
    END IF;
  END IF;

  RETURN COALESCE(v_res, jsonb_build_object('posicao', NULL, 'valor', 0));
END;
$$;
