-- =============================================================================
-- SISTEMA DE MISSÕES CYBERPUNK — MIGRAÇÃO COMPLETA SUPABASE (POSTGRESQL + RLS)
-- =============================================================================
-- Inclui:
-- 1. Extensões e Funções Utilitárias (updated_at)
-- 2. Tabelas: profiles, characters, tasks, task_logs, achievements,
--             user_achievements, game_runs, inventory
-- 3. Índices de performance e constraints de integridade
-- 4. Triggers (criação automática de profile, limite de 15 tarefas ativas, updated_at)
-- 5. Row Level Security (RLS) e Policies restritas ao próprio usuário (auth.uid())
-- 6. Funções RPC (SECURITY DEFINER) para regras críticas no servidor:
--    - concluir_tarefa
--    - iniciar_partida
--    - finalizar_partida
--    - comprar_item_loja
--    - equipar_item_loja
--    - importar_dados_locais
--    - excluir_minha_conta
-- 7. Configuração do Bucket Privado `registros` no Supabase Storage + Policies
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- 1. FUNÇÃO E TRIGGER AUTOMÁTICO DE UPDATED_AT
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 2. TABELA: profiles
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE,
  avatar_url TEXT,
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp_total INTEGER NOT NULL DEFAULT 0 CHECK (xp_total >= 0),
  xp_nivel_atual INTEGER NOT NULL DEFAULT 0 CHECK (xp_nivel_atual >= 0),
  streak_atual INTEGER NOT NULL DEFAULT 0 CHECK (streak_atual >= 0),
  maior_streak INTEGER NOT NULL DEFAULT 0 CHECK (maior_streak >= 0),
  ultima_data_streak DATE,
  moedas INTEGER NOT NULL DEFAULT 0 CHECK (moedas >= 0),
  fichas INTEGER NOT NULL DEFAULT 2 CHECK (fichas >= 0),
  xp_jogo_hoje INTEGER NOT NULL DEFAULT 0 CHECK (xp_jogo_hoje >= 0),
  data_xp_jogo DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_profiles_updated_at ON public.profiles;
CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 3. TABELA: characters (Perfil de Personagem Pixel Art 16x16)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.characters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
  nome TEXT NOT NULL CHECK (char_length(trim(nome)) BETWEEN 1 AND 16),
  genero TEXT NOT NULL DEFAULT 'f' CHECK (genero IN ('f', 'm')),
  cor_pele INTEGER NOT NULL DEFAULT 1 CHECK (cor_pele BETWEEN 0 AND 7),
  cabelo TEXT NOT NULL DEFAULT 'longo',
  cor_cabelo INTEGER NOT NULL DEFAULT 1 CHECK (cor_cabelo BETWEEN 0 AND 9),
  roupa TEXT NOT NULL DEFAULT 'viajante',
  cor_roupa INTEGER NOT NULL DEFAULT 0 CHECK (cor_roupa BETWEEN 0 AND 9),
  classe TEXT NOT NULL DEFAULT 'guerreiro' CHECK (classe IN (
    'guerreiro', 'mago', 'arqueiro', 'ladino', 'clerigo', 'paladino',
    'barbaro', 'bardo', 'monge', 'druida', 'necromante', 'cacador'
  )),
  arma TEXT NOT NULL DEFAULT 'espada_longa',
  nivel_arma INTEGER NOT NULL DEFAULT 0 CHECK (nivel_arma BETWEEN 0 AND 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_characters_updated_at ON public.characters;
CREATE TRIGGER trg_characters_updated_at
  BEFORE UPDATE ON public.characters
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 4. TABELA: tasks (Missões Diárias — Limite de 15 tarefas ativas por usuário)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  nome TEXT NOT NULL CHECK (char_length(trim(nome)) BETWEEN 1 AND 60),
  dificuldade TEXT NOT NULL CHECK (dificuldade IN ('facil', 'media', 'dificil', 'epica')),
  categoria TEXT DEFAULT '' CHECK (categoria IN ('', 'fisico', 'mental', 'criativo', 'social', 'rotina')),
  ativa BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_user_ativa ON public.tasks(user_id, ativa);

DROP TRIGGER IF EXISTS trg_tasks_updated_at ON public.tasks;
CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Trigger para garantir no máximo 15 tarefas ativas por usuário no banco
CREATE OR REPLACE FUNCTION public.check_max_active_tasks()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NEW.ativa = TRUE THEN
    SELECT COUNT(*) INTO v_count
    FROM public.tasks
    WHERE user_id = NEW.user_id
      AND ativa = TRUE
      AND (TG_OP = 'INSERT' OR id <> NEW.id);

    IF v_count >= 15 THEN
      RAISE EXCEPTION 'LIMITE_TAREFAS_ATINGIDO: Cada agente pode ter no máximo 15 missões ativas simultaneamente.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_max_active_tasks ON public.tasks;
CREATE TRIGGER trg_enforce_max_active_tasks
  BEFORE INSERT OR UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.check_max_active_tasks();

-- -----------------------------------------------------------------------------
-- 5. TABELA: task_logs (Diário de Missões — 1 conclusão/dia por tarefa + texto ou foto)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.task_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  data DATE NOT NULL DEFAULT CURRENT_DATE,
  descricao TEXT,
  foto_url TEXT,
  xp_ganho INTEGER NOT NULL DEFAULT 0 CHECK (xp_ganho >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_task_logs_task_day UNIQUE (task_id, data),
  CONSTRAINT chk_task_logs_desc_or_photo CHECK (
    (descricao IS NOT NULL AND char_length(trim(descricao)) > 0)
    OR (foto_url IS NOT NULL AND char_length(trim(foto_url)) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_task_logs_user_data ON public.task_logs(user_id, data DESC);

DROP TRIGGER IF EXISTS trg_task_logs_updated_at ON public.task_logs;
CREATE TRIGGER trg_task_logs_updated_at
  BEFORE UPDATE ON public.task_logs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 6. TABELAS: achievements & user_achievements
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.achievements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  titulo TEXT NOT NULL,
  descricao TEXT,
  diaria BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_achievements_updated_at ON public.achievements;
CREATE TRIGGER trg_achievements_updated_at
  BEFORE UPDATE ON public.achievements
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- Popula o catálogo inicial de conquistas
INSERT INTO public.achievements (code, titulo, descricao, diaria)
VALUES
  ('entrou_hoje',    'ENTROU HOJE',              'Acessou o Sistema de Missões hoje.', TRUE),
  ('uma_missao',     'COMPLETOU UMA MISSÃO',     'Concluiu pelo menos 1 missão no dia.', TRUE),
  ('tres_missoes',   'COMPLETOU TRÊS MISSÕES',   'Concluiu 3 missões no mesmo dia.', TRUE),
  ('primeiro_boss',  'DERROTOU O PRIMEIRO BOSS', 'Venceu um Mecha-Boss na Missão na Cidade.', FALSE),
  ('fase_sem_dano',  'FASE SEM TOMAR DANO',      'Completou a Missão na Cidade sem perder HP.', FALSE),
  ('cacador_ternos', '50 EXECUTIVOS DERROTADOS', 'Derrotou 50 inimigos corporativos acumulados.', FALSE)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.user_achievements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  achievement_id UUID NOT NULL REFERENCES public.achievements(id) ON DELETE CASCADE,
  data DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_achievement_date UNIQUE (user_id, achievement_id, data)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON public.user_achievements(user_id, data);

DROP TRIGGER IF EXISTS trg_user_achievements_updated_at ON public.user_achievements;
CREATE TRIGGER trg_user_achievements_updated_at
  BEFORE UPDATE ON public.user_achievements
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 7. TABELA: game_runs (Histórico de Partidas "Missão na Cidade")
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.game_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  distancia INTEGER NOT NULL DEFAULT 0 CHECK (distancia >= 0),
  inimigos_derrotados INTEGER NOT NULL DEFAULT 0 CHECK (inimigos_derrotados >= 0),
  boss_vencido BOOLEAN NOT NULL DEFAULT FALSE,
  sem_dano BOOLEAN NOT NULL DEFAULT FALSE,
  xp_ganho INTEGER NOT NULL DEFAULT 0 CHECK (xp_ganho >= 0),
  moedas_ganhas INTEGER NOT NULL DEFAULT 0 CHECK (moedas_ganhas >= 0),
  duracao INTEGER NOT NULL DEFAULT 0 CHECK (duracao >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_game_runs_user ON public.game_runs(user_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_game_runs_updated_at ON public.game_runs;
CREATE TRIGGER trg_game_runs_updated_at
  BEFORE UPDATE ON public.game_runs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 8. TABELA: inventory (Itens, Cosméticos, Skins e Upgrades Comprados)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('upgrade', 'outfit', 'weapon_skin')),
  nivel INTEGER NOT NULL DEFAULT 1 CHECK (nivel >= 1),
  equipado BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_inventory_user_item UNIQUE (user_id, item_key, item_type)
);

CREATE INDEX IF NOT EXISTS idx_inventory_user ON public.inventory(user_id);

DROP TRIGGER IF EXISTS trg_inventory_updated_at ON public.inventory;
CREATE TRIGGER trg_inventory_updated_at
  BEFORE UPDATE ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- -----------------------------------------------------------------------------
-- 9. TRIGGER AUTOMÁTICA DE CRIAÇÃO DE PERFIL E MISSÕES INICIAIS AO CADASTRAR
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_base_username TEXT;
  v_final_username TEXT;
BEGIN
  -- Extrai username sugerido dos metadados ou parte do e-mail
  v_base_username := COALESCE(
    NEW.raw_user_meta_data->>'username',
    NEW.raw_user_meta_data->>'name',
    NEW.raw_user_meta_data->>'full_name',
    split_part(COALESCE(NEW.email, 'agente'), '@', 1)
  );
  v_base_username := regexp_replace(lower(v_base_username), '[^a-z0-9_]', '', 'g');
  IF char_length(v_base_username) < 3 THEN
    v_base_username := 'agente';
  END IF;
  v_final_username := substr(v_base_username, 1, 16) || '_' || substr(replace(NEW.id::text, '-', ''), 1, 5);

  INSERT INTO public.profiles (
    id, username, avatar_url, level, xp_total, xp_nivel_atual,
    streak_atual, maior_streak, moedas, fichas
  ) VALUES (
    NEW.id,
    v_final_username,
    NEW.raw_user_meta_data->>'avatar_url',
    1, 0, 0, 0, 0, 0, 2
  )
  ON CONFLICT (id) DO NOTHING;

  -- Cria as 4 missões iniciais padrão se o usuário não tiver nenhuma
  IF NOT EXISTS (SELECT 1 FROM public.tasks WHERE user_id = NEW.id) THEN
    INSERT INTO public.tasks (user_id, nome, dificuldade, categoria, ativa) VALUES
      (NEW.id, 'Ler livro',                   'facil',   'mental',   TRUE),
      (NEW.id, 'Escrever páginas',            'media',   'criativo', TRUE),
      (NEW.id, 'Acordar cedo',                'facil',   'rotina',   TRUE),
      (NEW.id, 'Ir para a academia todo dia', 'dificil', 'fisico',   TRUE);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 10. ROW LEVEL SECURITY (RLS) EM TODAS AS TABELAS
-- -----------------------------------------------------------------------------
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_achievements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;

-- Policies para profiles (nota: atualização direta de XP/nível/moedas é protegida por trigger abaixo)
DROP POLICY IF EXISTS "profiles_select_own" ON public.profiles;
CREATE POLICY "profiles_select_own" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles;
CREATE POLICY "profiles_insert_own" ON public.profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (auth.uid() = id) WITH CHECK (auth.uid() = id);

DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles;
CREATE POLICY "profiles_delete_own" ON public.profiles
  FOR DELETE USING (auth.uid() = id);

-- Trigger para impedir que o cliente altere diretamente level, xp_total, moedas ou fichas via UPDATE comum
CREATE OR REPLACE FUNCTION public.protect_profile_progression()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Permite alterações quando executadas por funções internas RPC (flag na sessão) ou superuser/service_role
  IF current_setting('app.rpc_authorized', TRUE) = 'true' OR current_user IN ('postgres', 'service_role') THEN
    RETURN NEW;
  END IF;

  -- Se for uma chamada direta da API do cliente, preserva os campos sensíveis de progressão
  NEW.level := OLD.level;
  NEW.xp_total := OLD.xp_total;
  NEW.xp_nivel_atual := OLD.xp_nivel_atual;
  NEW.streak_atual := OLD.streak_atual;
  NEW.maior_streak := OLD.maior_streak;
  NEW.ultima_data_streak := OLD.ultima_data_streak;
  NEW.moedas := OLD.moedas;
  NEW.fichas := OLD.fichas;
  NEW.xp_jogo_hoje := OLD.xp_jogo_hoje;
  NEW.data_xp_jogo := OLD.data_xp_jogo;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_progression ON public.profiles;
CREATE TRIGGER trg_protect_profile_progression
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_progression();

-- Policies para characters
DROP POLICY IF EXISTS "characters_select_own" ON public.characters;
CREATE POLICY "characters_select_own" ON public.characters
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "characters_insert_own" ON public.characters;
CREATE POLICY "characters_insert_own" ON public.characters
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "characters_update_own" ON public.characters;
CREATE POLICY "characters_update_own" ON public.characters
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "characters_delete_own" ON public.characters;
CREATE POLICY "characters_delete_own" ON public.characters
  FOR DELETE USING (auth.uid() = user_id);

-- Policies para tasks
DROP POLICY IF EXISTS "tasks_select_own" ON public.tasks;
CREATE POLICY "tasks_select_own" ON public.tasks
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "tasks_insert_own" ON public.tasks;
CREATE POLICY "tasks_insert_own" ON public.tasks
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "tasks_update_own" ON public.tasks;
CREATE POLICY "tasks_update_own" ON public.tasks
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "tasks_delete_own" ON public.tasks;
CREATE POLICY "tasks_delete_own" ON public.tasks
  FOR DELETE USING (auth.uid() = user_id);

-- Policies para task_logs (leitura pelo dono; inserção via RPC concluir_tarefa)
DROP POLICY IF EXISTS "task_logs_select_own" ON public.task_logs;
CREATE POLICY "task_logs_select_own" ON public.task_logs
  FOR SELECT USING (auth.uid() = user_id);

-- Policies para achievements (catálogo público para usuários autenticados)
DROP POLICY IF EXISTS "achievements_select_all" ON public.achievements;
CREATE POLICY "achievements_select_all" ON public.achievements
  FOR SELECT TO authenticated USING (TRUE);

-- Policies para user_achievements
DROP POLICY IF EXISTS "user_achievements_select_own" ON public.user_achievements;
CREATE POLICY "user_achievements_select_own" ON public.user_achievements
  FOR SELECT USING (auth.uid() = user_id);

-- Policies para game_runs
DROP POLICY IF EXISTS "game_runs_select_own" ON public.game_runs;
CREATE POLICY "game_runs_select_own" ON public.game_runs
  FOR SELECT USING (auth.uid() = user_id);

-- Policies para inventory
DROP POLICY IF EXISTS "inventory_select_own" ON public.inventory;
CREATE POLICY "inventory_select_own" ON public.inventory
  FOR SELECT USING (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 11. FUNÇÕES AUXILIARES E RPCs DE SERVIDOR (ANTI-CHEAT)
-- -----------------------------------------------------------------------------

-- Função matemática: XP necessário para subir do nível `p_level` para o próximo
CREATE OR REPLACE FUNCTION public.calc_xp_to_next(p_level INTEGER)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT ROUND(100 * POWER(1.25, GREATEST(1, p_level) - 1))::INTEGER;
$$;

-- Função interna para desbloquear conquista pelo código
CREATE OR REPLACE FUNCTION public.unlock_achievement_internal(
  p_user_id UUID,
  p_code TEXT,
  p_date DATE DEFAULT CURRENT_DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ach RECORD;
  v_target_date DATE;
BEGIN
  SELECT * INTO v_ach FROM public.achievements WHERE code = p_code;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  -- Conquistas permanentes usam data fixa '1970-01-01' na chave única para nunca duplicar
  v_target_date := CASE WHEN v_ach.diaria THEN p_date ELSE DATE '1970-01-01' END;

  INSERT INTO public.user_achievements (user_id, achievement_id, data)
  VALUES (p_user_id, v_ach.id, v_target_date)
  ON CONFLICT (user_id, achievement_id, data) DO NOTHING;

  RETURN FOUND;
END;
$$;

-- RPC: Registrar acesso diário ("ENTROU HOJE") e validar streak
CREATE OR REPLACE FUNCTION public.registrar_acesso_diario()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_prof RECORD;
  v_unlocked BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO: Faça login para continuar.';
  END IF;

  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PERFIL_NAO_ENCONTRADO';
  END IF;

  -- Se perdeu a sequência (última missão concluída foi antes de ontem), zera streak_atual
  IF v_prof.ultima_data_streak IS NOT NULL
     AND v_prof.ultima_data_streak < (CURRENT_DATE - INTERVAL '1 day')::DATE
     AND v_prof.streak_atual > 0 THEN
    UPDATE public.profiles
    SET streak_atual = 0
    WHERE id = v_user_id;
  END IF;

  -- Reinicia contador diário de XP do jogo se mudou o dia
  IF v_prof.data_xp_jogo IS DISTINCT FROM CURRENT_DATE THEN
    UPDATE public.profiles
    SET xp_jogo_hoje = 0,
        data_xp_jogo = CURRENT_DATE
    WHERE id = v_user_id;
  END IF;

  v_unlocked := public.unlock_achievement_internal(v_user_id, 'entrou_hoje', CURRENT_DATE);

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_user_id;
  RETURN jsonb_build_object(
    'profile', row_to_json(v_prof),
    'entrou_hoje_novo', v_unlocked
  );
END;
$$;

-- RPC 1: CONCLUIR TAREFA (calcula XP, bônus de sequência, bônus de classe, fichas, nível e conquistas)
CREATE OR REPLACE FUNCTION public.concluir_tarefa(
  p_task_id UUID,
  p_descricao TEXT DEFAULT NULL,
  p_foto_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_task RECORD;
  v_prof RECORD;
  v_char RECORD;
  v_today DATE := CURRENT_DATE;
  v_desc TEXT := NULLIF(trim(COALESCE(p_descricao, '')), '');
  v_foto TEXT := NULLIF(trim(COALESCE(p_foto_url, '')), '');
  v_base_xp INTEGER;
  v_tickets INTEGER;
  v_new_streak INTEGER;
  v_streak_mult NUMERIC;
  v_class_bonus NUMERIC := 0;
  v_xp_ganho INTEGER;
  v_new_xp_atual INTEGER;
  v_new_xp_total INTEGER;
  v_new_level INTEGER;
  v_levels_gained INTEGER := 0;
  v_new_maior_streak INTEGER;
  v_new_weapon_tier INTEGER;
  v_done_today INTEGER;
  v_log RECORD;
  v_unlocked TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO: Sessão inválida ou expirada.';
  END IF;

  IF v_desc IS NULL AND v_foto IS NULL THEN
    RAISE EXCEPTION 'PROVA_OBRIGATORIA: Envie uma foto ou escreva uma descrição para concluir a missão.';
  END IF;

  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  SELECT * INTO v_task
  FROM public.tasks
  WHERE id = p_task_id AND user_id = v_user_id AND ativa = TRUE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TAREFA_NAO_ENCONTRADA: Missão não encontrada ou inativa.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.task_logs
    WHERE task_id = p_task_id AND data = v_today
  ) THEN
    RAISE EXCEPTION 'JA_CONCLUIDA_HOJE: Esta missão já foi concluída hoje.';
  END IF;

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_user_id FOR UPDATE;
  SELECT * INTO v_char FROM public.characters WHERE user_id = v_user_id;

  -- XP base e fichas por dificuldade
  CASE v_task.dificuldade
    WHEN 'facil'   THEN v_base_xp := 10;  v_tickets := 1;
    WHEN 'media'   THEN v_base_xp := 25;  v_tickets := 2;
    WHEN 'dificil' THEN v_base_xp := 50;  v_tickets := 3;
    WHEN 'epica'   THEN v_base_xp := 100; v_tickets := 5;
    ELSE v_base_xp := 10; v_tickets := 1;
  END CASE;

  -- Cálculo da sequência (streak)
  IF v_prof.ultima_data_streak = v_today THEN
    v_new_streak := GREATEST(1, v_prof.streak_atual);
  ELSIF v_prof.ultima_data_streak = (v_today - INTERVAL '1 day')::DATE THEN
    v_new_streak := v_prof.streak_atual + 1;
  ELSE
    v_new_streak := 1;
  END IF;

  v_streak_mult := 1.0 + (0.10 * FLOOR(v_new_streak / 3.0));

  -- Bônus passivo de classe (+10% se categoria da tarefa bater com a classe do personagem)
  IF v_char.classe IS NOT NULL AND v_task.categoria IS NOT NULL AND v_task.categoria <> '' THEN
    IF (v_char.classe IN ('guerreiro', 'barbaro', 'cacador') AND v_task.categoria = 'fisico')
       OR (v_char.classe IN ('mago', 'monge', 'necromante') AND v_task.categoria = 'mental')
       OR (v_char.classe IN ('arqueiro', 'paladino') AND v_task.categoria = 'rotina')
       OR (v_char.classe IN ('ladino', 'clerigo') AND v_task.categoria = 'social')
       OR (v_char.classe IN ('bardo', 'druida') AND v_task.categoria = 'criativo') THEN
      v_class_bonus := 0.10;
    END IF;
  END IF;

  v_xp_ganho := ROUND(v_base_xp * v_streak_mult * (1.0 + v_class_bonus))::INTEGER;

  -- Insere o registro no diário
  INSERT INTO public.task_logs (task_id, user_id, data, descricao, foto_url, xp_ganho)
  VALUES (p_task_id, v_user_id, v_today, v_desc, v_foto, v_xp_ganho)
  RETURNING * INTO v_log;

  -- Calcula subida de nível
  v_new_xp_atual := v_prof.xp_nivel_atual + v_xp_ganho;
  v_new_xp_total := v_prof.xp_total + v_xp_ganho;
  v_new_level := v_prof.level;

  WHILE v_new_xp_atual >= public.calc_xp_to_next(v_new_level) LOOP
    v_new_xp_atual := v_new_xp_atual - public.calc_xp_to_next(v_new_level);
    v_new_level := v_new_level + 1;
    v_levels_gained := v_levels_gained + 1;
  END LOOP;

  v_new_maior_streak := GREATEST(v_prof.maior_streak, v_new_streak);

  UPDATE public.profiles
  SET level = v_new_level,
      xp_total = v_new_xp_total,
      xp_nivel_atual = v_new_xp_atual,
      streak_atual = v_new_streak,
      maior_streak = v_new_maior_streak,
      ultima_data_streak = v_today,
      fichas = fichas + v_tickets
  WHERE id = v_user_id
  RETURNING * INTO v_prof;

  -- Atualiza tier/nível da arma do personagem conforme o nível (a cada 5 níveis sobe 1 tier, máx 4)
  IF v_char.id IS NOT NULL THEN
    v_new_weapon_tier := LEAST(4, FLOOR(v_new_level / 5.0)::INTEGER);
    IF v_new_weapon_tier <> v_char.nivel_arma THEN
      UPDATE public.characters
      SET nivel_arma = v_new_weapon_tier
      WHERE id = v_char.id;
    END IF;
  END IF;

  -- Avalia conquistas diárias
  PERFORM public.unlock_achievement_internal(v_user_id, 'entrou_hoje', v_today);

  SELECT COUNT(*) INTO v_done_today
  FROM public.task_logs
  WHERE user_id = v_user_id AND data = v_today;

  IF v_done_today >= 1 THEN
    IF public.unlock_achievement_internal(v_user_id, 'uma_missao', v_today) THEN
      v_unlocked := array_append(v_unlocked, 'uma_missao');
    END IF;
  END IF;

  IF v_done_today >= 3 THEN
    IF public.unlock_achievement_internal(v_user_id, 'tres_missoes', v_today) THEN
      v_unlocked := array_append(v_unlocked, 'tres_missoes');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'log', row_to_json(v_log),
    'profile', row_to_json(v_prof),
    'xp_ganho', v_xp_ganho,
    'fichas_ganhas', v_tickets,
    'levels_gained', v_levels_gained,
    'prev_level', v_prof.level - v_levels_gained,
    'unlocked_achievements', v_unlocked
  );
END;
$$;

-- RPC 2: INICIAR PARTIDA NA CIDADE (verifica fichas ou modo livre se todas as tarefas do dia foram feitas)
CREATE OR REPLACE FUNCTION public.iniciar_partida()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_prof RECORD;
  v_total_active INTEGER;
  v_done_today INTEGER;
  v_free_play BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO: Faça login para jogar.';
  END IF;

  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_user_id FOR UPDATE;

  SELECT COUNT(*) INTO v_total_active
  FROM public.tasks
  WHERE user_id = v_user_id AND ativa = TRUE;

  SELECT COUNT(*) INTO v_done_today
  FROM public.task_logs tl
  JOIN public.tasks t ON t.id = tl.task_id
  WHERE tl.user_id = v_user_id
    AND tl.data = CURRENT_DATE
    AND t.ativa = TRUE;

  IF v_total_active > 0 AND v_done_today >= v_total_active THEN
    v_free_play := TRUE;
  END IF;

  IF NOT v_free_play THEN
    IF v_prof.fichas < 1 THEN
      RAISE EXCEPTION 'SEM_FICHAS: Você não possui fichas suficientes. Conclua missões diárias!';
    END IF;

    UPDATE public.profiles
    SET fichas = fichas - 1
    WHERE id = v_user_id
    RETURNING * INTO v_prof;
  END IF;

  RETURN jsonb_build_object(
    'profile', row_to_json(v_prof),
    'free_play', v_free_play
  );
END;
$$;

-- RPC 3: FINALIZAR PARTIDA NA CIDADE (valida limites anti-cheat, aplica teto diário de 30% de XP, moedas, drops e conquistas)
CREATE OR REPLACE FUNCTION public.finalizar_partida(
  p_distancia INTEGER,
  p_inimigos_derrotados INTEGER,
  p_boss_vencido BOOLEAN,
  p_sem_dano BOOLEAN,
  p_moedas_coletadas INTEGER,
  p_duracao INTEGER,
  p_drop_raro_key TEXT DEFAULT NULL,
  p_drop_raro_tipo TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_prof RECORD;
  v_char RECORD;
  v_today DATE := CURRENT_DATE;
  v_dist INTEGER := GREATEST(0, LEAST(COALESCE(p_distancia, 0), 5000));
  v_kills INTEGER := GREATEST(0, LEAST(COALESCE(p_inimigos_derrotados, 0), 250));
  v_dur INTEGER := GREATEST(1, LEAST(COALESCE(p_duracao, 1), 7200));
  v_coins INTEGER := GREATEST(0, LEAST(COALESCE(p_moedas_coletadas, 0), 600));
  v_raw_xp INTEGER;
  v_daily_cap INTEGER;
  v_xp_hoje INTEGER;
  v_rem_xp INTEGER;
  v_xp_concedido INTEGER;
  v_new_xp_atual INTEGER;
  v_new_xp_total INTEGER;
  v_new_level INTEGER;
  v_levels_gained INTEGER := 0;
  v_run RECORD;
  v_total_kills INTEGER;
  v_unlocked TEXT[] := ARRAY[]::TEXT[];
  v_loot_applied TEXT := NULL;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO: Sessão inválida.';
  END IF;

  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_user_id FOR UPDATE;
  SELECT * INTO v_char FROM public.characters WHERE user_id = v_user_id;

  -- Calcula XP bruto no servidor com base no desempenho real
  v_raw_xp := (v_kills * 6) + (LEAST(8, FLOOR(v_dist / 45.0)::INTEGER) * 8);
  IF p_boss_vencido THEN
    v_raw_xp := v_raw_xp + 45;
  END IF;

  -- Limite diário de XP na Cidade: 30% do XP necessário para o nível atual (mínimo 30)
  v_daily_cap := GREATEST(30, ROUND(public.calc_xp_to_next(v_prof.level) * 0.30)::INTEGER);
  v_xp_hoje := CASE WHEN v_prof.data_xp_jogo = v_today THEN v_prof.xp_jogo_hoje ELSE 0 END;
  v_rem_xp := GREATEST(0, v_daily_cap - v_xp_hoje);
  v_xp_concedido := LEAST(v_rem_xp, v_raw_xp);

  -- Registra a partida em game_runs
  INSERT INTO public.game_runs (
    user_id, distancia, inimigos_derrotados, boss_vencido,
    sem_dano, xp_ganho, moedas_ganhas, duracao
  ) VALUES (
    v_user_id, v_dist, v_kills, COALESCE(p_boss_vencido, FALSE),
    COALESCE(p_sem_dano, FALSE), v_xp_concedido, v_coins, v_dur
  )
  RETURNING * INTO v_run;

  -- Atualiza XP, nível e moedas do perfil
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
  WHERE id = v_user_id
  RETURNING * INTO v_prof;

  IF v_char.id IS NOT NULL THEN
    UPDATE public.characters
    SET nivel_arma = LEAST(4, FLOOR(v_new_level / 5.0)::INTEGER)
    WHERE id = v_char.id;
  END IF;

  -- Se venceu o Boss e houve drop raro válido, registra no inventário
  IF p_boss_vencido AND p_drop_raro_key IS NOT NULL AND p_drop_raro_tipo IN ('outfit', 'weapon_skin') THEN
    INSERT INTO public.inventory (user_id, item_key, item_type, nivel, equipado)
    VALUES (v_user_id, p_drop_raro_key, p_drop_raro_tipo, 1, FALSE)
    ON CONFLICT (user_id, item_key, item_type) DO NOTHING;
    IF FOUND THEN
      v_loot_applied := p_drop_raro_key;
    END IF;
  END IF;

  -- Verifica conquistas permanentes do jogo
  IF p_boss_vencido THEN
    IF public.unlock_achievement_internal(v_user_id, 'primeiro_boss', v_today) THEN
      v_unlocked := array_append(v_unlocked, 'primeiro_boss');
    END IF;
    IF p_sem_dano THEN
      IF public.unlock_achievement_internal(v_user_id, 'fase_sem_dano', v_today) THEN
        v_unlocked := array_append(v_unlocked, 'fase_sem_dano');
      END IF;
    END IF;
  END IF;

  SELECT COALESCE(SUM(inimigos_derrotados), 0) INTO v_total_kills
  FROM public.game_runs
  WHERE user_id = v_user_id;

  IF v_total_kills >= 50 THEN
    IF public.unlock_achievement_internal(v_user_id, 'cacador_ternos', v_today) THEN
      v_unlocked := array_append(v_unlocked, 'cacador_ternos');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'run', row_to_json(v_run),
    'profile', row_to_json(v_prof),
    'xp_ganho', v_xp_concedido,
    'moedas_ganhas', v_coins,
    'levels_gained', v_levels_gained,
    'prev_level', v_prof.level - v_levels_gained,
    'loot_key', v_loot_applied,
    'unlocked_achievements', v_unlocked
  );
END;
$$;

-- RPC 4: COMPRAR OU EQUIPAR ITEM NA LOJA DA CIDADE (valida preços e saldo no servidor)
CREATE OR REPLACE FUNCTION public.comprar_ou_equipar_item(
  p_item_key TEXT,
  p_item_type TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_prof RECORD;
  v_inv RECORD;
  v_cur_lvl INTEGER := 0;
  v_cost INTEGER := 0;
  v_action TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  SELECT * INTO v_prof FROM public.profiles WHERE id = v_user_id FOR UPDATE;
  SELECT * INTO v_inv FROM public.inventory
  WHERE user_id = v_user_id AND item_key = p_item_key AND item_type = p_item_type;

  IF p_item_type = 'upgrade' THEN
    v_cur_lvl := COALESCE(v_inv.nivel, 0);
    IF v_cur_lvl >= 5 THEN
      RAISE EXCEPTION 'NIVEL_MAXIMO: Este upgrade já está no nível máximo (5).';
    END IF;

    CASE p_item_key
      WHEN 'hp'  THEN v_cost := ROUND(30 * POWER(1.60, v_cur_lvl))::INTEGER;
      WHEN 'dmg' THEN v_cost := ROUND(35 * POWER(1.65, v_cur_lvl))::INTEGER;
      WHEN 'spd' THEN v_cost := ROUND(25 * POWER(1.55, v_cur_lvl))::INTEGER;
      ELSE RAISE EXCEPTION 'UPGRADE_INVALIDO';
    END CASE;

    IF v_prof.moedas < v_cost THEN
      RAISE EXCEPTION 'MOEDAS_INSUFICIENTES: Você precisa de % moedas.', v_cost;
    END IF;

    UPDATE public.profiles SET moedas = moedas - v_cost WHERE id = v_user_id RETURNING * INTO v_prof;

    INSERT INTO public.inventory (user_id, item_key, item_type, nivel, equipado)
    VALUES (v_user_id, p_item_key, 'upgrade', 1, TRUE)
    ON CONFLICT (user_id, item_key, item_type)
    DO UPDATE SET nivel = public.inventory.nivel + 1, updated_at = NOW();

    v_action := 'upgraded';

  ELSIF p_item_type = 'weapon_skin' THEN
    IF v_inv.id IS NOT NULL THEN
      -- Já possui: alterna equipado
      IF v_inv.equipado THEN
        UPDATE public.inventory SET equipado = FALSE WHERE id = v_inv.id;
        v_action := 'unequipped';
      ELSE
        UPDATE public.inventory SET equipado = FALSE WHERE user_id = v_user_id AND item_type = 'weapon_skin';
        UPDATE public.inventory SET equipado = TRUE WHERE id = v_inv.id;
        v_action := 'equipped';
      END IF;
    ELSE
      CASE p_item_key
        WHEN 'neon_cyan' THEN v_cost := 60;
        WHEN 'plasma'    THEN v_cost := 85;
        WHEN 'carmesim'  THEN v_cost := 100;
        WHEN 'solar'     THEN v_cost := 130;
        ELSE RAISE EXCEPTION 'SKIN_INVALIDA';
      END CASE;

      IF v_prof.moedas < v_cost THEN
        RAISE EXCEPTION 'MOEDAS_INSUFICIENTES: Você precisa de % moedas.', v_cost;
      END IF;

      UPDATE public.profiles SET moedas = moedas - v_cost WHERE id = v_user_id RETURNING * INTO v_prof;
      UPDATE public.inventory SET equipado = FALSE WHERE user_id = v_user_id AND item_type = 'weapon_skin';

      INSERT INTO public.inventory (user_id, item_key, item_type, nivel, equipado)
      VALUES (v_user_id, p_item_key, 'weapon_skin', 1, TRUE);
      v_action := 'purchased';
    END IF;

  ELSIF p_item_type = 'outfit' THEN
    IF v_inv.id IS NOT NULL THEN
      UPDATE public.characters SET roupa = p_item_key WHERE user_id = v_user_id;
      v_action := 'equipped';
    ELSE
      CASE p_item_key
        WHEN 'cyber_agente'   THEN v_cost := 80;
        WHEN 'executivo_neon' THEN v_cost := 110;
        WHEN 'armadura_omega' THEN v_cost := 160;
        ELSE RAISE EXCEPTION 'TRAJE_INVALIDO';
      END CASE;

      IF v_prof.moedas < v_cost THEN
        RAISE EXCEPTION 'MOEDAS_INSUFICIENTES: Você precisa de % moedas.', v_cost;
      END IF;

      UPDATE public.profiles SET moedas = moedas - v_cost WHERE id = v_user_id RETURNING * INTO v_prof;
      INSERT INTO public.inventory (user_id, item_key, item_type, nivel, equipado)
      VALUES (v_user_id, p_item_key, 'outfit', 1, TRUE);
      UPDATE public.characters SET roupa = p_item_key WHERE user_id = v_user_id;
      v_action := 'purchased';
    END IF;
  ELSE
    RAISE EXCEPTION 'TIPO_ITEM_INVALIDO';
  END IF;

  RETURN jsonb_build_object(
    'action', v_action,
    'profile', row_to_json(v_prof),
    'inventory', (SELECT COALESCE(jsonb_agg(row_to_json(i)), '[]'::jsonb) FROM public.inventory i WHERE i.user_id = v_user_id)
  );
END;
$$;

-- RPC 5: IMPORTAR DADOS DO LOCALSTORAGE (Migração única no primeiro login)
CREATE OR REPLACE FUNCTION public.importar_dados_locais(p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_prof RECORD;
  v_char JSONB := p_payload->'profile';
  v_game JSONB := p_payload->'game';
  v_tasks JSONB := p_payload->'tasks';
  v_task_item JSONB;
  v_upg_key TEXT;
  v_upg_val INTEGER;
  v_str_item TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  -- Atualiza perfil com dados migrados (preservando os maiores valores)
  UPDATE public.profiles
  SET level = GREATEST(level, COALESCE((p_payload->>'level')::INTEGER, 1)),
      xp_total = GREATEST(xp_total, COALESCE((p_payload->>'totalXP')::INTEGER, 0)),
      xp_nivel_atual = GREATEST(xp_nivel_atual, COALESCE((p_payload->>'xp')::INTEGER, 0)),
      streak_atual = GREATEST(streak_atual, COALESCE((p_payload->'streak'->>'count')::INTEGER, 0)),
      maior_streak = GREATEST(maior_streak, COALESCE((p_payload->'streak'->>'count')::INTEGER, 0)),
      moedas = GREATEST(moedas, COALESCE((v_game->>'coins')::INTEGER, 0)),
      fichas = GREATEST(fichas, COALESCE((v_game->>'tickets')::INTEGER, 2))
  WHERE id = v_user_id
  RETURNING * INTO v_prof;

  -- Importa personagem se existir no payload
  IF v_char IS NOT NULL AND jsonb_typeof(v_char) = 'object' AND COALESCE(v_char->>'nome', '') <> '' THEN
    INSERT INTO public.characters (
      user_id, nome, genero, cor_pele, cabelo, cor_cabelo,
      roupa, cor_roupa, classe, arma, nivel_arma
    ) VALUES (
      v_user_id,
      substr(trim(v_char->>'nome'), 1, 16),
      COALESCE(v_char->>'genero', 'f'),
      COALESCE((v_char->>'pele')::INTEGER, 1),
      COALESCE(v_char->>'cabelo', 'longo'),
      COALESCE((v_char->>'corCabelo')::INTEGER, 1),
      COALESCE(v_char->>'roupa', 'viajante'),
      COALESCE((v_char->>'corRoupa')::INTEGER, 0),
      COALESCE(v_char->>'classe', 'guerreiro'),
      COALESCE(v_char->>'arma', 'espada_longa'),
      LEAST(4, FLOOR(v_prof.level / 5.0)::INTEGER)
    )
    ON CONFLICT (user_id) DO UPDATE SET
      nome = EXCLUDED.nome,
      genero = EXCLUDED.genero,
      cor_pele = EXCLUDED.cor_pele,
      cabelo = EXCLUDED.cabelo,
      cor_cabelo = EXCLUDED.cor_cabelo,
      roupa = EXCLUDED.roupa,
      cor_roupa = EXCLUDED.cor_roupa,
      classe = EXCLUDED.classe,
      arma = EXCLUDED.arma,
      nivel_arma = EXCLUDED.nivel_arma;
  END IF;

  -- Substitui tarefas padrão pelas tarefas do localStorage (respeitando limite de 15)
  IF v_tasks IS NOT NULL AND jsonb_typeof(v_tasks) = 'array' AND jsonb_array_length(v_tasks) > 0 THEN
    DELETE FROM public.tasks WHERE user_id = v_user_id;
    FOR v_task_item IN SELECT * FROM jsonb_array_elements(v_tasks) LIMIT 15 LOOP
      INSERT INTO public.tasks (user_id, nome, dificuldade, categoria, ativa)
      VALUES (
        v_user_id,
        substr(trim(COALESCE(v_task_item->>'name', 'Missão')), 1, 60),
        COALESCE(v_task_item->>'difficulty', 'facil'),
        COALESCE(v_task_item->>'category', ''),
        TRUE
      );
    END LOOP;
  END IF;

  -- Importa upgrades da loja
  IF v_game IS NOT NULL AND jsonb_typeof(v_game->'upgrades') = 'object' THEN
    FOR v_upg_key, v_upg_val IN SELECT key, value::text::integer FROM jsonb_each(v_game->'upgrades') LOOP
      IF v_upg_val > 0 AND v_upg_key IN ('hp', 'dmg', 'spd') THEN
        INSERT INTO public.inventory (user_id, item_key, item_type, nivel, equipado)
        VALUES (v_user_id, v_upg_key, 'upgrade', LEAST(5, v_upg_val), TRUE)
        ON CONFLICT (user_id, item_key, item_type) DO UPDATE SET nivel = EXCLUDED.nivel;
      END IF;
    END LOOP;
  END IF;

  -- Importa trajes desbloqueados
  IF v_game IS NOT NULL AND jsonb_typeof(v_game->'unlockedOutfits') = 'array' THEN
    FOR v_str_item IN SELECT jsonb_array_elements_text(v_game->'unlockedOutfits') LOOP
      INSERT INTO public.inventory (user_id, item_key, item_type, nivel, equipado)
      VALUES (v_user_id, v_str_item, 'outfit', 1, FALSE)
      ON CONFLICT (user_id, item_key, item_type) DO NOTHING;
    END LOOP;
  END IF;

  -- Importa skins de arma desbloqueadas
  IF v_game IS NOT NULL AND jsonb_typeof(v_game->'unlockedWeaponSkins') = 'array' THEN
    FOR v_str_item IN SELECT jsonb_array_elements_text(v_game->'unlockedWeaponSkins') LOOP
      INSERT INTO public.inventory (user_id, item_key, item_type, nivel, equipado)
      VALUES (
        v_user_id,
        v_str_item,
        'weapon_skin',
        1,
        (v_game->>'equippedWeaponSkin') = v_str_item
      )
      ON CONFLICT (user_id, item_key, item_type) DO NOTHING;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'profile', row_to_json(v_prof));
END;
$$;

-- RPC 6: EXCLUIR PRÓPRIA CONTA COMPLETAMENTE (remove dados e usuário em auth.users)
CREATE OR REPLACE FUNCTION public.excluir_minha_conta()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'NAO_AUTENTICADO';
  END IF;

  -- Remove arquivos de fotos do bucket registros do usuário
  DELETE FROM storage.objects
  WHERE bucket_id = 'registros' AND (storage.foldername(name))[1] = v_user_id::text;

  -- Remove o usuário de auth.users (ON DELETE CASCADE remove profiles, characters, tasks, task_logs, etc.)
  DELETE FROM auth.users WHERE id = v_user_id;

  RETURN TRUE;
END;
$$;

-- -----------------------------------------------------------------------------
-- 12. SUPABASE STORAGE: BUCKET PRIVADO `registros` + POLICIES DE ACESSO
-- -----------------------------------------------------------------------------
-- Cria o bucket privado `registros` com limite de 5 MB (5242880 bytes) e MIME types restritos
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'registros',
  'registros',
  FALSE,
  5242880,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = FALSE,
  file_size_limit = 5242880,
  allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp'];

-- Policies na tabela storage.objects para que cada usuário acesse apenas /{user_id}/{data}/{arquivo}
DROP POLICY IF EXISTS "registros_select_own" ON storage.objects;
CREATE POLICY "registros_select_own" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'registros'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "registros_insert_own" ON storage.objects;
CREATE POLICY "registros_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'registros'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "registros_update_own" ON storage.objects;
CREATE POLICY "registros_update_own" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'registros'
    AND (storage.foldername(name))[1] = auth.uid()::text
  )
  WITH CHECK (
    bucket_id = 'registros'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "registros_delete_own" ON storage.objects;
CREATE POLICY "registros_delete_own" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'registros'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- -----------------------------------------------------------------------------
-- 13. HABILITAR REALTIME NA TABELA PROFILES (ATUALIZAÇÃO EM TEMPO REAL DA BARRA DE XP)
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Caso a publication padrão não exista no ambiente local
  NULL;
END $$;
