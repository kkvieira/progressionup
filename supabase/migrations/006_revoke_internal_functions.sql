-- =============================================================================
-- MIGRAÇÃO 006: FECHA FUNÇÕES INTERNAS PARA O PÚBLICO
-- =============================================================================
-- Funções usadas apenas por triggers e pelo pg_cron não devem ser chamadas
-- pelo navegador (/rest/v1/rpc/...). Sem isso, qualquer jogador logado poderia,
-- por exemplo, encerrar a temporada e distribuir prêmios ou inflar metas de grupo.
-- Triggers e cron continuam funcionando (rodam como dono da função).
-- Também remove o acesso do papel `anon` (visitante não logado) às RPCs sociais.
-- =============================================================================

-- 1. Funções exclusivamente internas: ninguém de fora pode chamar
REVOKE EXECUTE ON FUNCTION public.contribuir_meta_grupo(uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fechar_temporada_e_premiar(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reiniciar_metas_semanais_grupos() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.limpar_salas_abandonadas() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_fn_game_run_group_contribution() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_fn_profile_levelup_social() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.trg_fn_task_log_group_contribution() FROM PUBLIC, anon, authenticated;

-- 2. RPCs sociais: só jogadores logados
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.abrir_ou_criar_dm(uuid)',
    'public.are_friends(uuid, uuid)',
    'public.bloquear(uuid)',
    'public.convidar_para_grupo(text)',
    'public.criar_grupo(text, text, text, text, text, text)',
    'public.criar_sala(integer)',
    'public.denunciar_conteudo(uuid, uuid, uuid, text)',
    'public.desbloquear(uuid)',
    'public.entrar_grupo(text)',
    'public.entrar_sala(text)',
    'public.enviar_mensagem(uuid, text, text)',
    'public.enviar_pedido_amizade(text)',
    'public.expulsar(uuid)',
    'public.finalizar_partida_coop(uuid, jsonb)',
    'public.has_group_role(uuid, text)',
    'public.iniciar_sala(uuid)',
    'public.is_blocked_between(uuid, uuid)',
    'public.is_member(uuid)',
    'public.is_moderator(uuid)',
    'public.is_room_member(uuid)',
    'public.marcar_conversa_lida(uuid)',
    'public.minha_posicao(text, text)',
    'public.obter_ranking(text, text, integer, integer)',
    'public.promover(uuid, text)',
    'public.responder_pedido(uuid, boolean)',
    'public.sair_grupo()'
  ] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END $$;
