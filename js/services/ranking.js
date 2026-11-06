// @ts-check
/* =====================================================================
   SERVIÇO DE RANKINGS E TEMPORADAS (`services/ranking.js`)
   ---------------------------------------------------------------------
   - Consulta as 6 categorias de ranking com `RANK() OVER (...)`:
     1) `xp`            -> `v_rank_xp` (XP Total)
     2) `streak`        -> `v_rank_streak` (Sequência de Dias)
     3) `missions_week` -> `v_rank_missions_week` (Missões na Semana)
     4) `distance`      -> `v_rank_distance` (Maior Distância na Cidade)
     5) `bosses`        -> `v_rank_bosses` (Mecha-Bosses Derrotados)
     6) `groups`        -> `v_rank_groups` (Esquadrões / Clãs)
   - Chama as RPCs `obter_ranking(categoria, periodo, limite, offset)` e
     `minha_posicao(categoria, periodo)`
   - Consulta histórico de pódios e recompensas (`season_results`)
   ===================================================================== */

/**
 * @typedef {'xp' | 'streak' | 'missions_week' | 'distance' | 'bosses' | 'groups'} RankingCategory
 * @typedef {'weekly' | 'monthly' | 'all'} RankingPeriod
 */

(function initRankingService() {
  function getClient() {
    return window.SB.requireClient();
  }

  function handleErr(err) {
    throw new Error(window.SB.translateError(err));
  }

  const rankingService = {
    CATEGORIES: [
      { id: 'xp',            label: 'XP TOTAL',         unit: 'XP' },
      { id: 'missions_week', label: 'MISSÕES (SEMANA)', unit: 'MISSÕES' },
      { id: 'streak',        label: 'SEQUÊNCIA',        unit: 'DIAS' },
      { id: 'distance',      label: 'DISTÂNCIA CIDADE', unit: 'm' },
      { id: 'bosses',        label: 'BOSSES ABATIDOS',  unit: 'BOSSES' },
      { id: 'groups',        label: 'ESQUADRÕES',       unit: 'XP CLÃ' }
    ],

    /**
     * Obtém a lista de classificação para a categoria e período informados,
     * juntamente com a posição individual do agente logado.
     * @param {{ categoria?: RankingCategory, periodo?: RankingPeriod, limite?: number, offset?: number }} [params]
     */
    async carregarRankingCompleto({ categoria = 'xp', periodo = 'weekly', limite = 25, offset = 0 } = {}) {
      const sb = getClient();

      const [rankRes, myPosRes] = await Promise.all([
        sb.rpc('obter_ranking', {
          p_categoria: categoria,
          p_periodo: periodo,
          p_limite: limite,
          p_offset: offset
        }),
        sb.rpc('minha_posicao', {
          p_categoria: categoria,
          p_periodo: periodo
        })
      ]);

      if (rankRes.error) handleErr(rankRes.error);
      if (myPosRes.error) handleErr(myPosRes.error);

      return {
        categoria,
        periodo,
        season: rankRes.data?.season || null,
        items: rankRes.data?.items || [],
        minhaPosicao: myPosRes.data || { posicao: null, valor: 0 }
      };
    },

    /**
     * Lista os últimos resultados fechados de temporadas (`season_results`) e suas recompensas.
     * @param {number} [limite=10]
     */
    async listarHistoricoTemporadas(limite = 10) {
      const sb = getClient();
      const { data, error } = await sb
        .from('season_results')
        .select('*, seasons(titulo, period, starts_at, ends_at)')
        .order('created_at', { ascending: false })
        .limit(limite);

      if (error) handleErr(error);
      return data || [];
    }
  };

  window.SB = window.SB || {};
  window.SB.services = window.SB.services || {};
  window.SB.services.ranking = rankingService;
  window.SB.ranking = rankingService;
})();
