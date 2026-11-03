/* =====================================================================
   Sistema de Missões — MÓDULO SUPABASE (Auth, Perfil, Tarefas, Registros, Jogo)
   ---------------------------------------------------------------------
   - Usa o cliente oficial `@supabase/supabase-js` v2
   - Fluxo OAuth 2.0 / OpenID Connect: Authorization Code com PKCE (`flowType: 'pkce'`)
   - Sessão persistente com renovação automática de JWT + Refresh Token
   - Tradução completa de erros para Português (PT-BR)
   - Upload seguro para bucket privado `registros` (máx 5MB, png/jpg/webp)
     e geração de URLs assinadas (Signed URLs)
   - Assinatura Realtime na tabela `profiles` para atualizar XP/Nível no topo
   ===================================================================== */

const SUPABASE_MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB
const SUPABASE_ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

/* ---------------------------------------------------------------------
   1. TRADUTOR DE ERROS DO SUPABASE / POSTGRESQL PARA PORTUGUÊS
   --------------------------------------------------------------------- */
function translateSupabaseError(err) {
  if (!err) return 'Ocorreu um erro desconhecido.';
  const raw = typeof err === 'string' ? err : (err.message || err.error_description || err.details || '');
  const m = raw.toLowerCase();

  if (!navigator.onLine || m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed')) {
    return 'SEM CONEXÃO COM O SERVIDOR. VERIFIQUE SUA INTERNET E TENTE NOVAMENTE.';
  }
  if (m.includes('invalid login credentials') || m.includes('invalid_grant')) {
    return 'CREDENCIAIS INVÁLIDAS: E-MAIL OU SENHA INCORRETOS.';
  }
  if (m.includes('user already registered') || m.includes('already been registered') || m.includes('email_exists')) {
    return 'ESTE E-MAIL JÁ ESTÁ CADASTRADO. FAÇA LOGIN OU RECUPERE SUA SENHA.';
  }
  if (m.includes('email not confirmed')) {
    return 'E-MAIL AINDA NÃO CONFIRMADO. VERIFIQUE SUA CAIXA DE ENTRADA (E SPAM).';
  }
  if (m.includes('password should be at least') || m.includes('weak_password')) {
    return 'A SENHA É MUITO FRACA. USE NO MÍNIMO 8 CARACTERES.';
  }
  if (m.includes('rate limit') || m.includes('too many requests') || m.includes('over_email_send_rate_limit')) {
    return 'MUITAS TENTATIVAS EM POUCO TEMPO. AGUARDE ALGUNS MINUTOS E TENTE NOVAMENTE.';
  }
  if (m.includes('provider is not enabled') || m.includes('unsupported provider')) {
    return 'PROVEDOR SOCIAL INDISPONÍVEL OU NÃO ATIVADO NO PAINEL DO SUPABASE.';
  }
  if (m.includes('jwt expired') || m.includes('session_not_found') || m.includes('refresh_token_not_found') || m.includes('nao_autenticado')) {
    return 'SUA SESSÃO EXPIROU. FAÇA LOGIN NOVAMENTE.';
  }
  if (m.includes('limite_tarefas_atingido')) {
    return 'LIMITE DE 15 MISSÕES ATIVAS ATINGIDO!';
  }
  if (m.includes('ja_concluida_hoje') || m.includes('uq_task_logs_task_day')) {
    return 'ESTA MISSÃO JÁ FOI CONCLUÍDA HOJE (LIMITE DE 1 POR DIA).';
  }
  if (m.includes('prova_obrigatoria') || m.includes('chk_task_logs_desc_or_photo')) {
    return 'É OBRIGATÓRIO ENVIAR UMA DESCRIÇÃO OU FOTO COMO PROVA.';
  }
  if (m.includes('sem_fichas')) {
    return 'VOCÊ NÃO TEM FICHAS DE ENTRADA SUFICIENTES. CONCLUA MISSÕES DIÁRIAS!';
  }
  if (m.includes('moedas_insuficientes')) {
    return 'MOEDAS CYBER INSUFICIENTES PARA ESTA COMPRA.';
  }
  if (m.includes('profiles_username_key') || (m.includes('duplicate key') && m.includes('username'))) {
    return 'ESTE NOME DE USUÁRIO JÁ ESTÁ EM USO POR OUTRO AGENTE.';
  }
  if (m.includes('identity_already_exists') || m.includes('manual linking is disabled')) {
    return 'NÃO FOI POSSÍVEL VINCULAR A IDENTIDADE. VERIFIQUE SE O MANUAL LINKING ESTÁ ATIVO NO SUPABASE.';
  }
  return raw.toUpperCase();
}

/* ---------------------------------------------------------------------
   2. INICIALIZAÇÃO DO CLIENTE SUPABASE COM FLUXO PKCE E AUTO-REFRESH
   --------------------------------------------------------------------- */
function normalizeSupabaseUrl(rawUrl) {
  if (!rawUrl) return '';
  return rawUrl
    .trim()
    .replace(/\/auth\/v1\/callback\/?$/i, '')
    .replace(/\/+$/, '');
}

function isValidSupabasePublicKey(key) {
  if (!key || typeof key !== 'string') return false;
  const k = key.trim();
  return k.startsWith('eyJ') || k.startsWith('sb_publishable_');
}

function getSupabaseConfig() {
  const env = window.__ENV__ || {};
  const envUrl = normalizeSupabaseUrl(env.SUPABASE_URL || '');
  const envKey = (env.SUPABASE_ANON_KEY || '').trim();

  // Se o js/env.js já possui a chave oficial do projeto configurada, limpa chaves inválidas salvas no localStorage
  if (envUrl && isValidSupabasePublicKey(envKey) && !envUrl.includes('SEU-PROJETO-ID')) {
    const lsKey = (localStorage.getItem('sistemaMissoes.supabaseAnonKey') || '').trim();
    if (lsKey && !isValidSupabasePublicKey(lsKey)) {
      localStorage.removeItem('sistemaMissoes.supabaseUrl');
      localStorage.removeItem('sistemaMissoes.supabaseAnonKey');
    }
    return { url: envUrl, anonKey: envKey, isConfigured: true };
  }

  const lsUrl = normalizeSupabaseUrl(localStorage.getItem('sistemaMissoes.supabaseUrl') || '');
  const lsKey = (localStorage.getItem('sistemaMissoes.supabaseAnonKey') || '').trim();
  const url = lsUrl || envUrl;
  const anonKey = isValidSupabasePublicKey(lsKey) ? lsKey : envKey;

  const isConfigured =
    Boolean(url && isValidSupabasePublicKey(anonKey)) &&
    !url.includes('SEU-PROJETO-ID') &&
    !anonKey.includes('SUA_SUPABASE_ANON_KEY') &&
    url.startsWith('http');
  return { url, anonKey, isConfigured };
}

let supabaseClient = null;
let realtimeChannel = null;

function initSupabaseClient() {
  const { url, anonKey, isConfigured } = getSupabaseConfig();
  if (!isConfigured || !window.supabase || typeof window.supabase.createClient !== 'function') {
    supabaseClient = null;
    return null;
  }

  supabaseClient = window.supabase.createClient(url, anonKey, {
    auth: {
      flowType: 'pkce',               // Fluxo OAuth 2.0 Authorization Code com PKCE
      autoRefreshToken: true,         // Renovação automática de JWT via Refresh Token
      persistSession: true,           // Sessão persistente
      detectSessionInUrl: true,       // Captura código `?code=` do retorno OAuth/confirmação
      storageKey: 'sistemaMissoes.supabase.auth.token'
    }
  });

  return supabaseClient;
}

function requireClient() {
  if (!navigator.onLine) {
    throw new Error('Failed to fetch');
  }
  if (!supabaseClient) {
    initSupabaseClient();
  }
  if (!supabaseClient) {
    throw new Error('SUPABASE NÃO CONFIGURADO. DEFINA A URL E ANON KEY DO PROJETO.');
  }
  return supabaseClient;
}

/* ---------------------------------------------------------------------
   3. MÓDULO AUTH (E-mail/Senha, OAuth PKCE, Identidades, Sessão)
   --------------------------------------------------------------------- */
const authApi = {
  /** Valida senha forte (mínimo 8 caracteres) */
  validatePassword(password) {
    if (!password || password.length < 8) {
      return { valid: false, message: 'A SENHA DEVE TER NO MÍNIMO 8 CARACTERES.' };
    }
    return { valid: true, message: 'SENHA VÁLIDA.' };
  },

  /** Cadastro com e-mail, senha e nome de usuário opcional (envia confirmação por e-mail) */
  async signUp(email, password, username = '') {
    const check = this.validatePassword(password);
    if (!check.valid) throw new Error(check.message);
    const sb = requireClient();
    const redirectTo = window.location.origin + window.location.pathname;
    const { data, error } = await sb.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: redirectTo,
        data: username ? { username: username.trim() } : {}
      }
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Login com e-mail e senha */
  async signIn(email, password) {
    const sb = requireClient();
    const { data, error } = await sb.auth.signInWithPassword({
      email: email.trim(),
      password
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /**
   * Verifica no endpoint público /auth/v1/settings se o provedor OAuth
   * está habilitado no painel do Supabase antes de redirecionar a aba,
   * evitando que o navegador caia em uma tela JSON 400 bruta.
   */
  async ensureProviderEnabled(provider) {
    const cfg = getSupabaseConfig();
    if (!cfg.isConfigured) return;
    try {
      const res = await fetch(`${cfg.url}/auth/v1/settings`, {
        headers: { apikey: cfg.anonKey }
      });
      if (!res.ok) return;
      const settings = await res.json();
      if (settings?.external && settings.external[provider] === false) {
        const label = provider.toUpperCase();
        throw new Error(
          `PROVEDOR ${label} AINDA NÃO ATIVADO NO PAINEL DO SUPABASE (AUTHENTICATION > PROVIDERS). ATIVE-O NO PAINEL OU ENTRE COM E-MAIL E SENHA.`
        );
      }
    } catch (err) {
      if (err.message?.includes('AINDA NÃO ATIVADO')) throw err;
      // Em caso de falha de rede ao checar settings, segue o fluxo padrão
    }
  },

  /**
   * Login Social via OAuth 2.0 / OpenID Connect com PKCE.
   * Suporta: 'google', 'discord', 'github', 'apple' e futuros provedores.
   */
  async signInWithOAuth(provider) {
    const sb = requireClient();
    await this.ensureProviderEnabled(provider);
    const redirectTo = window.location.origin + window.location.pathname;
    const { data, error } = await sb.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
        queryParams: provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : undefined
      }
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Envia e-mail de recuperação de senha */
  async resetPasswordForEmail(email) {
    const sb = requireClient();
    const redirectTo = window.location.origin + window.location.pathname;
    const { data, error } = await sb.auth.resetPasswordForEmail(email.trim(), {
      redirectTo
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Atualiza a senha do usuário autenticado */
  async updatePassword(newPassword) {
    const check = this.validatePassword(newPassword);
    if (!check.valid) throw new Error(check.message);
    const sb = requireClient();
    const { data, error } = await sb.auth.updateUser({ password: newPassword });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Obtém a sessão atual */
  async getSession() {
    if (!supabaseClient && !initSupabaseClient()) return null;
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw new Error(translateSupabaseError(error));
    return data.session;
  },

  /** Obtém o usuário autenticado e suas identidades vinculadas */
  async getUser() {
    const sb = requireClient();
    const { data, error } = await sb.auth.getUser();
    if (error) throw new Error(translateSupabaseError(error));
    return data.user;
  },

  /** Lista identidades OAuth/e-mail conectadas à conta atual */
  async getIdentities() {
    const sb = requireClient();
    if (typeof sb.auth.getUserIdentities === 'function') {
      const { data, error } = await sb.auth.getUserIdentities();
      if (error) throw new Error(translateSupabaseError(error));
      return data?.identities || [];
    }
    const user = await this.getUser();
    return user?.identities || [];
  },

  /** Vincula um novo provedor OAuth (Google, Discord, GitHub, etc.) à mesma conta logada */
  async linkIdentity(provider) {
    const sb = requireClient();
    await this.ensureProviderEnabled(provider);
    const redirectTo = window.location.origin + window.location.pathname;
    const { data, error } = await sb.auth.linkIdentity({
      provider,
      options: { redirectTo }
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Desvincula uma identidade OAuth (desde que o usuário mantenha ao menos 1 método de entrada) */
  async unlinkIdentity(identity) {
    const sb = requireClient();
    const { data, error } = await sb.auth.unlinkIdentity(identity);
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Encerra a sessão (Logout) */
  async signOut() {
    if (realtimeChannel && supabaseClient) {
      supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    if (!supabaseClient) return;
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw new Error(translateSupabaseError(error));
  },

  /** Escuta mudanças de estado de autenticação (login, logout, token refresh, password recovery) */
  onAuthStateChange(callback) {
    if (!supabaseClient && !initSupabaseClient()) return { data: { subscription: { unsubscribe() {} } } };
    return supabaseClient.auth.onAuthStateChange(callback);
  }
};

/* ---------------------------------------------------------------------
   4. MÓDULO PERFIL E PERSONAGEM (profiles, characters, achievements, realtime)
   --------------------------------------------------------------------- */
const perfilApi = {
  /** Registra acesso do dia (RPC), valida streak e retorna o profile atualizado */
  async registrarAcessoDiario() {
    const sb = requireClient();
    const { data, error } = await sb.rpc('registrar_acesso_diario');
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Busca profile, character, conquistas e inventário do usuário */
  async carregarDadosCompletos(userId) {
    const sb = requireClient();
    const [profRes, charRes, achCatRes, userAchRes, invRes, runsRes] = await Promise.all([
      sb.from('profiles').select('*').eq('id', userId).maybeSingle(),
      sb.from('characters').select('*').eq('user_id', userId).maybeSingle(),
      sb.from('achievements').select('*'),
      sb.from('user_achievements').select('*, achievements(code, diaria)').eq('user_id', userId),
      sb.from('inventory').select('*').eq('user_id', userId),
      sb.from('game_runs').select('distancia, inimigos_derrotados, boss_vencido, sem_dano').eq('user_id', userId)
    ]);

    if (profRes.error) throw new Error(translateSupabaseError(profRes.error));
    if (charRes.error) throw new Error(translateSupabaseError(charRes.error));

    return {
      profile: profRes.data,
      character: charRes.data,
      achievementsCatalog: achCatRes.data || [],
      userAchievements: userAchRes.data || [],
      inventory: invRes.data || [],
      gameRuns: runsRes.data || []
    };
  },

  /** Cria ou atualiza o personagem pixel art (tabela `characters`) */
  async salvarPersonagem(userId, charData, currentLevel = 1) {
    const sb = requireClient();
    const weaponTier = Math.min(4, Math.floor((currentLevel || 1) / 5));
    const payload = {
      user_id: userId,
      nome: charData.nome.trim().slice(0, 16),
      genero: charData.genero || 'f',
      cor_pele: Number(charData.pele ?? 1),
      cabelo: charData.cabelo || 'longo',
      cor_cabelo: Number(charData.corCabelo ?? 1),
      roupa: charData.roupa || 'viajante',
      cor_roupa: Number(charData.corRoupa ?? 0),
      classe: charData.classe || 'guerreiro',
      arma: charData.arma || 'espada_longa',
      nivel_arma: weaponTier
    };

    const { data, error } = await sb
      .from('characters')
      .upsert(payload, { onConflict: 'user_id' })
      .select()
      .single();

    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Atualiza o nome de usuário (`username`) na tabela `profiles` */
  async atualizarUsername(userId, novoUsername) {
    const clean = novoUsername.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (clean.length < 3 || clean.length > 24) {
      throw new Error('O NOME DE USUÁRIO DEVE TER ENTRE 3 E 24 CARACTERES (LETRAS, NÚMEROS OU _).');
    }
    const sb = requireClient();
    const { data, error } = await sb
      .from('profiles')
      .update({ username: clean })
      .eq('id', userId)
      .select()
      .single();

    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Importa dados existentes do localStorage na primeira vez (RPC) */
  async importarDadosLocais(localState) {
    const sb = requireClient();
    const { data, error } = await sb.rpc('importar_dados_locais', {
      p_payload: localState
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Exclui permanentemente a conta do usuário e todos os seus dados/fotos via Edge Function `delete-account` */
  async excluirMinhaConta() {
    const sb = requireClient();
    const { data, error } = await sb.functions.invoke('delete-account', {
      method: 'POST'
    });
    if (error) throw new Error(translateSupabaseError(error));
    await authApi.signOut();
    return data;
  },

  /** Inscreve-se em atualizações em tempo real (Realtime) da tabela `profiles` */
  assinarRealtimePerfil(userId, onProfileChange) {
    if (!supabaseClient) return null;
    if (realtimeChannel) {
      supabaseClient.removeChannel(realtimeChannel);
      realtimeChannel = null;
    }
    realtimeChannel = supabaseClient
      .channel(`public:profiles:id=eq.${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        payload => {
          if (payload?.new && typeof onProfileChange === 'function') {
            onProfileChange(payload.new);
          }
        }
      )
      .subscribe();
    return realtimeChannel;
  }
};

/* ---------------------------------------------------------------------
   5. MÓDULO TAREFAS (CRUD em `tasks` com limite de 15 ativas no banco)
   --------------------------------------------------------------------- */
const tarefasApi = {
  /** Lista todas as tarefas ativas do usuário */
  async listarAtivas(userId) {
    const sb = requireClient();
    const { data, error } = await sb
      .from('tasks')
      .select('*')
      .eq('user_id', userId)
      .eq('ativa', true)
      .order('created_at', { ascending: true });

    if (error) throw new Error(translateSupabaseError(error));
    return data || [];
  },

  /** Cria uma nova tarefa (o trigger no PostgreSQL valida o limite de 15 ativas) */
  async criar(userId, { name, difficulty, category }) {
    const sb = requireClient();
    const { data, error } = await sb
      .from('tasks')
      .insert({
        user_id: userId,
        nome: name.trim().slice(0, 60),
        dificuldade: difficulty,
        categoria: category || '',
        ativa: true
      })
      .select()
      .single();

    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Atualiza nome, dificuldade ou categoria de uma tarefa existente */
  async atualizar(userId, taskId, { name, difficulty, category }) {
    const sb = requireClient();
    const { data, error } = await sb
      .from('tasks')
      .update({
        nome: name.trim().slice(0, 60),
        dificuldade: difficulty,
        categoria: category || ''
      })
      .eq('id', taskId)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Desativa (`ativa = false`) uma tarefa mantendo o histórico de registros no diário */
  async excluir(userId, taskId) {
    const sb = requireClient();
    const { error } = await sb
      .from('tasks')
      .update({ ativa: false })
      .eq('id', taskId)
      .eq('user_id', userId);

    if (error) throw new Error(translateSupabaseError(error));
    return true;
  }
};

/* ---------------------------------------------------------------------
   6. MÓDULO REGISTROS E STORAGE (`task_logs` + bucket privado `registros`)
   --------------------------------------------------------------------- */
const registrosApi = {
  /** Valida arquivo de foto (PNG, JPG ou WEBP, máx 5 MB) */
  validarArquivoFoto(file) {
    if (!file) return { valid: false, message: 'NENHUM ARQUIVO SELECIONADO.' };
    if (!SUPABASE_ALLOWED_MIME.includes(file.type)) {
      return { valid: false, message: 'FORMATO INVÁLIDO! USE APENAS IMAGENS PNG, JPG OU WEBP.' };
    }
    if (file.size > SUPABASE_MAX_PHOTO_BYTES) {
      return { valid: false, message: 'A FOTO EXCEDE O LIMITE MÁXIMO DE 5 MB.' };
    }
    return { valid: true };
  },

  /**
   * Faz upload da foto para o bucket privado `registros` em `/{user_id}/{data}/{arquivo}`
   * e retorna o caminho salvo no storage.
   */
  async uploadFoto(userId, file, dateStr) {
    const check = this.validarArquivoFoto(file);
    if (!check.valid) throw new Error(check.message);

    const sb = requireClient();
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
    const safeExt = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'jpg';
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
    const storagePath = `${userId}/${dateStr}/${fileName}`;

    const { error } = await sb.storage
      .from('registros')
      .upload(storagePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type
      });

    if (error) throw new Error(translateSupabaseError(error));
    return storagePath;
  },

  /** Gera URLs assinadas temporárias (Signed URLs) para exibir fotos privadas no Diário */
  async gerarUrlsAssinadas(paths) {
    const validPaths = (paths || []).filter(p => p && !p.startsWith('data:') && !p.startsWith('http'));
    if (!validPaths.length) return {};

    const sb = requireClient();
    const { data, error } = await sb.storage
      .from('registros')
      .createSignedUrls(validPaths, 3600); // válida por 1 hora

    if (error || !data) return {};
    const map = {};
    data.forEach(item => {
      if (item.path && item.signedUrl) map[item.path] = item.signedUrl;
    });
    return map;
  },

  /** Lista todos os registros do diário do usuário com dados da tarefa e URLs assinadas */
  async listar(userId) {
    const sb = requireClient();
    const { data, error } = await sb
      .from('task_logs')
      .select('*, tasks(nome, dificuldade, categoria)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(translateSupabaseError(error));
    const logs = data || [];

    // Resolve URLs assinadas para fotos no bucket privado
    const photoPaths = logs.map(l => l.foto_url).filter(Boolean);
    const signedMap = await this.gerarUrlsAssinadas(photoPaths);

    return logs.map(l => ({
      id: l.id,
      date: l.data,
      ts: new Date(l.created_at).getTime(),
      taskId: l.task_id,
      taskName: l.tasks?.nome || 'Missão',
      difficulty: l.tasks?.dificuldade || 'facil',
      text: l.descricao || '',
      photoPath: l.foto_url || null,
      photo: l.foto_url ? (signedMap[l.foto_url] || (l.foto_url.startsWith('data:') ? l.foto_url : null)) : null,
      xp: l.xp_ganho
    }));
  },

  /** Conclui uma tarefa chamando a função RPC segura no servidor (`concluir_tarefa`) */
  async concluirTarefa(taskId, descricao, fotoStoragePath) {
    const sb = requireClient();
    const { data, error } = await sb.rpc('concluir_tarefa', {
      p_task_id: taskId,
      p_descricao: descricao || null,
      p_foto_url: fotoStoragePath || null
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  }
};

/* ---------------------------------------------------------------------
   7. MÓDULO JOGO ("MISSÃO NA CIDADE" — RPCs Anti-Cheat e Loja)
   --------------------------------------------------------------------- */
const jogoApi = {
  /** Inicia partida validando e descontando 1 ficha no servidor (ou modo livre) */
  async iniciarPartida() {
    const sb = requireClient();
    const { data, error } = await sb.rpc('iniciar_partida');
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Finaliza partida calculando XP (com limite diário de 30%), moedas, drops e conquistas no servidor */
  async finalizarPartida({ distancia, inimigosDerrotados, bossVencido, semDano, moedasColetadas, duracao, dropRaroKey, dropRaroTipo }) {
    const sb = requireClient();
    const { data, error } = await sb.rpc('finalizar_partida', {
      p_distancia: Math.round(distancia || 0),
      p_inimigos_derrotados: Math.round(inimigosDerrotados || 0),
      p_boss_vencido: Boolean(bossVencido),
      p_sem_dano: Boolean(semDano),
      p_moedas_coletadas: Math.round(moedasColetadas || 0),
      p_duracao: Math.max(1, Math.round(duracao || 1)),
      p_drop_raro_key: dropRaroKey || null,
      p_drop_raro_tipo: dropRaroTipo || null
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  },

  /** Compra ou equipa upgrade/skin/traje validando moedas no servidor */
  async comprarOuEquiparItem(itemKey, itemType) {
    const sb = requireClient();
    const { data, error } = await sb.rpc('comprar_ou_equipar_item', {
      p_item_key: itemKey,
      p_item_type: itemType
    });
    if (error) throw new Error(translateSupabaseError(error));
    return data;
  }
};

/* Exporta na janela global para integração com character.js, game.js e script.js */
window.SB = {
  init: initSupabaseClient,
  getConfig: getSupabaseConfig,
  translateError: translateSupabaseError,
  auth: authApi,
  perfil: perfilApi,
  tarefas: tarefasApi,
  registros: registrosApi,
  jogo: jogoApi
};
