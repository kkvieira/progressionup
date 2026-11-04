-- =============================================================================
-- MIGRAÇÃO 003: ROW LEVEL SECURITY (RLS) E FUNÇÕES AUXILIARES DE AUTORIZAÇÃO
-- =============================================================================
-- Inclui:
-- 1. Funções auxiliares SECURITY DEFINER com search_path fixo:
--    - is_moderator(p_user_id)
--    - is_blocked_between(p_user_a, p_user_b)
--    - are_friends(p_user_a, p_user_b)
--    - is_member(p_conversation_id)
--    - has_group_role(p_group_id, p_roles[])
--    - is_room_member(p_room_id)
-- 2. ENABLE ROW LEVEL SECURITY em TODAS as tabelas sociais e multiplayer
-- 3. Policies explícitas:
--    - friendships: só os dois envolvidos leem; só o destinatário aceita; ambos removem;
--      bloqueios impedem criação/aceite.
--    - messages: SELECT e INSERT somente para membros da conversa (via is_member);
--      sem UPDATE ou DELETE do cliente, exceto moderadores; bloqueio impede DM.
--    - blocks: usuário lê e gerencia seus próprios bloqueios.
--    - groups, group_members, group_invites, group_goals: leitura pública do básico;
--      edição só para líder/oficial conforme cargo via has_group_role; bloqueios impedem convites.
--    - profiles & characters: dono lê tudo; terceiros acessam os dados públicos via
--      view `public_profiles` ou policies que respeitam privacidade (público, amigos, privado).
--      E-mail (em auth.users) e dados do diário (task_logs) permanecem inacessíveis a terceiros.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. FUNÇÕES AUXILIARES DE SEGURANÇA (SECURITY DEFINER + search_path = public)
-- -----------------------------------------------------------------------------

-- 1.1 Verifica se o usuário possui papel de moderador ou administrador
CREATE OR REPLACE FUNCTION public.is_moderator(p_user_id UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = COALESCE(p_user_id, auth.uid())
      AND ur.role IN ('moderator', 'admin')
  );
$$;

-- 1.2 Verifica se existe bloqueio em QUALQUER direção entre dois usuários
CREATE OR REPLACE FUNCTION public.is_blocked_between(p_user_a UUID, p_user_b UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_user_a IS NULL OR p_user_b IS NULL THEN FALSE
    ELSE EXISTS (
      SELECT 1 FROM public.blocks b
      WHERE (b.blocker_id = p_user_a AND b.blocked_id = p_user_b)
         OR (b.blocker_id = p_user_b AND b.blocked_id = p_user_a)
    ) OR EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'blocked'
        AND (
          (f.requester_id = p_user_a AND f.addressee_id = p_user_b)
          OR (f.requester_id = p_user_b AND f.addressee_id = p_user_a)
        )
    )
  END;
$$;

-- 1.3 Verifica se dois usuários são amigos aceitos (e sem bloqueio)
CREATE OR REPLACE FUNCTION public.are_friends(p_user_a UUID, p_user_b UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_user_a IS NULL OR p_user_b IS NULL THEN FALSE
    WHEN public.is_blocked_between(p_user_a, p_user_b) THEN FALSE
    ELSE EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'accepted'
        AND (
          (f.requester_id = p_user_a AND f.addressee_id = p_user_b)
          OR (f.requester_id = p_user_b AND f.addressee_id = p_user_a)
        )
    )
  END;
$$;

-- 1.4 Verifica se o usuário autenticado é membro da conversa (ou se é o chat global)
-- Também valida que, em conversas DM, não haja bloqueio entre os 2 membros
CREATE OR REPLACE FUNCTION public.is_member(p_conversation_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_conv RECORD;
  v_other_id UUID;
BEGIN
  IF v_uid IS NULL OR p_conversation_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT id, tipo, group_id INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Canal global é acessível a todos os agentes autenticados
  IF v_conv.tipo = 'global' THEN
    RETURN TRUE;
  END IF;

  -- Canal de grupo: verifica se é membro do grupo ou de conversation_members
  IF v_conv.tipo = 'group' THEN
    RETURN EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = v_conv.group_id AND gm.user_id = v_uid
    ) OR EXISTS (
      SELECT 1 FROM public.conversation_members cm
      WHERE cm.conversation_id = p_conversation_id AND cm.user_id = v_uid
    );
  END IF;

  -- Canal DM: precisa ser membro E não ter bloqueio com o outro participante
  IF NOT EXISTS (
    SELECT 1 FROM public.conversation_members cm
    WHERE cm.conversation_id = p_conversation_id AND cm.user_id = v_uid
  ) THEN
    RETURN FALSE;
  END IF;

  SELECT cm.user_id INTO v_other_id
  FROM public.conversation_members cm
  WHERE cm.conversation_id = p_conversation_id
    AND cm.user_id <> v_uid
  LIMIT 1;

  IF v_other_id IS NOT NULL AND public.is_blocked_between(v_uid, v_other_id) THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
END;
$$;

-- 1.5 Verifica se o usuário autenticado possui determinado cargo no grupo
-- Se `p_required_role` for 'member', aceita ('member', 'officer', 'leader').
-- Se for 'officer', aceita ('officer', 'leader').
-- Se for 'leader', aceita apenas ('leader').
CREATE OR REPLACE FUNCTION public.has_group_role(p_group_id UUID, p_required_role TEXT DEFAULT 'member')
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members gm
    WHERE gm.group_id = p_group_id
      AND gm.user_id = auth.uid()
      AND (
        (p_required_role = 'member'  AND gm.role IN ('member', 'officer', 'leader'))
        OR (p_required_role = 'officer' AND gm.role IN ('officer', 'leader'))
        OR (p_required_role = 'leader'  AND gm.role = 'leader')
      )
  );
$$;

-- 1.6 Verifica se o usuário autenticado participa de uma sala cooperativa
CREATE OR REPLACE FUNCTION public.is_room_member(p_room_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.game_room_players grp
    WHERE grp.room_id = p_room_id
      AND grp.user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1
    FROM public.game_rooms gr
    WHERE gr.id = p_room_id
      AND gr.host_id = auth.uid()
  );
$$;

-- -----------------------------------------------------------------------------
-- 2. HABILITAR ROW LEVEL SECURITY EM TODAS AS TABELAS
-- -----------------------------------------------------------------------------
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_room_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3. POLICIES PARA `profiles` E `characters` (Privacidade Pública / Amigos / Privado)
-- -----------------------------------------------------------------------------
-- Nota: `profiles` nunca contém e-mail (que fica em `auth.users`), e `task_logs`
-- (dados do diário) mantém policy restrita apenas ao próprio dono (`auth.uid() = user_id`).
DROP POLICY IF EXISTS "profiles_select_privacy" ON public.profiles;
CREATE POLICY "profiles_select_privacy" ON public.profiles
  FOR SELECT TO authenticated
  USING (
    auth.uid() = id
    OR (
      NOT public.is_blocked_between(auth.uid(), id)
      AND (
        privacy = 'publico'
        OR (privacy = 'amigos' AND public.are_friends(auth.uid(), id))
      )
    )
    OR public.is_moderator()
  );

DROP POLICY IF EXISTS "characters_select_privacy" ON public.characters;
CREATE POLICY "characters_select_privacy" ON public.characters
  FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = public.characters.user_id
        AND NOT public.is_blocked_between(auth.uid(), p.id)
        AND (
          p.privacy = 'publico'
          OR (p.privacy = 'amigos' AND public.are_friends(auth.uid(), p.id))
        )
    )
  );

-- -----------------------------------------------------------------------------
-- 4. POLICIES PARA `user_roles`
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "user_roles_select_own_or_mod" ON public.user_roles;
CREATE POLICY "user_roles_select_own_or_mod" ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_moderator());

-- -----------------------------------------------------------------------------
-- 5. POLICIES PARA `blocks`
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "blocks_select_involved" ON public.blocks;
CREATE POLICY "blocks_select_involved" ON public.blocks
  FOR SELECT TO authenticated
  USING (blocker_id = auth.uid() OR blocked_id = auth.uid());

DROP POLICY IF EXISTS "blocks_insert_own" ON public.blocks;
CREATE POLICY "blocks_insert_own" ON public.blocks
  FOR INSERT TO authenticated
  WITH CHECK (blocker_id = auth.uid() AND blocker_id <> blocked_id);

DROP POLICY IF EXISTS "blocks_delete_own" ON public.blocks;
CREATE POLICY "blocks_delete_own" ON public.blocks
  FOR DELETE TO authenticated
  USING (blocker_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 6. POLICIES PARA `friendships`
--    - Só os dois envolvidos leem
--    - Só o remetente insere (e desde que não haja bloqueio em nenhuma direção)
--    - Só o destinatário (addressee_id) aceita o pedido
--    - Ambos podem remover (DELETE)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "friendships_select_involved" ON public.friendships;
CREATE POLICY "friendships_select_involved" ON public.friendships
  FOR SELECT TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid());

DROP POLICY IF EXISTS "friendships_insert_requester" ON public.friendships;
CREATE POLICY "friendships_insert_requester" ON public.friendships
  FOR INSERT TO authenticated
  WITH CHECK (
    requester_id = auth.uid()
    AND requester_id <> addressee_id
    AND status = 'pending'
    AND NOT public.is_blocked_between(requester_id, addressee_id)
  );

DROP POLICY IF EXISTS "friendships_update_addressee_only" ON public.friendships;
CREATE POLICY "friendships_update_addressee_only" ON public.friendships
  FOR UPDATE TO authenticated
  USING (
    addressee_id = auth.uid()
    AND status = 'pending'
    AND NOT public.is_blocked_between(requester_id, addressee_id)
  )
  WITH CHECK (
    addressee_id = auth.uid()
    AND status IN ('accepted', 'blocked')
    AND NOT public.is_blocked_between(requester_id, addressee_id)
  );

DROP POLICY IF EXISTS "friendships_delete_both" ON public.friendships;
CREATE POLICY "friendships_delete_both" ON public.friendships
  FOR DELETE TO authenticated
  USING (requester_id = auth.uid() OR addressee_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 7. POLICIES PARA `conversations`, `conversation_members`, `messages` E `message_reads`
--    - messages: SELECT e INSERT somente para membros da conversa (via is_member);
--      sem UPDATE ou DELETE do cliente, exceto moderadores; bloqueio impede DM.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "conversations_select_member_or_global" ON public.conversations;
CREATE POLICY "conversations_select_member_or_global" ON public.conversations
  FOR SELECT TO authenticated
  USING (
    tipo = 'global'
    OR public.is_member(id)
    OR public.is_moderator()
  );

DROP POLICY IF EXISTS "conversation_members_select_member" ON public.conversation_members;
CREATE POLICY "conversation_members_select_member" ON public.conversation_members
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_member(conversation_id)
    OR public.is_moderator()
  );

DROP POLICY IF EXISTS "messages_select_member_or_mod" ON public.messages;
CREATE POLICY "messages_select_member_or_mod" ON public.messages
  FOR SELECT TO authenticated
  USING (
    public.is_member(conversation_id)
    OR public.is_moderator()
  );

DROP POLICY IF EXISTS "messages_insert_member_only" ON public.messages;
CREATE POLICY "messages_insert_member_only" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND is_system = FALSE
    AND char_length(trim(content)) BETWEEN 1 AND 500
    AND public.is_member(conversation_id)
  );

-- UPDATE e DELETE em `messages`: exclusivos para moderadores
DROP POLICY IF EXISTS "messages_update_moderator_only" ON public.messages;
CREATE POLICY "messages_update_moderator_only" ON public.messages
  FOR UPDATE TO authenticated
  USING (public.is_moderator())
  WITH CHECK (public.is_moderator());

DROP POLICY IF EXISTS "messages_delete_moderator_only" ON public.messages;
CREATE POLICY "messages_delete_moderator_only" ON public.messages
  FOR DELETE TO authenticated
  USING (public.is_moderator());

-- `message_reads`: cada usuário lê e atualiza apenas sua própria marcação de leitura
DROP POLICY IF EXISTS "message_reads_select_own" ON public.message_reads;
CREATE POLICY "message_reads_select_own" ON public.message_reads
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "message_reads_insert_own" ON public.message_reads;
CREATE POLICY "message_reads_insert_own" ON public.message_reads
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_member(conversation_id));

DROP POLICY IF EXISTS "message_reads_update_own" ON public.message_reads;
CREATE POLICY "message_reads_update_own" ON public.message_reads
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- -----------------------------------------------------------------------------
-- 8. POLICIES PARA `groups`, `group_members`, `group_invites`, `group_goals`
--    - Leitura pública do básico para autenticados
--    - Edição do grupo só para líder/oficial conforme cargo via has_group_role
--    - Bloqueios impedem envio de convites entre usuários bloqueados
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "groups_select_public" ON public.groups;
CREATE POLICY "groups_select_public" ON public.groups
  FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "groups_insert_authenticated" ON public.groups;
CREATE POLICY "groups_insert_authenticated" ON public.groups
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "groups_update_leader_or_officer" ON public.groups;
CREATE POLICY "groups_update_leader_or_officer" ON public.groups
  FOR UPDATE TO authenticated
  USING (public.has_group_role(id, 'officer'))
  WITH CHECK (public.has_group_role(id, 'officer'));

DROP POLICY IF EXISTS "groups_delete_leader_only" ON public.groups;
CREATE POLICY "groups_delete_leader_only" ON public.groups
  FOR DELETE TO authenticated
  USING (public.has_group_role(id, 'leader'));

-- `group_members`
DROP POLICY IF EXISTS "group_members_select_public" ON public.group_members;
CREATE POLICY "group_members_select_public" ON public.group_members
  FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "group_members_update_leader_or_officer" ON public.group_members;
CREATE POLICY "group_members_update_leader_or_officer" ON public.group_members
  FOR UPDATE TO authenticated
  USING (public.has_group_role(group_id, 'leader'))
  WITH CHECK (public.has_group_role(group_id, 'leader'));

DROP POLICY IF EXISTS "group_members_delete_self_or_officer" ON public.group_members;
CREATE POLICY "group_members_delete_self_or_officer" ON public.group_members
  FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR (
      public.has_group_role(group_id, 'officer')
      AND role <> 'leader'
    )
  );

-- `group_invites` (impede convites se houver bloqueio em qualquer direção)
DROP POLICY IF EXISTS "group_invites_select_involved" ON public.group_invites;
CREATE POLICY "group_invites_select_involved" ON public.group_invites
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR invited_by = auth.uid()
    OR public.has_group_role(group_id, 'officer')
  );

DROP POLICY IF EXISTS "group_invites_insert_no_block" ON public.group_invites;
CREATE POLICY "group_invites_insert_no_block" ON public.group_invites
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      -- Convite enviado por oficial/líder do grupo para um usuário que não o bloqueou
      direction = 'invite'
      AND invited_by = auth.uid()
      AND public.has_group_role(group_id, 'officer')
      AND NOT public.is_blocked_between(auth.uid(), user_id)
    )
    OR (
      -- Pedido de entrada (request) enviado pelo próprio usuário ao grupo
      direction = 'request'
      AND user_id = auth.uid()
      AND NOT EXISTS (
        SELECT 1 FROM public.groups g
        WHERE g.id = group_id
          AND public.is_blocked_between(auth.uid(), g.owner_id)
      )
    )
  );

DROP POLICY IF EXISTS "group_invites_update_involved" ON public.group_invites;
CREATE POLICY "group_invites_update_involved" ON public.group_invites
  FOR UPDATE TO authenticated
  USING (
    (direction = 'invite' AND user_id = auth.uid())
    OR (direction = 'request' AND public.has_group_role(group_id, 'officer'))
  )
  WITH CHECK (
    status IN ('accepted', 'declined')
  );

DROP POLICY IF EXISTS "group_invites_delete_involved" ON public.group_invites;
CREATE POLICY "group_invites_delete_involved" ON public.group_invites
  FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR invited_by = auth.uid()
    OR public.has_group_role(group_id, 'officer')
  );

-- `group_goals`
DROP POLICY IF EXISTS "group_goals_select_public" ON public.group_goals;
CREATE POLICY "group_goals_select_public" ON public.group_goals
  FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "group_goals_manage_officer" ON public.group_goals;
CREATE POLICY "group_goals_manage_officer" ON public.group_goals
  FOR ALL TO authenticated
  USING (public.has_group_role(group_id, 'officer'))
  WITH CHECK (public.has_group_role(group_id, 'officer'));

-- -----------------------------------------------------------------------------
-- 9. POLICIES PARA `seasons` E `season_results`
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "seasons_select_all" ON public.seasons;
CREATE POLICY "seasons_select_all" ON public.seasons
  FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "season_results_select_all" ON public.season_results;
CREATE POLICY "season_results_select_all" ON public.season_results
  FOR SELECT TO authenticated
  USING (TRUE);

-- -----------------------------------------------------------------------------
-- 10. POLICIES PARA `game_rooms` E `game_room_players`
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "game_rooms_select_authenticated" ON public.game_rooms;
CREATE POLICY "game_rooms_select_authenticated" ON public.game_rooms
  FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "game_rooms_insert_host" ON public.game_rooms;
CREATE POLICY "game_rooms_insert_host" ON public.game_rooms
  FOR INSERT TO authenticated
  WITH CHECK (host_id = auth.uid());

DROP POLICY IF EXISTS "game_rooms_update_host" ON public.game_rooms;
CREATE POLICY "game_rooms_update_host" ON public.game_rooms
  FOR UPDATE TO authenticated
  USING (host_id = auth.uid())
  WITH CHECK (host_id = auth.uid());

DROP POLICY IF EXISTS "game_rooms_delete_host" ON public.game_rooms;
CREATE POLICY "game_rooms_delete_host" ON public.game_rooms
  FOR DELETE TO authenticated
  USING (host_id = auth.uid());

DROP POLICY IF EXISTS "game_room_players_select_authenticated" ON public.game_room_players;
CREATE POLICY "game_room_players_select_authenticated" ON public.game_room_players
  FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "game_room_players_insert_self" ON public.game_room_players;
CREATE POLICY "game_room_players_insert_self" ON public.game_room_players
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "game_room_players_update_self" ON public.game_room_players;
CREATE POLICY "game_room_players_update_self" ON public.game_room_players
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "game_room_players_delete_self_or_host" ON public.game_room_players;
CREATE POLICY "game_room_players_delete_self_or_host" ON public.game_room_players
  FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.game_rooms gr
      WHERE gr.id = room_id AND gr.host_id = auth.uid()
    )
  );

-- -----------------------------------------------------------------------------
-- 11. POLICIES PARA `reports` E `notifications`
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "reports_insert_authenticated" ON public.reports;
CREATE POLICY "reports_insert_authenticated" ON public.reports
  FOR INSERT TO authenticated
  WITH CHECK (reporter_id = auth.uid());

DROP POLICY IF EXISTS "reports_select_own_or_mod" ON public.reports;
CREATE POLICY "reports_select_own_or_mod" ON public.reports
  FOR SELECT TO authenticated
  USING (reporter_id = auth.uid() OR public.is_moderator());

DROP POLICY IF EXISTS "reports_update_mod_only" ON public.reports;
CREATE POLICY "reports_update_mod_only" ON public.reports
  FOR UPDATE TO authenticated
  USING (public.is_moderator())
  WITH CHECK (public.is_moderator());

DROP POLICY IF EXISTS "notifications_select_own" ON public.notifications;
CREATE POLICY "notifications_select_own" ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications;
CREATE POLICY "notifications_update_own" ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "notifications_delete_own" ON public.notifications;
CREATE POLICY "notifications_delete_own" ON public.notifications
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());
