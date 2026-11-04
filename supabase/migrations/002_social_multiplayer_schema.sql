-- =============================================================================
-- MIGRAÇÃO 002: CAMADA SOCIAL E MULTIPLAYER — ESQUEMA, TABELAS, VIEWS E ÍNDICES
-- =============================================================================
-- Inclui:
-- 1. Evolução de `profiles` (privacy, moldura_equipada)
-- 2. Tabelas:
--    - user_roles (moderadores/admins)
--    - blocks (bloqueios diretos e sincronizados com friendships)
--    - friendships (requester_id, addressee_id, status: pending, accepted, blocked)
--      com constraint UNIQUE em par normalizado (LEAST, GREATEST) e CHECK (<>)
--    - groups (nome único, descrição, emblema, codigo, join_type, max_members = 30)
--    - group_members (role: leader, officer, member)
--    - group_invites (convites e solicitações de entrada)
--    - group_goals (meta, progresso, semana, tipo, concluida)
--    - conversations (tipo: dm, group, global)
--    - conversation_members (conversation_id, user_id, role)
--    - messages (conversation_id, sender_id, content <= 500, is_system, flagged_for_review)
--      com índice em (conversation_id, created_at DESC)
--    - message_reads (user_id, conversation_id, last_read_at)
--    - seasons (period: weekly, monthly, starts_at, ends_at, status)
--    - season_results (posição, categoria, recompensa, xp_periodo, valor_metrica)
--    - game_rooms (code, host_id, seed, status, max_players, started_at)
--    - game_room_players (room_id, user_id, is_ready, character_snapshot, resultado)
--    - reports (denúncias de mensagens, perfis ou grupos)
--    - notifications (avisos em tempo real para o usuário)
-- 3. Views Públicas e de Ranking com RANK() OVER (...) e índices de apoio:
--    - public_profiles (respeita privacidade: publico, amigos, privado; sem e-mail/diário)
--    - v_rank_xp, v_rank_streak, v_rank_missions_week, v_rank_distance,
--      v_rank_bosses, v_rank_groups
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. EVOLUÇÃO DA TABELA `profiles` (Privacidade e Molduras de Temporada)
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS privacy TEXT NOT NULL DEFAULT 'publico'
    CHECK (privacy IN ('publico', 'amigos', 'privado')),
  ADD COLUMN IF NOT EXISTS moldura_equipada TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS molduras_desbloqueadas TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '' CHECK (char_length(bio) <= 160);

COMMENT ON COLUMN public.profiles.privacy IS 'Nível de visibilidade do perfil para terceiros: publico, amigos ou privado.';
COMMENT ON COLUMN public.profiles.moldura_equipada IS 'Moldura especial recebida em pódios de temporadas (seasons).';
COMMENT ON COLUMN public.profiles.molduras_desbloqueadas IS 'Lista de códigos de molduras conquistadas pelo agente.';

-- Índices de apoio em profiles para rankings e buscas por username
CREATE INDEX IF NOT EXISTS idx_profiles_xp_total_desc ON public.profiles (xp_total DESC, level DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_streak_desc ON public.profiles (streak_atual DESC, maior_streak DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_username_lower ON public.profiles (lower(username));

-- Índices de apoio em task_logs e game_runs para rankings semanais/gerais
CREATE INDEX IF NOT EXISTS idx_task_logs_data_user ON public.task_logs (data DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_game_runs_distancia_desc ON public.game_runs (distancia DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_game_runs_boss_user ON public.game_runs (boss_vencido, user_id) WHERE boss_vencido = TRUE;

-- -----------------------------------------------------------------------------
-- 2. TABELA: `user_roles` (Moderadores e Administradores)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('moderator', 'admin')),
  granted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_roles_user_role UNIQUE (user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user ON public.user_roles(user_id);
COMMENT ON TABLE public.user_roles IS 'Papéis especiais de moderação do Sistema de Missões (moderator, admin).';

-- -----------------------------------------------------------------------------
-- 3. TABELA: `blocks` (Bloqueios entre usuários)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reason TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_blocks_no_self CHECK (blocker_id <> blocked_id),
  CONSTRAINT uq_blocks_pair UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON public.blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON public.blocks(blocked_id);
COMMENT ON TABLE public.blocks IS 'Registro de bloqueios entre agentes. Impede DMs, pedidos de amizade e convites em qualquer direção.';

-- -----------------------------------------------------------------------------
-- 4. TABELA: `friendships` (Amizades e Pedidos)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_friendships_no_self CHECK (requester_id <> addressee_id)
);

-- Constraint UNIQUE em par normalizado (menor UUID, maior UUID) para impedir duplicidade invertida
CREATE UNIQUE INDEX IF NOT EXISTS uq_friendships_normalized_pair
  ON public.friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

CREATE INDEX IF NOT EXISTS idx_friendships_requester ON public.friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee ON public.friendships(addressee_id, status);

DROP TRIGGER IF EXISTS trg_friendships_updated_at ON public.friendships;
CREATE TRIGGER trg_friendships_updated_at
  BEFORE UPDATE ON public.friendships
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.friendships IS 'Relações de amizade entre agentes (pending, accepted, blocked) com par único normalizado.';

-- -----------------------------------------------------------------------------
-- 5. TABELAS DE GRUPOS / CLÃS (`groups`, `group_members`, `group_invites`, `group_goals`)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome TEXT NOT NULL UNIQUE CHECK (char_length(trim(nome)) BETWEEN 3 AND 32),
  tag TEXT NOT NULL CHECK (char_length(trim(tag)) BETWEEN 2 AND 5),
  descricao TEXT NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 300),
  emblema TEXT NOT NULL DEFAULT 'shield_cyan',
  emblema_url TEXT DEFAULT NULL,
  codigo TEXT NOT NULL UNIQUE DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  join_type TEXT NOT NULL DEFAULT 'open' CHECK (join_type IN ('open', 'invite', 'request')),
  max_members INTEGER NOT NULL DEFAULT 30 CHECK (max_members BETWEEN 2 AND 30),
  owner_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  xp_total_grupo BIGINT NOT NULL DEFAULT 0 CHECK (xp_total_grupo >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_groups_join_type ON public.groups(join_type);
CREATE INDEX IF NOT EXISTS idx_groups_xp_desc ON public.groups(xp_total_grupo DESC);

DROP TRIGGER IF EXISTS trg_groups_updated_at ON public.groups;
CREATE TRIGGER trg_groups_updated_at
  BEFORE UPDATE ON public.groups
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.groups IS 'Clãs/Esquadrões de agentes (máx. 30 membros) com metas coletivas e chat próprio.';

CREATE TABLE IF NOT EXISTS public.group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('leader', 'officer', 'member')),
  xp_contribuido BIGINT NOT NULL DEFAULT 0 CHECK (xp_contribuido >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_group_members_group_user UNIQUE (group_id, user_id),
  -- Cada agente participa de 1 clã ativo por vez para simplificar hierarquia e metas
  CONSTRAINT uq_group_members_single_clan UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_group_members_group_role ON public.group_members(group_id, role);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON public.group_members(user_id);

DROP TRIGGER IF EXISTS trg_group_members_updated_at ON public.group_members;
CREATE TRIGGER trg_group_members_updated_at
  BEFORE UPDATE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.group_members IS 'Membros de cada grupo com cargos: leader, officer, member.';

CREATE TABLE IF NOT EXISTS public.group_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  invited_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  direction TEXT NOT NULL DEFAULT 'invite' CHECK (direction IN ('invite', 'request')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_group_invites_pending UNIQUE (group_id, user_id, direction)
);

CREATE INDEX IF NOT EXISTS idx_group_invites_user_status ON public.group_invites(user_id, status);
CREATE INDEX IF NOT EXISTS idx_group_invites_group_status ON public.group_invites(group_id, status);

DROP TRIGGER IF EXISTS trg_group_invites_updated_at ON public.group_invites;
CREATE TRIGGER trg_group_invites_updated_at
  BEFORE UPDATE ON public.group_invites
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.group_invites IS 'Convites enviados pelo grupo (invite) ou solicitações de entrada (request).';

CREATE TABLE IF NOT EXISTS public.group_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL DEFAULT 'Operação Semanal do Esquadrão',
  tipo TEXT NOT NULL DEFAULT 'missoes' CHECK (tipo IN ('missoes', 'bosses', 'xp')),
  meta INTEGER NOT NULL DEFAULT 50 CHECK (meta > 0),
  progresso INTEGER NOT NULL DEFAULT 0 CHECK (progresso >= 0),
  recompensa_moedas INTEGER NOT NULL DEFAULT 50 CHECK (recompensa_moedas >= 0),
  semana DATE NOT NULL DEFAULT date_trunc('week', CURRENT_DATE)::DATE,
  concluida BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_group_goals_semana_tipo UNIQUE (group_id, semana, tipo)
);

CREATE INDEX IF NOT EXISTS idx_group_goals_group_semana ON public.group_goals(group_id, semana DESC);

DROP TRIGGER IF EXISTS trg_group_goals_updated_at ON public.group_goals;
CREATE TRIGGER trg_group_goals_updated_at
  BEFORE UPDATE ON public.group_goals
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.group_goals IS 'Metas semanais coletivas dos grupos alimentadas automaticamente por triggers em task_logs e game_runs.';

-- -----------------------------------------------------------------------------
-- 6. TABELAS DE CHAT (`conversations`, `conversation_members`, `messages`, `message_reads`)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo TEXT NOT NULL CHECK (tipo IN ('dm', 'group', 'global')),
  group_id UUID UNIQUE REFERENCES public.groups(id) ON DELETE CASCADE,
  titulo TEXT DEFAULT NULL,
  dm_pair_key TEXT UNIQUE DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_tipo ON public.conversations(tipo);
CREATE INDEX IF NOT EXISTS idx_conversations_group ON public.conversations(group_id);

DROP TRIGGER IF EXISTS trg_conversations_updated_at ON public.conversations;
CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.conversations IS 'Canais de conversa: dm (direta entre 2 agentes), group (chat do clã) e global (canal geral).';

-- Garante que exista a conversa global padrão (UUID determinístico)
INSERT INTO public.conversations (id, tipo, titulo)
VALUES ('00000000-0000-0000-0000-000000000001', 'global', 'REDE GLOBAL DE AGENTES')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.conversation_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_conversation_members UNIQUE (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_members_user ON public.conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_conv_members_conv ON public.conversation_members(conversation_id);
COMMENT ON TABLE public.conversation_members IS 'Participantes autorizados de cada conversa (usado por RLS e Realtime Authorization).';

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  content TEXT NOT NULL CHECK (char_length(trim(content)) >= 1 AND char_length(content) <= 500),
  attachment_url TEXT DEFAULT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  flagged_for_review BOOLEAN NOT NULL DEFAULT FALSE,
  moderation_reason TEXT DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice obrigatório em (conversation_id, created_at DESC) para paginação por cursor e rate limit
CREATE INDEX IF NOT EXISTS idx_messages_conv_created_desc
  ON public.messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_sender_created_desc
  ON public.messages (sender_id, created_at DESC);

COMMENT ON TABLE public.messages IS 'Mensagens de chat (máx 500 caracteres) com suporte a anexos, mensagens de sistema e flag de moderação.';

CREATE TABLE IF NOT EXISTS public.message_reads (
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reads_user ON public.message_reads(user_id);
COMMENT ON TABLE public.message_reads IS 'Marcação de última leitura por conversa para contagem precisa de mensagens não lidas.';

-- -----------------------------------------------------------------------------
-- 7. TABELAS DE TEMPORADAS E RANKINGS (`seasons`, `season_results`)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period TEXT NOT NULL CHECK (period IN ('weekly', 'monthly')),
  titulo TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_seasons_dates CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_seasons_period_status ON public.seasons(period, status, starts_at DESC);
COMMENT ON TABLE public.seasons IS 'Temporadas competitivas semanais e mensais gerenciadas via pg_cron.';

CREATE TABLE IF NOT EXISTS public.season_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  categoria TEXT NOT NULL CHECK (categoria IN ('xp', 'streak', 'missions_week', 'distance', 'bosses', 'groups')),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  posicao INTEGER NOT NULL CHECK (posicao >= 1),
  valor_metrica BIGINT NOT NULL DEFAULT 0,
  recompensa JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_season_results_season_cat ON public.season_results(season_id, categoria, posicao);
CREATE INDEX IF NOT EXISTS idx_season_results_user ON public.season_results(user_id);
COMMENT ON TABLE public.season_results IS 'Histórico oficial de pódios e recompensas (moedas + molduras exclusivas) ao fechar temporadas.';

-- Garante uma season semanal e uma mensal ativas inicialmente
INSERT INTO public.seasons (period, titulo, starts_at, ends_at, status)
SELECT 'weekly',
       'OPERAÇÃO SEMANAL #' || to_char(NOW(), 'IYYY-IW'),
       date_trunc('week', NOW()),
       date_trunc('week', NOW()) + INTERVAL '7 days',
       'active'
WHERE NOT EXISTS (SELECT 1 FROM public.seasons WHERE period = 'weekly' AND status = 'active');

INSERT INTO public.seasons (period, titulo, starts_at, ends_at, status)
SELECT 'monthly',
       'TEMPORADA NEON ' || to_char(NOW(), 'YYYY-MM'),
       date_trunc('month', NOW()),
       date_trunc('month', NOW()) + INTERVAL '1 month',
       'active'
WHERE NOT EXISTS (SELECT 1 FROM public.seasons WHERE period = 'monthly' AND status = 'active');

-- -----------------------------------------------------------------------------
-- 8. TABELAS DE SALAS MULTIPLAYER COOPERATIVO (`game_rooms`, `game_room_players`)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.game_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 4 AND 10),
  host_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  seed INTEGER NOT NULL DEFAULT floor(random() * 2147483647)::INTEGER,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'playing', 'finished', 'abandoned')),
  max_players INTEGER NOT NULL DEFAULT 4 CHECK (max_players BETWEEN 2 AND 4),
  started_at TIMESTAMPTZ DEFAULT NULL,
  finished_at TIMESTAMPTZ DEFAULT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_rooms_status_created ON public.game_rooms(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_rooms_code ON public.game_rooms(code);

DROP TRIGGER IF EXISTS trg_game_rooms_updated_at ON public.game_rooms;
CREATE TRIGGER trg_game_rooms_updated_at
  BEFORE UPDATE ON public.game_rooms
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

COMMENT ON TABLE public.game_rooms IS 'Salas de jogo cooperativo na Cidade (Lobby + Seed determinística + Host authority).';

CREATE TABLE IF NOT EXISTS public.game_room_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.game_rooms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_ready BOOLEAN NOT NULL DEFAULT FALSE,
  character_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  resultado JSONB DEFAULT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_game_room_players UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_game_room_players_room ON public.game_room_players(room_id);
CREATE INDEX IF NOT EXISTS idx_game_room_players_user ON public.game_room_players(user_id);
COMMENT ON TABLE public.game_room_players IS 'Jogadores presentes em uma sala cooperativa e seus resultados individuais validados.';

-- -----------------------------------------------------------------------------
-- 9. TABELAS DE MODERAÇÃO E NOTIFICAÇÕES (`reports`, `notifications`)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reported_user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  group_id UUID REFERENCES public.groups(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 300),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'dismissed', 'actioned')),
  reviewed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_status_created ON public.reports(status, created_at DESC);
COMMENT ON TABLE public.reports IS 'Denúncias de mensagens, jogadores ou grupos enviadas para revisão de moderadores.';

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN (
    'friend_request', 'friend_accepted', 'group_invite', 'group_goal',
    'friend_levelup', 'season_reward', 'coop_invite', 'system'
  )),
  titulo TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  lida BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_lida_created
  ON public.notifications (user_id, lida, created_at DESC);

COMMENT ON TABLE public.notifications IS 'Notificações em tempo real (pedidos de amizade, convites de clã, level up de amigos, prêmios de season).';

-- -----------------------------------------------------------------------------
-- 10. VIEW `public_profiles` (Exposição Segura de Campos Públicos + Privacidade)
-- -----------------------------------------------------------------------------
-- Nunca expõe e-mail, dados de task_logs (diário), fichas ou contadores internos.
-- Respeita a configuração de privacidade ('publico', 'amigos', 'privado').
CREATE OR REPLACE VIEW public.public_profiles AS
SELECT
  p.id,
  p.username,
  p.avatar_url,
  p.privacy,
  p.moldura_equipada,
  CASE
    WHEN p.id = auth.uid()
      OR p.privacy = 'publico'
      OR (
        p.privacy = 'amigos'
        AND EXISTS (
          SELECT 1 FROM public.friendships f
          WHERE f.status = 'accepted'
            AND (
              (f.requester_id = auth.uid() AND f.addressee_id = p.id)
              OR (f.addressee_id = auth.uid() AND f.requester_id = p.id)
            )
        )
      )
    THEN p.bio
    ELSE 'PERFIL RESTRITO PELO AGENTE'
  END AS bio,
  p.level,
  CASE
    WHEN p.id = auth.uid()
      OR p.privacy = 'publico'
      OR (
        p.privacy = 'amigos'
        AND EXISTS (
          SELECT 1 FROM public.friendships f
          WHERE f.status = 'accepted'
            AND (
              (f.requester_id = auth.uid() AND f.addressee_id = p.id)
              OR (f.addressee_id = auth.uid() AND f.requester_id = p.id)
            )
        )
      )
    THEN p.xp_total
    ELSE 0
  END AS xp_total,
  CASE
    WHEN p.id = auth.uid()
      OR p.privacy = 'publico'
      OR (
        p.privacy = 'amigos'
        AND EXISTS (
          SELECT 1 FROM public.friendships f
          WHERE f.status = 'accepted'
            AND (
              (f.requester_id = auth.uid() AND f.addressee_id = p.id)
              OR (f.addressee_id = auth.uid() AND f.requester_id = p.id)
            )
        )
      )
    THEN p.streak_atual
    ELSE 0
  END AS streak_atual,
  CASE
    WHEN p.id = auth.uid()
      OR p.privacy = 'publico'
      OR (
        p.privacy = 'amigos'
        AND EXISTS (
          SELECT 1 FROM public.friendships f
          WHERE f.status = 'accepted'
            AND (
              (f.requester_id = auth.uid() AND f.addressee_id = p.id)
              OR (f.addressee_id = auth.uid() AND f.requester_id = p.id)
            )
        )
      )
    THEN p.maior_streak
    ELSE 0
  END AS maior_streak,
  c.nome AS character_nome,
  c.genero AS character_genero,
  c.cor_pele AS character_cor_pele,
  c.cabelo AS character_cabelo,
  c.cor_cabelo AS character_cor_cabelo,
  c.roupa AS character_roupa,
  c.cor_roupa AS character_cor_roupa,
  c.classe AS character_classe,
  c.arma AS character_arma,
  c.nivel_arma AS character_nivel_arma,
  g.id AS group_id,
  g.nome AS group_nome,
  g.tag AS group_tag,
  g.emblema AS group_emblema,
  p.created_at
FROM public.profiles p
LEFT JOIN public.characters c ON c.user_id = p.id
LEFT JOIN public.group_members gm ON gm.user_id = p.id
LEFT JOIN public.groups g ON g.id = gm.group_id;

COMMENT ON VIEW public.public_profiles IS 'Visão pública de agentes sem dados sensíveis (nunca expõe e-mail nem diário) e respeitando privacidade.';

-- -----------------------------------------------------------------------------
-- 11. VIEWS DE RANKING COM `RANK() OVER (...)`
-- -----------------------------------------------------------------------------

-- 11.1 Ranking Global de XP Total
CREATE OR REPLACE VIEW public.v_rank_xp AS
SELECT
  RANK() OVER (ORDER BY p.xp_total DESC, p.level DESC, p.created_at ASC)::INTEGER AS posicao,
  p.id AS user_id,
  p.username,
  p.level,
  p.xp_total AS valor,
  p.moldura_equipada,
  c.nome AS character_nome,
  c.classe AS character_classe,
  c.genero AS character_genero,
  c.cor_pele AS character_cor_pele,
  c.cabelo AS character_cabelo,
  c.cor_cabelo AS character_cor_cabelo,
  c.roupa AS character_roupa,
  c.cor_roupa AS character_cor_roupa,
  c.arma AS character_arma,
  c.nivel_arma AS character_nivel_arma,
  g.tag AS group_tag
FROM public.profiles p
LEFT JOIN public.characters c ON c.user_id = p.id
LEFT JOIN public.group_members gm ON gm.user_id = p.id
LEFT JOIN public.groups g ON g.id = gm.group_id
WHERE p.privacy <> 'privado' OR p.id = auth.uid();

COMMENT ON VIEW public.v_rank_xp IS 'Ranking de agentes por XP total acumulado (RANK() OVER).';

-- 11.2 Ranking de Sequência (Streak)
CREATE OR REPLACE VIEW public.v_rank_streak AS
SELECT
  RANK() OVER (ORDER BY p.streak_atual DESC, p.maior_streak DESC, p.xp_total DESC)::INTEGER AS posicao,
  p.id AS user_id,
  p.username,
  p.level,
  p.streak_atual AS valor,
  p.maior_streak,
  p.moldura_equipada,
  c.nome AS character_nome,
  c.classe AS character_classe,
  c.genero AS character_genero,
  c.cor_pele AS character_cor_pele,
  c.cabelo AS character_cabelo,
  c.cor_cabelo AS character_cor_cabelo,
  c.roupa AS character_roupa,
  c.cor_roupa AS character_cor_roupa,
  c.arma AS character_arma,
  c.nivel_arma AS character_nivel_arma,
  g.tag AS group_tag
FROM public.profiles p
LEFT JOIN public.characters c ON c.user_id = p.id
LEFT JOIN public.group_members gm ON gm.user_id = p.id
LEFT JOIN public.groups g ON g.id = gm.group_id
WHERE p.privacy <> 'privado' OR p.id = auth.uid();

COMMENT ON VIEW public.v_rank_streak IS 'Ranking de agentes por dias seguidos de ofensiva (streak_atual).';

-- 11.3 Ranking de Missões Concluídas na Semana Atual
CREATE OR REPLACE VIEW public.v_rank_missions_week AS
WITH weekly_counts AS (
  SELECT
    tl.user_id,
    COUNT(*)::INTEGER AS missoes_semana,
    COALESCE(SUM(tl.xp_ganho), 0)::INTEGER AS xp_semana
  FROM public.task_logs tl
  WHERE tl.data >= date_trunc('week', CURRENT_DATE)::DATE
  GROUP BY tl.user_id
)
SELECT
  RANK() OVER (
    ORDER BY COALESCE(wc.missoes_semana, 0) DESC, COALESCE(wc.xp_semana, 0) DESC, p.xp_total DESC
  )::INTEGER AS posicao,
  p.id AS user_id,
  p.username,
  p.level,
  COALESCE(wc.missoes_semana, 0) AS valor,
  COALESCE(wc.xp_semana, 0) AS xp_semana,
  p.moldura_equipada,
  c.nome AS character_nome,
  c.classe AS character_classe,
  c.genero AS character_genero,
  c.cor_pele AS character_cor_pele,
  c.cabelo AS character_cabelo,
  c.cor_cabelo AS character_cor_cabelo,
  c.roupa AS character_roupa,
  c.cor_roupa AS character_cor_roupa,
  c.arma AS character_arma,
  c.nivel_arma AS character_nivel_arma,
  g.tag AS group_tag
FROM public.profiles p
LEFT JOIN weekly_counts wc ON wc.user_id = p.id
LEFT JOIN public.characters c ON c.user_id = p.id
LEFT JOIN public.group_members gm ON gm.user_id = p.id
LEFT JOIN public.groups g ON g.id = gm.group_id
WHERE p.privacy <> 'privado' OR p.id = auth.uid();

COMMENT ON VIEW public.v_rank_missions_week IS 'Ranking semanal de missões diárias concluídas.';

-- 11.4 Ranking de Maior Distância na Missão na Cidade
CREATE OR REPLACE VIEW public.v_rank_distance AS
WITH best_runs AS (
  SELECT
    gr.user_id,
    MAX(gr.distancia)::INTEGER AS maior_distancia,
    SUM(gr.inimigos_derrotados)::INTEGER AS total_inimigos
  FROM public.game_runs gr
  GROUP BY gr.user_id
)
SELECT
  RANK() OVER (
    ORDER BY COALESCE(br.maior_distancia, 0) DESC, COALESCE(br.total_inimigos, 0) DESC, p.xp_total DESC
  )::INTEGER AS posicao,
  p.id AS user_id,
  p.username,
  p.level,
  COALESCE(br.maior_distancia, 0) AS valor,
  COALESCE(br.total_inimigos, 0) AS total_inimigos,
  p.moldura_equipada,
  c.nome AS character_nome,
  c.classe AS character_classe,
  c.genero AS character_genero,
  c.cor_pele AS character_cor_pele,
  c.cabelo AS character_cabelo,
  c.cor_cabelo AS character_cor_cabelo,
  c.roupa AS character_roupa,
  c.cor_roupa AS character_cor_roupa,
  c.arma AS character_arma,
  c.nivel_arma AS character_nivel_arma,
  g.tag AS group_tag
FROM public.profiles p
LEFT JOIN best_runs br ON br.user_id = p.id
LEFT JOIN public.characters c ON c.user_id = p.id
LEFT JOIN public.group_members gm ON gm.user_id = p.id
LEFT JOIN public.groups g ON g.id = gm.group_id
WHERE p.privacy <> 'privado' OR p.id = auth.uid();

COMMENT ON VIEW public.v_rank_distance IS 'Ranking de maior distância alcançada na Missão na Cidade.';

-- 11.5 Ranking de Bosses Derrotados
CREATE OR REPLACE VIEW public.v_rank_bosses AS
WITH boss_counts AS (
  SELECT
    gr.user_id,
    COUNT(*) FILTER (WHERE gr.boss_vencido = TRUE)::INTEGER AS bosses_vencidos,
    COUNT(*) FILTER (WHERE gr.boss_vencido = TRUE AND gr.sem_dano = TRUE)::INTEGER AS bosses_sem_dano
  FROM public.game_runs gr
  GROUP BY gr.user_id
)
SELECT
  RANK() OVER (
    ORDER BY COALESCE(bc.bosses_vencidos, 0) DESC, COALESCE(bc.bosses_sem_dano, 0) DESC, p.xp_total DESC
  )::INTEGER AS posicao,
  p.id AS user_id,
  p.username,
  p.level,
  COALESCE(bc.bosses_vencidos, 0) AS valor,
  COALESCE(bc.bosses_sem_dano, 0) AS bosses_sem_dano,
  p.moldura_equipada,
  c.nome AS character_nome,
  c.classe AS character_classe,
  c.genero AS character_genero,
  c.cor_pele AS character_cor_pele,
  c.cabelo AS character_cabelo,
  c.cor_cabelo AS character_cor_cabelo,
  c.roupa AS character_roupa,
  c.cor_roupa AS character_cor_roupa,
  c.arma AS character_arma,
  c.nivel_arma AS character_nivel_arma,
  g.tag AS group_tag
FROM public.profiles p
LEFT JOIN boss_counts bc ON bc.user_id = p.id
LEFT JOIN public.characters c ON c.user_id = p.id
LEFT JOIN public.group_members gm ON gm.user_id = p.id
LEFT JOIN public.groups g ON g.id = gm.group_id
WHERE p.privacy <> 'privado' OR p.id = auth.uid();

COMMENT ON VIEW public.v_rank_bosses IS 'Ranking de Mecha-Bosses derrotados na Cidade.';

-- 11.6 Ranking de Grupos / Clãs
CREATE OR REPLACE VIEW public.v_rank_groups AS
WITH member_stats AS (
  SELECT
    gm.group_id,
    COUNT(*)::INTEGER AS total_membros,
    COALESCE(SUM(gm.xp_contribuido), 0)::BIGINT AS soma_xp_membros
  FROM public.group_members gm
  GROUP BY gm.group_id
)
SELECT
  RANK() OVER (
    ORDER BY GREATEST(g.xp_total_grupo, COALESCE(ms.soma_xp_membros, 0)) DESC,
             COALESCE(ms.total_membros, 0) DESC,
             g.created_at ASC
  )::INTEGER AS posicao,
  g.id AS group_id,
  g.nome,
  g.tag,
  g.descricao,
  g.emblema,
  g.emblema_url,
  g.join_type,
  g.max_members,
  COALESCE(ms.total_membros, 1) AS total_membros,
  GREATEST(g.xp_total_grupo, COALESCE(ms.soma_xp_membros, 0))::BIGINT AS valor
FROM public.groups g
LEFT JOIN member_stats ms ON ms.group_id = g.id;

COMMENT ON VIEW public.v_rank_groups IS 'Ranking de Esquadrões/Grupos por XP coletivo.';
