-- =============================================================================
-- MIGRAÇÃO 005: REALTIME, REALTIME AUTHORIZATION, STORAGE BUCKETS E PG_CRON
-- =============================================================================
-- Inclui:
-- 1. Publicação `supabase_realtime` estritamente para:
--    - `messages`, `notifications` e `friendships` (conforme item 4 do escopo)
-- 2. Realtime Authorization (`realtime.messages` RLS policies) para canais privados:
--    - `room:{room_id}` (Broadcast multiplayer só para membros da sala)
--    - `chat:{conversation_id}` (Broadcast de "digitando..." e eventos de conversa
--      só para membros de `conversations` via `public.is_member`)
--    - `presence:global` (Presence online/offline/jogando para usuários autenticados)
-- 3. Buckets do Supabase Storage:
--    - `emblemas` (público, ícones de grupos, somente leitura para clientes comuns;
--      upload restrito a líderes/oficiais de grupo, máx 1 MB, png/jpg/webp)
--    - `anexos-chat` (privado, imagens até 2 MB, tipos png/jpg/webp, com policies
--      por conversa: `/{conversation_id}/{user_id}/{arquivo}`)
-- 4. Agendamentos `pg_cron` e funções administrativas de manutenção:
--    - `fechar_temporada_e_premiar(p_period)`: fecha a season ativa (weekly/monthly),
--      grava os resultados em `season_results`, premia os 3 primeiros com moedas
--      e moldura exclusiva (`molduras_desbloqueadas` / `moldura_equipada`),
--      notifica os vencedores e abre a nova season.
--    - `reiniciar_metas_semanais_grupos()`: gera novas metas semanais para todos os grupos.
--    - `limpar_salas_abandonadas()`: marca como `abandoned` salas em `waiting` ou `playing`
--      há mais de 2 horas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PUBLICAÇÃO `supabase_realtime` (SOMENTE messages, notifications, friendships)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
BEGIN
  -- Garante que a publication supabase_realtime exista
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  -- Remove tabelas que não sejam messages, notifications ou friendships da publicação
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename NOT IN ('messages', 'notifications', 'friendships')
  LOOP
    EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I.%I', r.schemaname, r.tablename);
  END LOOP;

  -- Adiciona exatamente messages, notifications e friendships
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'friendships'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.friendships;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. REALTIME AUTHORIZATION (POLICIES EM `realtime.messages`)
--    Garante que só membros da sala (`room:{room_id}`) ou da conversa
--    (`chat:{conversation_id}`) possam entrar, ouvir ou transmitir nos canais privados.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'realtime' AND table_name = 'messages'
  ) THEN
    EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';

    -- Leitura (SELECT) em canais Realtime (Broadcast & Presence)
    EXECUTE 'DROP POLICY IF EXISTS "realtime_messages_select_authorized" ON realtime.messages';
    EXECUTE $pol$
      CREATE POLICY "realtime_messages_select_authorized" ON realtime.messages
        FOR SELECT TO authenticated
        USING (
          -- Canal global de presença online/offline/jogando
          realtime.topic() = 'presence:global'
          -- Canal privado de conversa (digitando... e eventos de chat)
          OR (
            realtime.topic() LIKE 'chat:%'
            AND public.is_member( NULLIF(split_part(realtime.topic(), ':', 2), '')::uuid )
          )
          -- Canal privado de sala cooperativa (room:{room_id})
          OR (
            realtime.topic() LIKE 'room:%'
            AND public.is_room_member( NULLIF(split_part(realtime.topic(), ':', 2), '')::uuid )
          )
        )
    $pol$;

    -- Escrita / Transmissão (INSERT) em canais Realtime (Broadcast & Presence)
    EXECUTE 'DROP POLICY IF EXISTS "realtime_messages_insert_authorized" ON realtime.messages';
    EXECUTE $pol$
      CREATE POLICY "realtime_messages_insert_authorized" ON realtime.messages
        FOR INSERT TO authenticated
        WITH CHECK (
          realtime.topic() = 'presence:global'
          OR (
            realtime.topic() LIKE 'chat:%'
            AND public.is_member( NULLIF(split_part(realtime.topic(), ':', 2), '')::uuid )
          )
          OR (
            realtime.topic() LIKE 'room:%'
            AND public.is_room_member( NULLIF(split_part(realtime.topic(), ':', 2), '')::uuid )
          )
        )
    $pol$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Caso o schema `realtime` ainda não esteja inicializado no container local
  NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 3. SUPABASE STORAGE: BUCKETS `emblemas` (PÚBLICO) E `anexos-chat` (PRIVADO)
-- -----------------------------------------------------------------------------

-- 3.1 Bucket público `emblemas` (ícones de grupos, leitura pública, máx 1 MB, png/jpg/webp)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'emblemas',
  'emblemas',
  TRUE,
  1048576, -- 1 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = TRUE,
  file_size_limit = 1048576,
  allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp'];

-- Policies para `emblemas`: leitura pública; upload apenas para líderes/oficiais do grupo na pasta `/{group_id}/{arquivo}`
DROP POLICY IF EXISTS "emblemas_select_public" ON storage.objects;
CREATE POLICY "emblemas_select_public" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'emblemas');

DROP POLICY IF EXISTS "emblemas_insert_group_officer" ON storage.objects;
CREATE POLICY "emblemas_insert_group_officer" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'emblemas'
    AND (storage.foldername(name))[1] IS NOT NULL
    AND public.has_group_role(((storage.foldername(name))[1])::uuid, 'officer')
  );

-- 3.2 Bucket privado `anexos-chat` (imagens até 2 MB, png/jpg/webp, restrito por conversa)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'anexos-chat',
  'anexos-chat',
  FALSE,
  2097152, -- 2 MB
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
  public = FALSE,
  file_size_limit = 2097152,
  allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp'];

-- Estrutura do caminho em `anexos-chat`: `{conversation_id}/{user_id}/{arquivo}`
DROP POLICY IF EXISTS "anexos_chat_select_member" ON storage.objects;
CREATE POLICY "anexos_chat_select_member" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'anexos-chat'
    AND (storage.foldername(name))[1] IS NOT NULL
    AND public.is_member(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "anexos_chat_insert_member" ON storage.objects;
CREATE POLICY "anexos_chat_insert_member" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'anexos-chat'
    AND (storage.foldername(name))[1] IS NOT NULL
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND public.is_member(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "anexos_chat_delete_own_or_mod" ON storage.objects;
CREATE POLICY "anexos_chat_delete_own_or_mod" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'anexos-chat'
    AND (
      (storage.foldername(name))[2] = auth.uid()::text
      OR public.is_moderator()
    )
  );

-- -----------------------------------------------------------------------------
-- 4. FUNÇÕES DE MANUTENÇÃO E AGENDAMENTOS `pg_cron`
-- -----------------------------------------------------------------------------

-- 4.1 Limpeza automática de salas cooperativas abandonadas (> 2 horas)
CREATE OR REPLACE FUNCTION public.limpar_salas_abandonadas()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_affected INTEGER;
BEGIN
  UPDATE public.game_rooms
  SET status = 'abandoned',
      finished_at = NOW(),
      updated_at = NOW()
  WHERE status IN ('waiting', 'playing')
    AND updated_at < (NOW() - INTERVAL '2 hours');

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END;
$$;

-- 4.2 Reinício semanal das metas dos grupos
CREATE OR REPLACE FUNCTION public.reiniciar_metas_semanais_grupos()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_semana DATE := date_trunc('week', CURRENT_DATE)::DATE;
  v_grp RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_grp IN SELECT id FROM public.groups LOOP
    INSERT INTO public.group_goals (group_id, titulo, tipo, meta, progresso, recompensa_moedas, semana)
    VALUES
      (v_grp.id, 'Concluir 35 Missões Diárias em Equipe', 'missoes', 35, 0, 60, v_semana),
      (v_grp.id, 'Derrotar 5 Mecha-Bosses na Cidade',     'bosses',   5, 0, 80, v_semana)
    ON CONFLICT (group_id, semana, tipo) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

-- 4.3 Fechamento de Temporada (Semanal ou Mensal), Gravação de `season_results` e Premiação do Top 3
CREATE OR REPLACE FUNCTION public.fechar_temporada_e_premiar(p_period TEXT DEFAULT 'weekly')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_season RECORD;
  v_new_season RECORD;
  v_winner RECORD;
  v_coins INTEGER;
  v_frame TEXT;
  v_awarded INTEGER := 0;
BEGIN
  PERFORM set_config('app.rpc_authorized', 'true', TRUE);

  SELECT * INTO v_season
  FROM public.seasons
  WHERE period = p_period AND status = 'active'
  ORDER BY starts_at DESC
  LIMIT 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'no_active_season');
  END IF;

  -- Premia os 3 primeiros do ranking principal (missions_week para weekly, xp para monthly)
  FOR v_winner IN
    SELECT posicao, user_id, username, valor
    FROM (
      SELECT posicao, user_id, username, valor::bigint AS valor
      FROM public.v_rank_missions_week
      WHERE p_period = 'weekly' AND valor > 0
      UNION ALL
      SELECT posicao, user_id, username, valor::bigint AS valor
      FROM public.v_rank_xp
      WHERE p_period = 'monthly' AND valor > 0
    ) q
    WHERE posicao <= 3
    ORDER BY posicao ASC
    LIMIT 3
  LOOP
    CASE v_winner.posicao
      WHEN 1 THEN
        v_coins := CASE WHEN p_period = 'monthly' THEN 300 ELSE 120 END;
        v_frame := CASE WHEN p_period = 'monthly' THEN 'frame_champion_gold' ELSE 'frame_weekly_gold' END;
      WHEN 2 THEN
        v_coins := CASE WHEN p_period = 'monthly' THEN 200 ELSE 80 END;
        v_frame := CASE WHEN p_period = 'monthly' THEN 'frame_champion_cyan' ELSE 'frame_weekly_cyan' END;
      ELSE
        v_coins := CASE WHEN p_period = 'monthly' THEN 120 ELSE 50 END;
        v_frame := CASE WHEN p_period = 'monthly' THEN 'frame_champion_lime' ELSE 'frame_weekly_lime' END;
    END CASE;

    INSERT INTO public.season_results (
      season_id, categoria, user_id, posicao, valor_metrica, recompensa
    ) VALUES (
      v_season.id,
      CASE WHEN p_period = 'monthly' THEN 'xp' ELSE 'missions_week' END,
      v_winner.user_id,
      v_winner.posicao,
      v_winner.valor,
      jsonb_build_object('moedas', v_coins, 'moldura', v_frame)
    );

    UPDATE public.profiles
    SET moedas = moedas + v_coins,
        moldura_equipada = COALESCE(moldura_equipada, v_frame),
        molduras_desbloqueadas = CASE
          WHEN NOT (v_frame = ANY(molduras_desbloqueadas))
          THEN array_append(molduras_desbloqueadas, v_frame)
          ELSE molduras_desbloqueadas
        END
    WHERE id = v_winner.user_id;

    INSERT INTO public.notifications (user_id, tipo, titulo, mensagem, payload)
    VALUES (
      v_winner.user_id,
      'season_reward',
      format('🏆 PÓDIO #%s NA TEMPORADA!', v_winner.posicao),
      format('Parabéns! Você conquistou o %sº lugar em "%s" e recebeu +%s Moedas + Moldura Exclusiva (%s)!',
             v_winner.posicao, v_season.titulo, v_coins, v_frame),
      jsonb_build_object('season_id', v_season.id, 'posicao', v_winner.posicao, 'moedas', v_coins, 'moldura', v_frame)
    );

    v_awarded := v_awarded + 1;
  END LOOP;

  -- Fecha a temporada atual
  UPDATE public.seasons
  SET status = 'closed', ends_at = NOW()
  WHERE id = v_season.id;

  -- Abre imediatamente a próxima temporada
  IF p_period = 'monthly' THEN
    INSERT INTO public.seasons (period, titulo, starts_at, ends_at, status)
    VALUES (
      'monthly',
      'TEMPORADA NEON ' || to_char(NOW(), 'YYYY-MM'),
      date_trunc('month', NOW()),
      date_trunc('month', NOW()) + INTERVAL '1 month',
      'active'
    )
    RETURNING * INTO v_new_season;
  ELSE
    INSERT INTO public.seasons (period, titulo, starts_at, ends_at, status)
    VALUES (
      'weekly',
      'OPERAÇÃO SEMANAL #' || to_char(NOW(), 'IYYY-IW'),
      date_trunc('week', NOW()),
      date_trunc('week', NOW()) + INTERVAL '7 days',
      'active'
    )
    RETURNING * INTO v_new_season;
  END IF;

  RETURN jsonb_build_object(
    'closed_season_id', v_season.id,
    'new_season_id', v_new_season.id,
    'awarded_players', v_awarded
  );
END;
$$;

-- 4.4 Registro idempotente dos agendamentos no `pg_cron` (se a extensão estiver habilitada no projeto)
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;

  -- 1. Limpeza de salas abandonadas (> 2h) a cada 30 minutos
  PERFORM cron.schedule(
    'limpar-salas-abandonadas',
    '*/30 * * * *',
    $cron$SELECT public.limpar_salas_abandonadas();$cron$
  );

  -- 2. Reinício semanal dos rankings e metas de grupo (Toda segunda-feira às 00:05 UTC)
  PERFORM cron.schedule(
    'reinicio-semanal-rankings-e-metas',
    '5 0 * * 1',
    $cron$SELECT public.fechar_temporada_e_premiar('weekly'); SELECT public.reiniciar_metas_semanais_grupos();$cron$
  );

  -- 3. Reinício mensal dos rankings (Dia 1 de cada mês às 00:10 UTC)
  PERFORM cron.schedule(
    'reinicio-mensal-rankings',
    '10 0 1 * *',
    $cron$SELECT public.fechar_temporada_e_premiar('monthly');$cron$
  );
EXCEPTION WHEN OTHERS THEN
  -- Caso `pg_cron` ainda precise ser habilitado manualmente em Database > Extensions no Dashboard
  RAISE NOTICE 'Extensão pg_cron não ativa no momento. Ative-a em Database > Extensions para habilitar os agendamentos.';
END $$;
