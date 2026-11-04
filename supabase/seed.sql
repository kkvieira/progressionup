-- =============================================================================
-- SEED DATA (`supabase/seed.sql`) — DADOS DE TESTE PARA AMBIENTE LOCAL / DEMO
-- =============================================================================
-- Cria:
-- 1. 4 Agentes de teste em `auth.users`, `profiles` e `characters`:
--    - Agente 1: `kira_neon`   (UUID: 11111111-1111-4111-8111-111111111111)
--    - Agente 2: `vance_cyber` (UUID: 22222222-2222-4222-8222-222222222222)
--    - Agente 3: `nyx_shadow`  (UUID: 33333333-3333-4333-8333-333333333333)
--    - Agente 4: `orion_ghost` (UUID: 44444444-4444-4444-8444-444444444444, perfil privado)
-- 2. Amizades (`friendships`) entre Kira e Vance
-- 3. Esquadrão inicial `ESQUADRAO OMEGA` (`groups`, `group_members`, `group_goals`)
-- 4. Conversas e mensagens iniciais no canal Global e no chat do Esquadrão
-- 5. Partidas de exemplo (`game_runs`) e logs (`task_logs`) para popular os 6 rankings
-- =============================================================================

BEGIN;

-- 1. Usuários de teste em `auth.users`
INSERT INTO auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'kira@cyber.local', crypt('SenhaForte123', gen_salt('bf')),
    NOW(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"username":"kira_neon"}'::jsonb, NOW(), NOW()
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'vance@cyber.local', crypt('SenhaForte123', gen_salt('bf')),
    NOW(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"username":"vance_cyber"}'::jsonb, NOW(), NOW()
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'nyx@cyber.local', crypt('SenhaForte123', gen_salt('bf')),
    NOW(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"username":"nyx_shadow"}'::jsonb, NOW(), NOW()
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    'orion@cyber.local', crypt('SenhaForte123', gen_salt('bf')),
    NOW(), '{"provider":"email","providers":["email"]}'::jsonb,
    '{"username":"orion_ghost"}'::jsonb, NOW(), NOW()
  )
ON CONFLICT (id) DO NOTHING;

-- 2. Atualiza perfis com estatísticas variadas e configurações de privacidade
SELECT set_config('app.rpc_authorized', 'true', TRUE);

UPDATE public.profiles SET
  username = 'kira_neon',
  level = 9,
  xp_total = 2450,
  xp_nivel_atual = 180,
  streak_atual = 12,
  maior_streak = 18,
  ultima_data_streak = CURRENT_DATE,
  moedas = 420,
  fichas = 6,
  privacy = 'publico',
  moldura_equipada = 'frame_champion_gold',
  molduras_desbloqueadas = ARRAY['frame_champion_gold', 'frame_weekly_cyan'],
  bio = 'Líder do Esquadrão Ômega • Caçadora de Mechas.'
WHERE id = '11111111-1111-4111-8111-111111111111';

UPDATE public.profiles SET
  username = 'vance_cyber',
  level = 7,
  xp_total = 1680,
  xp_nivel_atual = 90,
  streak_atual = 8,
  maior_streak = 10,
  ultima_data_streak = CURRENT_DATE,
  moedas = 280,
  fichas = 4,
  privacy = 'publico',
  moldura_equipada = 'frame_weekly_cyan',
  molduras_desbloqueadas = ARRAY['frame_weekly_cyan'],
  bio = 'Atirador tático das docas neon.'
WHERE id = '22222222-2222-4222-8222-222222222222';

UPDATE public.profiles SET
  username = 'nyx_shadow',
  level = 6,
  xp_total = 1210,
  xp_nivel_atual = 45,
  streak_atual = 5,
  maior_streak = 7,
  ultima_data_streak = CURRENT_DATE,
  moedas = 190,
  fichas = 3,
  privacy = 'amigos',
  bio = 'Especialista em infiltração furtiva.'
WHERE id = '33333333-3333-4333-8333-333333333333';

UPDATE public.profiles SET
  username = 'orion_ghost',
  level = 4,
  xp_total = 590,
  xp_nivel_atual = 30,
  streak_atual = 2,
  maior_streak = 4,
  ultima_data_streak = CURRENT_DATE,
  moedas = 95,
  fichas = 2,
  privacy = 'privado',
  bio = 'Operador fantasma (perfil privado).'
WHERE id = '44444444-4444-4444-8444-444444444444';

-- 3. Personagens 16x16 dos agentes de teste
INSERT INTO public.characters (
  user_id, nome, genero, cor_pele, cabelo, cor_cabelo, roupa, cor_roupa, classe, arma, nivel_arma
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Kira',  'f', 1, 'rabo',    8, 'cyber_agente',   1, 'ladino',     'adagas',       1),
  ('22222222-2222-4222-8222-222222222222', 'Vance', 'm', 3, 'moicano', 7, 'armadura_leve',  0, 'cacador',    'besta',        1),
  ('33333333-3333-4333-8333-333333333333', 'Nyx',   'f', 2, 'chanel',  9, 'manto',          5, 'necromante', 'omoplata',     1),
  ('44444444-4444-4444-8444-444444444444', 'Orion', 'm', 4, 'curto',   0, 'ninja',          9, 'monge',      'manoplas',     0)
ON CONFLICT (user_id) DO NOTHING;

-- 4. Papel de moderador para `kira_neon`
INSERT INTO public.user_roles (user_id, role)
VALUES ('11111111-1111-4111-8111-111111111111', 'moderator')
ON CONFLICT (user_id, role) DO NOTHING;

-- 5. Amizade aceita entre Kira e Vance + pedido pendente de Nyx para Kira
INSERT INTO public.friendships (id, requester_id, addressee_id, status)
VALUES
  ('aaaaaaaa-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'accepted'),
  ('aaaaaaaa-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'pending')
ON CONFLICT DO NOTHING;

-- 6. Grupo / Esquadrão Inicial: ESQUADRÃO ÔMEGA
INSERT INTO public.groups (
  id, nome, tag, descricao, emblema, codigo, join_type, max_members, owner_id, xp_total_grupo
) VALUES (
  'bbbbbbbb-1111-4111-8111-111111111111',
  'ESQUADRÃO ÔMEGA',
  'OMEGA',
  'Unidade tática de elite para operações cooperativas noturnas na Cidade.',
  'shield_cyan',
  'OMEGA777',
  'open',
  30,
  '11111111-1111-4111-8111-111111111111',
  4130
)
ON CONFLICT (nome) DO NOTHING;

INSERT INTO public.group_members (group_id, user_id, role, xp_contribuido)
VALUES
  ('bbbbbbbb-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'leader',  2450),
  ('bbbbbbbb-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'officer', 1680)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.group_goals (group_id, titulo, tipo, meta, progresso, recompensa_moedas, semana)
VALUES
  ('bbbbbbbb-1111-4111-8111-111111111111', 'Concluir 35 Missões Diárias em Equipe', 'missoes', 35, 14, 60, date_trunc('week', CURRENT_DATE)::DATE),
  ('bbbbbbbb-1111-4111-8111-111111111111', 'Derrotar 5 Mecha-Bosses na Cidade',     'bosses',   5,  3, 80, date_trunc('week', CURRENT_DATE)::DATE)
ON CONFLICT (group_id, semana, tipo) DO NOTHING;

-- 7. Conversa do Esquadrão Ômega e mensagens iniciais no Chat Global
INSERT INTO public.conversations (id, tipo, group_id, titulo)
VALUES ('cccccccc-1111-4111-8111-111111111111', 'group', 'bbbbbbbb-1111-4111-8111-111111111111', 'CHAT DO ESQUADRÃO [OMEGA]')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.conversation_members (conversation_id, user_id)
VALUES
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111'),
  ('00000000-0000-0000-0000-000000000001', '22222222-2222-4222-8222-222222222222'),
  ('00000000-0000-0000-0000-000000000001', '33333333-3333-4333-8333-333333333333'),
  ('cccccccc-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'),
  ('cccccccc-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222')
ON CONFLICT (conversation_id, user_id) DO NOTHING;

INSERT INTO public.messages (conversation_id, sender_id, content, is_system)
VALUES
  ('00000000-0000-0000-0000-000000000001', '11111111-1111-4111-8111-111111111111', 'Rede Global de Agentes ativa! Quem topa raid cooperativa contra o Mecha-CEO hoje?', FALSE),
  ('00000000-0000-0000-0000-000000000001', '22222222-2222-4222-8222-222222222222', 'Pronto na frequência! Já concluí minhas missões diárias para liberar fichas.', FALSE),
  ('cccccccc-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '⚡ ESQUADRÃO [OMEGA] FUNDADO! Faltam 2 bosses para batermos a meta semanal!', TRUE);

-- 8. Partidas registradas (`game_runs`) para alimentar os rankings de Distância e Bosses
INSERT INTO public.game_runs (user_id, distancia, inimigos_derrotados, boss_vencido, sem_dano, xp_ganho, moedas_ganhas, duracao)
VALUES
  ('11111111-1111-4111-8111-111111111111', 640, 42, TRUE,  TRUE,  45, 95, 185),
  ('11111111-1111-4111-8111-111111111111', 590, 38, TRUE,  FALSE, 40, 80, 170),
  ('22222222-2222-4222-8222-222222222222', 520, 31, TRUE,  FALSE, 38, 70, 160),
  ('33333333-3333-4333-8333-333333333333', 410, 24, FALSE, FALSE, 28, 45, 130);

COMMIT;
