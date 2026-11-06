-- =============================================================================
-- MIGRAÇÃO 007: VIEWS DE RANKING RESPEITAM AS REGRAS (RLS) DE QUEM CONSULTA
-- =============================================================================
-- Corrige o alerta "Security Definer View" do Supabase nas views de ranking.
-- O ranking continua completo porque é lido pelas funções obter_ranking() e
-- minha_posicao(), que rodam no servidor com permissão própria.
-- A view public_profiles fica como está de propósito: ela já esconde e-mail,
-- diário e dados de perfis privados, e precisa mostrar o nome de amigos.
-- =============================================================================
ALTER VIEW public.v_rank_xp            SET (security_invoker = true);
ALTER VIEW public.v_rank_streak        SET (security_invoker = true);
ALTER VIEW public.v_rank_missions_week SET (security_invoker = true);
ALTER VIEW public.v_rank_distance      SET (security_invoker = true);
ALTER VIEW public.v_rank_bosses        SET (security_invoker = true);
ALTER VIEW public.v_rank_groups        SET (security_invoker = true);
