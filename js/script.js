/* Sistema de Missões — Lógica Principal & Integração Supabase */
/* =====================================================================
   1. CONSTANTES DE JOGO  (ajuste XP, limites e regras aqui)
   ===================================================================== */
const CONFIG = {
  XP_BY_DIFFICULTY: { facil: 10, media: 25, dificil: 50, epica: 100 },
  TICKETS_BY_DIFFICULTY: { facil: 1, media: 2, dificil: 3, epica: 5 },
  DIFFICULTY_LABELS:{ facil: 'FÁCIL', media: 'MÉDIA', dificil: 'DIFÍCIL', epica: 'ÉPICA' },
  BASE_XP_TO_LEVEL: 100,      // XP do nível 1 → 2
  XP_GROWTH: 1.25,            // +25% de XP necessário a cada nível
  MAX_TASKS: 15,              // limite de missões ativas por usuário
  STREAK_STEP_DAYS: 3,        // a cada 3 dias seguidos...
  STREAK_BONUS_PER_STEP: 0.10,// ...+10% de XP
  BAR_SEGMENTS: 10,
  SOUND_ENABLED: true,
  PHOTO_MAX_SIZE: 900,        // px (lado maior) – prévia comprimida
  PHOTO_QUALITY: 0.72,
  STORAGE_KEY: 'sistemaMissoes.v1',
  MIGRATED_KEY_PREFIX: 'sistemaMissoes.migrated.',
  PARTICLE_COLORS: ['#7CFF3A', '#1FD1B0', '#00F0FF', '#FFC21A', '#FFFFFF']
};

/* =====================================================================
   2. CONQUISTAS  (sincronizadas com as tabelas achievements / user_achievements)
   ===================================================================== */
const ACHIEVEMENTS = [
  { id: 'entrou_hoje',      label: 'ENTROU HOJE',                   daily: true,  check: () => true },
  { id: 'uma_missao',       label: 'COMPLETOU UMA MISSÃO',          daily: true,  check: s => s.doneToday >= 1 },
  { id: 'tres_missoes',     label: 'COMPLETOU TRÊS MISSÕES',        daily: true,  check: s => s.doneToday >= 3 },
  { id: 'primeiro_boss',    label: 'DERROTOU O PRIMEIRO BOSS',      daily: false, check: s => (s.game?.bossesDefeated || 0) >= 1 },
  { id: 'fase_sem_dano',    label: 'FASE SEM TOMAR DANO',           daily: false, check: s => !!s.game?.flawlessClear },
  { id: 'cacador_ternos',   label: '50 EXECUTIVOS DERROTADOS',      daily: false, check: s => (s.game?.enemiesDefeated || 0) >= 50 }
];

/* =====================================================================
   3. ESTADO EM MEMÓRIA + SINCRONIZAÇÃO COM SUPABASE (E CACHE LOCAL)
   ===================================================================== */
const DEFAULT_GAME_STATE = () => ({
  tickets: 2,
  coins: 0,
  matchesPlayed: 0,
  enemiesDefeated: 0,
  bossesDefeated: 0,
  bestDistance: 0,
  flawlessClear: false,
  dailyXPDate: null,
  dailyXP: 0,
  muted: false,
  upgrades: { hp: 0, dmg: 0, spd: 0 },
  unlockedOutfits: [],
  unlockedWeaponSkins: [],
  equippedWeaponSkin: null
});

const DEFAULT_STATE = () => ({
  version: 1,
  username: '',
  level: 1,
  xp: 0,
  totalXP: 0,
  tasks: [],          // { id, name, difficulty, category, lastDone }
  records: [],        // { id, date, ts, taskId, taskName, difficulty, text, photo, xp }
  streak: { count: 0, best: 0, lastDate: null },
  achievements: { date: null, daily: {}, permanent: {} },
  profile: null,      // { nome, genero, pele, cabelo, corCabelo, roupa, corRoupa, classe, arma }
  game: DEFAULT_GAME_STATE(),
  seeded: false
});

window.currentUser = null;
let state = DEFAULT_STATE();
let authMode = 'login'; // 'login' | 'signup' | 'forgot'

/** Lê o estado antigo salvo no localStorage (para migração no 1º login) */
function getLegacyLocalState() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const hasCustomData =
      (data.totalXP && data.totalXP > 0) ||
      (data.profile && data.profile.nome) ||
      (Array.isArray(data.records) && data.records.length > 0);
    return hasCustomData ? data : null;
  } catch (e) {
    return null;
  }
}

/** Mantém cópia local leve de preferências (ex.: mute) sem substituir o banco */
function saveState() {
  try {
    if (state?.game) {
      localStorage.setItem('sistemaMissoes.prefs', JSON.stringify({ muted: !!state.game.muted }));
    }
    return true;
  } catch (e) {
    return true;
  }
}

/* =====================================================================
   4. UTILITÁRIOS DE DATA, REDE E STATUS HUD
   ===================================================================== */
const pad = n => String(n).padStart(2, '0');
const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => dateKey();
const yesterdayKey = () => { const d = new Date(); d.setDate(d.getDate() - 1); return dateKey(d); };
const parseKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const $ = sel => document.querySelector(sel);
const escapeHTML = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatDateBR = k => parseKey(k).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

let currentDay = todayKey();

/** Atualiza o indicador de sincronização no estilo HUD */
function setSyncStatus(mode = 'online', customText = '') {
  const pill = $('#hudSyncStatus');
  if (!pill) return;
  pill.classList.remove('syncing', 'error');
  if (!navigator.onLine || mode === 'offline') {
    pill.classList.add('error');
    pill.textContent = '⚠ OFFLINE';
  } else if (mode === 'syncing') {
    pill.classList.add('syncing');
    pill.textContent = `⟳ ${customText || 'SINCRONIZANDO...'}`;
  } else if (mode === 'error') {
    pill.classList.add('error');
    pill.textContent = `✕ ${customText || 'ERRO DE REDE'}`;
  } else {
    pill.textContent = `● ${customText || 'ONLINE • SUPABASE'}`;
  }
}
window.setSyncStatus = setSyncStatus;

/** Monitora estado online/offline e bloqueia ações dependentes do servidor quando offline */
function updateOnlineState() {
  const online = navigator.onLine;
  $('#offlineBanner')?.classList.toggle('hidden', online);
  setSyncStatus(online ? 'online' : 'offline');

  // Desabilita botões de escrita quando offline
  const serverButtons = ['#saveTaskBtn', '#completeBtn', '#startCityMissionBtn', '#charConfirm'];
  serverButtons.forEach(sel => {
    const btn = $(sel);
    if (btn && !online) btn.disabled = true;
  });
  if (online) {
    renderFooter();
    if (typeof renderCityBanner === 'function') renderCityBanner();
    validateLog();
  }
}

/* =====================================================================
   5. XP, NÍVEIS E SEQUÊNCIA
   ===================================================================== */
const xpToNext = lvl => Math.round(CONFIG.BASE_XP_TO_LEVEL * Math.pow(CONFIG.XP_GROWTH, lvl - 1));

function effectiveStreak() {
  const { count, lastDate } = state.streak;
  return (lastDate === todayKey() || lastDate === yesterdayKey()) ? count : 0;
}
function projectedStreak() {
  const { count, lastDate } = state.streak;
  if (lastDate === todayKey()) return Math.max(1, count);
  if (lastDate === yesterdayKey()) return count + 1;
  return 1;
}
const streakMultiplier = days => 1 + CONFIG.STREAK_BONUS_PER_STEP * Math.floor(days / CONFIG.STREAK_STEP_DAYS);
const xpForTask = task => {
  const base = CONFIG.XP_BY_DIFFICULTY[task.difficulty];
  const streakMult = streakMultiplier(projectedStreak());
  const classMult = 1 + (typeof classBonusFor === 'function' ? classBonusFor(task) : 0);
  return Math.round(base * streakMult * classMult);
};

function addXP(amount) {
  let gained = 0;
  state.xp += amount;
  state.totalXP += amount;
  while (state.xp >= xpToNext(state.level)) {
    state.xp -= xpToNext(state.level);
    state.level++;
    gained++;
  }
  return gained;
}

/* =====================================================================
   6. CONQUISTAS
   ===================================================================== */
const doneTodayCount = () => state.records.filter(r => r.date === todayKey()).length;

function evaluateAchievements(silent = false) {
  const ach = state.achievements;
  if (ach.date !== todayKey()) { ach.date = todayKey(); ach.daily = {}; }
  const stats = { doneToday: doneTodayCount(), streak: effectiveStreak(), level: state.level, totalRecords: state.records.length, game: state.game };
  const newly = [];
  ACHIEVEMENTS.forEach(a => {
    const store = a.daily ? ach.daily : ach.permanent;
    if (!store[a.id] && a.check(stats)) { store[a.id] = true; newly.push(a); }
  });
  if (!silent) newly.forEach(a => toast(`🏆 CONQUISTA: ${a.label}`));
  return newly.map(a => a.id);
}

/* =====================================================================
   7. RENDERIZAÇÃO DO HUD PRINCIPAL
   ===================================================================== */
function renderAll() {
  renderBar();
  renderAchievements();
  renderMissions();
  renderFooter();
  if (typeof renderAvatar === 'function') renderAvatar();
  if (typeof renderCityBanner === 'function') renderCityBanner();
  if (!$('#tabDiary').classList.contains('hidden')) renderDiary();
}

function renderBar(levelUp = false) {
  const need = xpToNext(state.level);
  const pct = Math.min(100, Math.floor((state.xp / need) * 100));
  const fill = $('#xpFill'), tag = $('#xpTag');
  const apply = p => {
    fill.style.width = p + '%';
    tag.style.left = Math.max(4, Math.min(96, p)) + '%';
    tag.textContent = p + '%';
    $('#xpBar').setAttribute('aria-valuenow', p);
  };
  if (levelUp) {
    apply(100);
    setTimeout(() => {
      fill.style.transition = tag.style.transition = 'none';
      apply(0);
      void fill.offsetWidth;
      fill.style.transition = tag.style.transition = '';
      apply(pct);
    }, 950);
  } else apply(pct);

  $('#xpText').textContent = `XP ${state.xp} / ${need} • TOTAL ${state.totalXP}`;
  const st = effectiveStreak(), bonus = Math.round((streakMultiplier(st) - 1) * 100);
  $('#streakText').textContent = `🔥 SEQUÊNCIA: ${st} ${st === 1 ? 'DIA' : 'DIAS'}${bonus ? ` • +${bonus}% XP` : ''}`;
  $('#levelNum').firstChild.textContent = state.level;
}

function renderAchievements(justUnlocked = []) {
  const ach = state.achievements;
  $('#achList').innerHTML = ACHIEVEMENTS.map(a => {
    const on = (a.daily ? ach.daily : ach.permanent)[a.id];
    return `<li class="ach-item ${on ? 'unlocked' : ''} ${justUnlocked.includes(a.id) ? 'just-unlocked' : ''}">
      <span class="ach-icon">${on ? '✓' : ''}</span><span>${a.label}</span></li>`;
  }).join('');
}

function renderMissions() {
  const list = $('#missionList');
  $('#taskCounter').textContent = `${state.tasks.length}/${CONFIG.MAX_TASKS}`;
  if (!state.tasks.length) {
    list.innerHTML = `<li class="empty">NENHUMA MISSÃO CADASTRADA.<br>CLIQUE EM “ADICIONAR MAIS ATIVIDADES”.</li>`;
    return;
  }
  const today = todayKey();
  list.innerHTML = state.tasks.map((t, i) => {
    const done = t.lastDone === today;
    const tkts = CONFIG.TICKETS_BY_DIFFICULTY[t.difficulty] || 1;
    return `<li class="mission ${done ? 'done' : ''}" style="animation-delay:${i * 40}ms">
      <div>
        <div class="mission-name">${escapeHTML(t.name)}</div>
        <div class="mission-meta">
          <span class="badge ${t.difficulty}">${CONFIG.DIFFICULTY_LABELS[t.difficulty]}</span>
          ${typeof categoryBadge === 'function' ? categoryBadge(t) : ''}
          <span class="xp-chip">+${done ? CONFIG.XP_BY_DIFFICULTY[t.difficulty] : xpForTask(t)} XP</span>
          <span class="tkt-chip" title="Fichas de entrada na Cidade">🎫 +${tkts} ${tkts === 1 ? 'FICHA' : 'FICHAS'}</span>
        </div>
      </div>
      ${done ? `<span class="done-chip">✓ CONCLUÍDA HOJE</span>`
             : `<button class="plus-btn" data-log="${t.id}" title="Registrar progresso" aria-label="Registrar ${escapeHTML(t.name)}"></button>`}
    </li>`;
  }).join('');
}

function renderFooter() {
  const full = state.tasks.length >= CONFIG.MAX_TASKS;
  $('#addBtn').disabled = full || !navigator.onLine;
  $('#limitMsg').classList.toggle('hidden', !full);
}

/* =====================================================================
   8. DIÁRIO DE MISSÕES (calendário + lista com URLs assinadas do Storage)
   ===================================================================== */
let calMonth = new Date(); calMonth.setDate(1);
let diaryFilter = null;

function renderDiary() {
  renderCalendar();
  const recs = state.records
    .filter(r => !diaryFilter || r.date === diaryFilter)
    .sort((a, b) => b.ts - a.ts);
  $('#clearFilterBtn').classList.toggle('hidden', !diaryFilter);

  const days = new Set(state.records.map(r => r.date));
  $('#diaryStats').innerHTML = `
    REGISTROS: <b>${state.records.length}</b><br>
    DIAS ATIVOS: <b>${days.size}</b><br>
    XP TOTAL: <b>${state.totalXP}</b><br>
    MAIOR SEQUÊNCIA: <b>${Math.max(effectiveStreak(), state.streak.best || 0)}</b>`;

  if (!recs.length) {
    $('#diaryList').innerHTML = `<div class="empty">${diaryFilter ? 'NENHUM REGISTRO NESTE DIA.' : 'SEU DIÁRIO ESTÁ VAZIO.<br>CONCLUA UMA MISSÃO PARA COMEÇAR.'}</div>`;
    return;
  }
  const groups = {};
  recs.forEach(r => (groups[r.date] ||= []).push(r));
  $('#diaryList').innerHTML = Object.keys(groups).sort().reverse().map(date => `
    <div>
      <div class="diary-date">${formatDateBR(date)}</div>
      ${groups[date].map(r => `
        <div class="entry">
          ${r.photo ? `<img src="${r.photo}" alt="Foto: ${escapeHTML(r.taskName)}" data-zoom>` : ''}
          <div>
            <div class="entry-title">${escapeHTML(r.taskName)}
              <span class="badge ${r.difficulty}">${CONFIG.DIFFICULTY_LABELS[r.difficulty] || ''}</span>
              <span style="color:var(--lime)">+${r.xp} XP</span>
            </div>
            ${r.text ? `<div class="entry-text">${escapeHTML(r.text)}</div>` : ''}
            <div class="entry-time">⏱ ${new Date(r.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
        </div>`).join('')}
    </div>`).join('');
}

function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('#calTitle').textContent = calMonth.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const days = new Set(state.records.map(r => r.date));
  const first = new Date(y, m, 1).getDay();
  const total = new Date(y, m + 1, 0).getDate();
  let html = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'].map(d => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < first; i++) html += '<div></div>';
  for (let d = 1; d <= total; d++) {
    const k = dateKey(new Date(y, m, d));
    const cls = ['cal-day', days.has(k) && 'has', k === todayKey() && 'today', k === diaryFilter && 'selected'].filter(Boolean).join(' ');
    html += `<div class="${cls}" ${days.has(k) ? `data-day="${k}"` : ''}>${d}</div>`;
  }
  $('#calGrid').innerHTML = html;
}

/* =====================================================================
   9. GERENCIAMENTO DE TAREFAS (CRUD na tabela `tasks` do PostgreSQL)
   ===================================================================== */
function buildDifficultyOptions() {
  $('#diffOptions').innerHTML = Object.keys(CONFIG.XP_BY_DIFFICULTY).map((k, i) => `
    <input type="radio" name="diff" id="diff_${k}" value="${k}" ${i === 0 ? 'checked' : ''}>
    <label for="diff_${k}">${CONFIG.DIFFICULTY_LABELS[k]}<small>${CONFIG.XP_BY_DIFFICULTY[k]} XP • 🎫 +${CONFIG.TICKETS_BY_DIFFICULTY[k]}</small></label>`).join('');
}

function openTaskModal(editId = null) {
  resetTaskForm();
  if (editId) startEdit(editId);
  renderTaskAdmin();
  openModal('taskModal');
  setTimeout(() => $('#taskName').focus(), 100);
}

function resetTaskForm() {
  $('#taskEditId').value = '';
  $('#taskName').value = '';
  if ($('#taskCategory')) $('#taskCategory').value = '';
  document.querySelector('input[name="diff"]').checked = true;
  $('#taskModalTitle').textContent = 'NOVA MISSÃO';
  $('#saveTaskBtn').textContent = 'SALVAR MISSÃO';
  $('#cancelEditBtn').classList.add('hidden');
  const full = state.tasks.length >= CONFIG.MAX_TASKS;
  $('#saveTaskBtn').disabled = full || !navigator.onLine;
  $('#taskModalSub').textContent = full
    ? 'LIMITE DE 15 MISSÕES ATINGIDO. EDITE OU EXCLUA UMA MISSÃO EXISTENTE.'
    : `DEFINA O NOME, CATEGORIA E DIFICULDADE. (${state.tasks.length}/${CONFIG.MAX_TASKS})`;
}

function startEdit(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  $('#taskEditId').value = id;
  $('#taskName').value = t.name;
  if ($('#taskCategory')) $('#taskCategory').value = t.category || '';
  $(`#diff_${t.difficulty}`).checked = true;
  $('#taskModalTitle').textContent = 'EDITAR MISSÃO';
  $('#saveTaskBtn').textContent = 'SALVAR ALTERAÇÕES';
  $('#saveTaskBtn').disabled = !navigator.onLine;
  $('#cancelEditBtn').classList.remove('hidden');
  $('#taskName').focus();
}

function renderTaskAdmin() {
  $('#taskAdminList').innerHTML = state.tasks.length
    ? state.tasks.map(t => `<li>
        <span class="t-name">${escapeHTML(t.name)}</span>
        ${t.category && typeof CATEGORIES !== 'undefined' && CATEGORIES[t.category] ? `<span class="cat-badge">${CATEGORIES[t.category].icon}</span>` : ''}
        <span class="badge ${t.difficulty}">${CONFIG.DIFFICULTY_LABELS[t.difficulty]}</span>
        <button class="icon-btn" data-edit="${t.id}" title="Editar">✎</button>
        <button class="icon-btn del" data-del="${t.id}" title="Excluir">🗑</button>
      </li>`).join('')
    : '<li class="empty">NENHUMA MISSÃO AINDA.</li>';
}

async function saveTask(e) {
  e.preventDefault();
  if (!navigator.onLine) { toast('VOCÊ ESTÁ OFFLINE. AÇÃO BLOQUEADA.', true); return; }
  const name = $('#taskName').value.trim();
  const category = $('#taskCategory') ? $('#taskCategory').value : '';
  const difficulty = document.querySelector('input[name="diff"]:checked').value;
  const editId = $('#taskEditId').value;
  if (!name) { toast('DIGITE O NOME DA TAREFA.', true); return; }

  const btn = $('#saveTaskBtn');
  btn.disabled = true;
  setSyncStatus('syncing', 'SALVANDO MISSÃO...');

  try {
    if (editId) {
      if (window.currentUser) {
        await window.SB.tarefas.atualizar(window.currentUser.id, editId, { name, difficulty, category });
      }
      const t = state.tasks.find(x => x.id === editId);
      if (t) { t.name = name; t.difficulty = difficulty; t.category = category; }
      toast('MISSÃO ATUALIZADA NO SERVIDOR.');
    } else {
      if (state.tasks.length >= CONFIG.MAX_TASKS) {
        toast('LIMITE DE 15 MISSÕES ATIVAS ATINGIDO!', true);
        setSyncStatus('online');
        return;
      }
      let newId = uid();
      if (window.currentUser) {
        const created = await window.SB.tarefas.criar(window.currentUser.id, { name, difficulty, category });
        newId = created.id;
      }
      state.tasks.push({ id: newId, name, difficulty, category, lastDone: null });
      toast('NOVA MISSÃO ADICIONADA AO BANCO!');
    }
    setSyncStatus('online');
    resetTaskForm();
    renderTaskAdmin();
    renderAll();
  } catch (err) {
    setSyncStatus('error');
    toast(err.message || 'ERRO AO SALVAR MISSÃO.', true);
    btn.disabled = false;
  }
}

async function deleteTask(id) {
  if (!navigator.onLine) { toast('VOCÊ ESTÁ OFFLINE. AÇÃO BLOQUEADA.', true); return; }
  const t = state.tasks.find(x => x.id === id);
  if (!t || !confirm(`Excluir a missão "${t.name}"?\nOs registros do diário serão mantidos.`)) return;

  setSyncStatus('syncing', 'REMOVENDO...');
  try {
    if (window.currentUser) {
      await window.SB.tarefas.excluir(window.currentUser.id, id);
    }
    state.tasks = state.tasks.filter(x => x.id !== id);
    setSyncStatus('online');
    resetTaskForm();
    renderTaskAdmin();
    renderAll();
    toast('MISSÃO EXCLUÍDA.');
  } catch (err) {
    setSyncStatus('error');
    toast(err.message || 'ERRO AO EXCLUIR MISSÃO.', true);
  }
}

/* =====================================================================
   10. REGISTRO DE PROGRESSO + SUPABASE STORAGE (`registros`) + RPC `concluir_tarefa`
   ===================================================================== */
let logTaskId = null, logPhotoPreview = null, logPhotoFile = null;

function openLogModal(id) {
  if (!navigator.onLine) { toast('VOCÊ ESTÁ OFFLINE. CONECTE-SE PARA REGISTRAR MISSÕES.', true); return; }
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  if (t.lastDone === todayKey()) { toast('ESTA MISSÃO JÁ FOI CONCLUÍDA HOJE.', true); return; }
  logTaskId = id; logPhotoPreview = null; logPhotoFile = null;
  $('#logTitle').textContent = t.name;
  const bonus = Math.round((streakMultiplier(projectedStreak()) - 1) * 100);
  const cBonus = typeof classBonusFor === 'function' ? Math.round(classBonusFor(t) * 100) : 0;
  const tags = [bonus && `SEQUÊNCIA +${bonus}%`, cBonus && `CLASSE +${cBonus}%`].filter(Boolean).join(', ');
  $('#logSub').textContent = `${CONFIG.DIFFICULTY_LABELS[t.difficulty]} • RECOMPENSA: +${xpForTask(t)} XP${tags ? ` (${tags})` : ''}`;
  $('#logText').value = '';
  $('#logPhoto').value = '';
  $('#photoPreview').classList.add('hidden');
  $('#photoDrop').classList.remove('hidden');
  validateLog();
  openModal('logModal');
}

function validateLog() {
  const ok = ($('#logText')?.value.trim().length > 0 || !!logPhotoFile || !!logPhotoPreview) && navigator.onLine;
  if ($('#completeBtn')) $('#completeBtn').disabled = !ok;
  const hint = $('#reqHint');
  if (hint) {
    hint.classList.toggle('ok', ok);
    hint.textContent = ok
      ? '✓ REGISTRO VÁLIDO. PRONTO PARA ENVIAR AO SERVIDOR!'
      : '⚠ ENVIE UMA FOTO (PNG/JPG/WEBP ATÉ 5 MB) OU ESCREVA UMA DESCRIÇÃO PARA CONCLUIR.';
  }
}

async function handlePhoto(e) {
  const file = e.target.files[0];
  if (!file) return;

  // Validação estrita: PNG, JPG ou WEBP, máximo 5 MB
  const check = window.SB.registros.validarArquivoFoto(file);
  if (!check.valid) {
    toast(check.message, true);
    e.target.value = '';
    return;
  }

  try {
    logPhotoFile = file;
    logPhotoPreview = URL.createObjectURL(file);
    $('#photoImg').src = logPhotoPreview;
    $('#photoPreview').classList.remove('hidden');
    $('#photoDrop').classList.add('hidden');
  } catch {
    toast('NÃO FOI POSSÍVEL LER A FOTO.', true);
    logPhotoFile = null;
    logPhotoPreview = null;
  }
  validateLog();
}

function removePhoto() {
  if (logPhotoPreview && logPhotoPreview.startsWith('blob:')) {
    URL.revokeObjectURL(logPhotoPreview);
  }
  logPhotoFile = null;
  logPhotoPreview = null;
  $('#logPhoto').value = '';
  $('#photoPreview').classList.add('hidden');
  $('#photoDrop').classList.remove('hidden');
  validateLog();
}

/** Conclui a missão fazendo upload para o bucket privado `registros` e chamando a RPC `concluir_tarefa` */
async function completeMission() {
  if (!navigator.onLine) { toast('SEM CONEXÃO COM O SERVIDOR.', true); return; }
  const t = state.tasks.find(x => x.id === logTaskId);
  const text = $('#logText').value.trim();
  if (!t || (!text && !logPhotoFile)) return;
  const today = todayKey();
  if (t.lastDone === today) { toast('ESTA MISSÃO JÁ FOI CONCLUÍDA HOJE.', true); return; }

  const btn = $('#completeBtn');
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'ENVIANDO PROVA...';
  setSyncStatus('syncing', 'VALIDANDO MISSÃO...');

  try {
    let storagePath = null;
    let signedPhotoUrl = logPhotoPreview;

    // 1. Se houver foto, faz upload para `registros/{user_id}/{data}/{arquivo}`
    if (logPhotoFile && window.currentUser) {
      storagePath = await window.SB.registros.uploadFoto(window.currentUser.id, logPhotoFile, today);
      const signedMap = await window.SB.registros.gerarUrlsAssinadas([storagePath]);
      signedPhotoUrl = signedMap[storagePath] || logPhotoPreview;
    }

    // 2. Chama a função RPC `concluir_tarefa` no PostgreSQL (calcula XP, nível, streak e fichas no servidor)
    const prevLevel = state.level;
    let gain = xpForTask(t);
    let tkts = CONFIG.TICKETS_BY_DIFFICULTY[t.difficulty] || 1;
    let levels = 0;
    let unlocked = [];

    if (window.currentUser) {
      const rpcRes = await window.SB.registros.concluirTarefa(t.id, text, storagePath);
      gain = rpcRes.xp_ganho;
      tkts = rpcRes.fichas_ganhas;
      levels = rpcRes.levels_gained || 0;

      if (rpcRes.profile) {
        state.level = rpcRes.profile.level;
        state.xp = rpcRes.profile.xp_nivel_atual;
        state.totalXP = rpcRes.profile.xp_total;
        state.streak = {
          count: rpcRes.profile.streak_atual,
          best: rpcRes.profile.maior_streak,
          lastDate: rpcRes.profile.ultima_data_streak || today
        };
        state.game.tickets = rpcRes.profile.fichas;
        state.game.coins = rpcRes.profile.moedas;
      }

      state.records.unshift({
        id: rpcRes.log?.id || uid(),
        date: today,
        ts: Date.now(),
        taskId: t.id,
        taskName: t.name,
        difficulty: t.difficulty,
        text,
        photoPath: storagePath,
        photo: signedPhotoUrl,
        xp: gain
      });

      if (Array.isArray(rpcRes.unlocked_achievements)) {
        unlocked = rpcRes.unlocked_achievements;
        unlocked.forEach(code => {
          const def = ACHIEVEMENTS.find(a => a.id === code);
          if (def) {
            (def.daily ? state.achievements.daily : state.achievements.permanent)[code] = true;
            toast(`🏆 CONQUISTA: ${def.label}`);
          }
        });
      }
    }

    t.lastDone = today;
    setSyncStatus('online');
    closeModal('logModal');
    renderBar(levels > 0);
    renderAchievements(unlocked);
    renderMissions();
    renderFooter();
    if (typeof renderAvatar === 'function') renderAvatar();
    if (typeof renderCityBanner === 'function') renderCityBanner();
    toast(`MISSÃO CONCLUÍDA! +${gain} XP • 🎫 +${tkts} ${tkts === 1 ? 'FICHA' : 'FICHAS'}`);
    playSound('complete');
    if (levels > 0) setTimeout(() => showLevelUp(prevLevel), 700);
  } catch (err) {
    setSyncStatus('error');
    toast(err.message || 'ERRO AO CONCLUIR MISSÃO NO SERVIDOR.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

/* =====================================================================
   11. LEVEL UP: animação, partículas e som
   ===================================================================== */
function showLevelUp(prevLevel = state.level - 1) {
  const el = $('#levelUp');
  $('#levelUpText').textContent = `NÍVEL ${state.level}`;
  if (typeof celebrateCharacter === 'function') celebrateCharacter(prevLevel);
  el.querySelectorAll('.particle').forEach(p => p.remove());
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('span');
    p.className = 'particle';
    const ang = Math.random() * Math.PI * 2, dist = 150 + Math.random() * 380;
    p.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
    p.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
    p.style.setProperty('--c', CONFIG.PARTICLE_COLORS[i % CONFIG.PARTICLE_COLORS.length]);
    p.style.setProperty('--t', (1 + Math.random() * 1.2) + 's');
    el.appendChild(p);
  }
  el.classList.add('active');
  const num = $('#levelNum');
  num.classList.remove('bump'); void num.offsetWidth; num.classList.add('bump');
  playSound('levelup');
  clearTimeout(showLevelUp.t);
  showLevelUp.t = setTimeout(() => el.classList.remove('active'), 3200);
}

let audioCtx = null;
function playSound(type) {
  if (!CONFIG.SOUND_ENABLED) return;
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const notes = type === 'levelup' ? [523, 659, 784, 1047, 1319] : [660, 990];
    notes.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.09;
      o.type = 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      o.connect(g).connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.22);
    });
  } catch (e) { /* áudio indisponível */ }
}

/* =====================================================================
   12. MODAIS E TOASTS
   ===================================================================== */
function openModal(id) { $('#' + id)?.classList.add('open'); }
function closeModal(id) { $('#' + id)?.classList.remove('open'); }

function toast(msg, error = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3900);
}

/* =====================================================================
   13. AUTENTICAÇÃO HUD, PROTEÇÃO DE ROTAS, REALTIME E MIGRAÇÃO
   ===================================================================== */
function showAuthMessage(msg, type = 'info') {
  const el = $('#authMsg');
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.className = `auth-msg ${type === 'error' ? 'err' : type === 'success' ? 'ok' : ''}`;
  el.classList.remove('hidden');
}

function setAuthMode(mode) {
  authMode = mode;
  showAuthMessage('');
  document.querySelectorAll('[data-auth-mode]').forEach(b => {
    b.classList.toggle('active', b.dataset.authMode === mode);
  });

  const isSignup = mode === 'signup';
  const isForgot = mode === 'forgot';

  $('#authTabs').classList.toggle('hidden', isForgot);
  $('#oauthButtons').classList.toggle('hidden', isForgot);
  $('#authOrSep').classList.toggle('hidden', isForgot);
  $('#authUsernameField').classList.toggle('hidden', !isSignup);
  $('#authPasswordField').classList.toggle('hidden', isForgot);
  $('#authPassword').required = !isForgot;
  $('#pwdStrengthHint').classList.toggle('hidden', !isSignup);
  $('#forgotPwdBtn').classList.toggle('hidden', isForgot);
  $('#backToLoginBtn').classList.toggle('hidden', !isForgot);

  if (isForgot) {
    $('#authSubtitle').textContent = 'DIGITE SEU E-MAIL PARA RECEBER O LINK DE RECUPERAÇÃO DE SENHA';
    $('#authSubmitBtn').textContent = 'ENVIAR E-MAIL DE RECUPERAÇÃO';
  } else if (isSignup) {
    $('#authSubtitle').textContent = 'CRIE SUA CONTA DE AGENTE (SENHA FORTE DE NO MÍNIMO 8 CARACTERES)';
    $('#authSubmitBtn').textContent = 'CRIAR CONTA DE AGENTE';
  } else {
    $('#authSubtitle').textContent = 'IDENTIFIQUE-SE PARA SINCRONIZAR SEU PERFIL E PROGRESSO';
    $('#authSubmitBtn').textContent = 'ENTRAR NO SISTEMA';
  }
}

/** Proteção de rota: exibe apenas a tela de login se deslogado, ou libera o painel HUD se autenticado */
function setRouteProtection(isAuthenticated) {
  $('#authScreen').classList.toggle('open', !isAuthenticated);
  $('#mainApp').classList.toggle('hidden', !isAuthenticated);
  if (!isAuthenticated) {
    $('#charScreen')?.classList.remove('open');
    $('#gameScreen')?.classList.remove('open');
    document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
  }
}

/** Fluxo pós-login: carrega perfil, personagem, tarefas, registros e conquistas do PostgreSQL */
async function loadAuthenticatedApp(user) {
  window.currentUser = user;
  setRouteProtection(true);
  setSyncStatus('syncing', 'CARREGANDO DADOS...');

  try {
    // 1. Registra acesso diário ("ENTROU HOJE") e valida streak no servidor
    await window.SB.perfil.registrarAcessoDiario();

    // 2. Verifica se há dados antigos no localStorage para oferecer migração no primeiro login
    const migKey = CONFIG.MIGRATED_KEY_PREFIX + user.id;
    const legacy = !localStorage.getItem(migKey) ? getLegacyLocalState() : null;

    // 3. Carrega todos os dados do usuário no PostgreSQL + URLs assinadas do Storage
    const [bundle, activeTasks, diaryLogs] = await Promise.all([
      window.SB.perfil.carregarDadosCompletos(user.id),
      window.SB.tarefas.listarAtivas(user.id),
      window.SB.registros.listar(user.id)
    ]);

    const prof = bundle.profile;
    const char = bundle.character;
    const inv = bundle.inventory || [];
    const runs = bundle.gameRuns || [];

    // 4. Monta o objeto `state` a partir do banco de dados
    const today = todayKey();
    const doneTodayTaskIds = new Set(diaryLogs.filter(r => r.date === today).map(r => r.taskId));

    const upgrades = { hp: 0, dmg: 0, spd: 0 };
    const unlockedOutfits = [];
    const unlockedWeaponSkins = [];
    let equippedWeaponSkin = null;

    inv.forEach(item => {
      if (item.item_type === 'upgrade' && upgrades[item.item_key] !== undefined) {
        upgrades[item.item_key] = item.nivel;
      } else if (item.item_type === 'outfit') {
        unlockedOutfits.push(item.item_key);
      } else if (item.item_type === 'weapon_skin') {
        unlockedWeaponSkins.push(item.item_key);
        if (item.equipado) equippedWeaponSkin = item.item_key;
      }
    });

    const totalKills = runs.reduce((acc, r) => acc + (r.inimigos_derrotados || 0), 0);
    const bossesWon = runs.filter(r => r.boss_vencido).length;
    const bestDist = runs.reduce((acc, r) => Math.max(acc, r.distancia || 0), 0);
    const flawless = runs.some(r => r.boss_vencido && r.sem_dano);

    const dailyAch = {};
    const permAch = {};
    (bundle.userAchievements || []).forEach(ua => {
      const code = ua.achievements?.code;
      const isDaily = ua.achievements?.diaria;
      if (!code) return;
      if (isDaily && ua.data === today) dailyAch[code] = true;
      else if (!isDaily) permAch[code] = true;
    });

    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem('sistemaMissoes.prefs') || '{}'); } catch {}

    state = {
      version: 1,
      username: prof?.username || user.email?.split('@')[0] || 'agente',
      level: prof?.level || 1,
      xp: prof?.xp_nivel_atual || 0,
      totalXP: prof?.xp_total || 0,
      tasks: activeTasks.map(t => ({
        id: t.id,
        name: t.nome,
        difficulty: t.dificuldade,
        category: t.categoria || '',
        lastDone: doneTodayTaskIds.has(t.id) ? today : null
      })),
      records: diaryLogs,
      streak: {
        count: prof?.streak_atual || 0,
        best: prof?.maior_streak || 0,
        lastDate: prof?.ultima_data_streak || null
      },
      achievements: { date: today, daily: dailyAch, permanent: permAch },
      profile: char ? {
        nome: char.nome,
        genero: char.genero,
        pele: char.cor_pele,
        cabelo: char.cabelo,
        corCabelo: char.cor_cabelo,
        roupa: char.roupa,
        corRoupa: char.cor_roupa,
        classe: char.classe,
        arma: char.arma
      } : null,
      game: {
        tickets: prof?.fichas ?? 2,
        coins: prof?.moedas ?? 0,
        matchesPlayed: runs.length,
        enemiesDefeated: totalKills,
        bossesDefeated: bossesWon,
        bestDistance: bestDist,
        flawlessClear: flawless,
        dailyXPDate: prof?.data_xp_jogo || today,
        dailyXP: prof?.data_xp_jogo === today ? (prof?.xp_jogo_hoje || 0) : 0,
        muted: !!prefs.muted,
        upgrades,
        unlockedOutfits,
        unlockedWeaponSkins,
        equippedWeaponSkin
      },
      seeded: true
    };

    renderAll();
    setSyncStatus('online');

    // 5. Assina atualizações Realtime na tabela `profiles` (barra de XP e nível em tempo real)
    window.SB.perfil.assinarRealtimePerfil(user.id, updatedProf => {
      const prevLvl = state.level;
      state.level = updatedProf.level;
      state.xp = updatedProf.xp_nivel_atual;
      state.totalXP = updatedProf.xp_total;
      state.username = updatedProf.username || state.username;
      state.streak.count = updatedProf.streak_atual;
      state.streak.best = updatedProf.maior_streak;
      state.streak.lastDate = updatedProf.ultima_data_streak;
      state.game.coins = updatedProf.moedas;
      state.game.tickets = updatedProf.fichas;
      state.game.dailyXP = updatedProf.xp_jogo_hoje || 0;
      renderBar(updatedProf.level > prevLvl);
      if (typeof renderCityBanner === 'function') renderCityBanner();
    });

    // 6. Se houver dados locais no navegador e a conta for recém-criada (sem personagem no banco), oferece migração
    if (legacy && !state.profile) {
      offerLocalStorageMigration(user.id, legacy);
    } else if (!state.profile) {
      // Fluxo obrigatório: se não tiver personagem, abre a criação de personagem
      openCharEditor('create');
    }
  } catch (err) {
    setSyncStatus('error');
    toast(err.message || 'ERRO AO CARREGAR DADOS DO SERVIDOR.', true);
  }
}

function offerLocalStorageMigration(userId, legacy) {
  const charName = legacy.profile?.nome ? `Personagem "${legacy.profile.nome}"` : 'Sem personagem';
  const lvl = legacy.level || 1;
  const tasksCount = Array.isArray(legacy.tasks) ? legacy.tasks.length : 0;
  $('#migrationSummary').innerHTML = `
    Detectamos dados salvos anteriormente neste dispositivo:<br>
    • <b>${escapeHTML(charName)}</b> (Nível ${lvl} • ${legacy.totalXP || 0} XP Total)<br>
    • <b>${tasksCount}</b> missões configuradas e <b>${legacy.game?.coins || 0}</b> moedas.<br><br>
    Deseja importar esses dados para sua conta na nuvem?
  `;
  openModal('migrationModal');

  $('#confirmMigrationBtn').onclick = async () => {
    const btn = $('#confirmMigrationBtn');
    btn.disabled = true;
    btn.textContent = 'IMPORTANDO...';
    try {
      await window.SB.perfil.importarDadosLocais(legacy);
      localStorage.setItem(CONFIG.MIGRATED_KEY_PREFIX + userId, 'true');
      localStorage.removeItem(CONFIG.STORAGE_KEY);
      closeModal('migrationModal');
      toast('DADOS IMPORTADOS COM SUCESSO PARA O BANCO!');
      await loadAuthenticatedApp(window.currentUser);
    } catch (err) {
      toast(err.message || 'ERRO AO IMPORTAR DADOS LOCAIS.', true);
      btn.disabled = false;
      btn.textContent = '⬆ IMPORTAR PARA MINHA CONTA';
    }
  };

  $('#skipMigrationBtn').onclick = () => {
    localStorage.setItem(CONFIG.MIGRATED_KEY_PREFIX + userId, 'skipped');
    closeModal('migrationModal');
    if (!state.profile) openCharEditor('create');
  };
}

/* =====================================================================
   14. TELA DE CONFIGURAÇÕES DA CONTA (Username, Senha, Provedores OAuth, Excluir Conta)
   ===================================================================== */
const SUPPORTED_OAUTH_PROVIDERS = [
  { id: 'google',  name: 'GOOGLE',  desc: 'OAuth 2.0 / OpenID Connect' },
  { id: 'discord', name: 'DISCORD', desc: 'OAuth 2.0 Identity' },
  { id: 'github',  name: 'GITHUB',  desc: 'OAuth 2.0 Identity' },
  { id: 'apple',   name: 'APPLE',   desc: 'OpenID Connect (Estrutura pronta)' }
];

async function openAccountSettings() {
  if (!window.currentUser) return;
  $('#accountEmailDisplay').textContent = `E-MAIL DA CONTA: ${window.currentUser.email || 'PROVEDOR EXTERNO'} • ID: ${window.currentUser.id.slice(0, 8)}`;
  $('#settingsUsername').value = state.username || '';
  $('#settingsNewPassword').value = '';
  openModal('accountModal');
  await renderConnectedProviders();
}

async function renderConnectedProviders() {
  const listEl = $('#providersList');
  if (!listEl) return;
  listEl.innerHTML = `<div class="empty">CARREGANDO IDENTIDADES VINCULADAS...</div>`;

  try {
    const identities = await window.SB.auth.getIdentities();
    const totalIdentities = identities.length;

    listEl.innerHTML = SUPPORTED_OAUTH_PROVIDERS.map(prov => {
      const linked = identities.find(i => i.provider === prov.id);
      const emailOrSub = linked?.identity_data?.email || linked?.identity_data?.full_name || linked?.id?.slice(0, 10) || '';
      return `
        <div class="provider-row ${linked ? 'connected' : ''}">
          <div class="provider-info">
            <b>${prov.name} ${linked ? '✓ CONECTADO' : ''}</b>
            <small>${linked ? `Vinculado (${escapeHTML(emailOrSub)})` : prov.desc}</small>
          </div>
          ${linked
            ? `<button type="button" class="btn red" data-unlink-prov="${prov.id}" ${totalIdentities <= 1 ? 'disabled title="Mantenha pelo menos 1 método de login ativo"' : ''}>
                 DESVINCULAR
               </button>`
            : `<button type="button" class="btn ghost" data-link-prov="${prov.id}">
                 + VINCULAR ${prov.name}
               </button>`
          }
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('[data-link-prov]').forEach(btn => {
      btn.onclick = async () => {
        try {
          toast(`REDIRECIONANDO PARA VINCULAR ${btn.dataset.linkProv.toUpperCase()}...`);
          await window.SB.auth.linkIdentity(btn.dataset.linkProv);
        } catch (err) {
          toast(err.message, true);
        }
      };
    });

    listEl.querySelectorAll('[data-unlink-prov]').forEach(btn => {
      btn.onclick = async () => {
        const provId = btn.dataset.unlinkProv;
        const targetIdentity = identities.find(i => i.provider === provId);
        if (!targetIdentity || !confirm(`Desvincular o provedor ${provId.toUpperCase()} da sua conta?`)) return;
        try {
          await window.SB.auth.unlinkIdentity(targetIdentity);
          toast(`PROVEDOR ${provId.toUpperCase()} DESVINCULADO.`);
          await renderConnectedProviders();
        } catch (err) {
          toast(err.message, true);
        }
      };
    });
  } catch (err) {
    listEl.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
  }
}

/* =====================================================================
   15. VIRADA DO DIA (reset à meia-noite)
   ===================================================================== */
function checkDayChange() {
  if (todayKey() === currentDay) return;
  currentDay = todayKey();
  if (window.currentUser) {
    loadAuthenticatedApp(window.currentUser);
  }
  toast('NOVO DIA! SUAS MISSÕES FORAM REINICIADAS.');
}

/* =====================================================================
   16. EVENTOS DE INTERFACE E AUTENTICAÇÃO
   ===================================================================== */
function bindEvents() {
  // Eventos de Rede (Online / Offline)
  window.addEventListener('online', updateOnlineState);
  window.addEventListener('offline', updateOnlineState);

  // Alternar abas da tela de Login / Criar Conta
  document.querySelectorAll('[data-auth-mode]').forEach(btn => {
    btn.addEventListener('click', () => setAuthMode(btn.dataset.authMode));
  });
  $('#forgotPwdBtn')?.addEventListener('click', () => setAuthMode('forgot'));
  $('#backToLoginBtn')?.addEventListener('click', () => setAuthMode('login'));

  // Indicador de força de senha em tempo real
  $('#authPassword')?.addEventListener('input', e => {
    const val = e.target.value;
    const hint = $('#pwdStrengthHint');
    if (!hint || authMode !== 'signup') return;
    if (val.length < 8) {
      hint.textContent = `⚠ SENHA FRACA (${val.length}/8 CARACTERES MÍNIMOS)`;
      hint.className = 'pwd-strength weak';
    } else {
      hint.textContent = '✓ SENHA FORTE VÁLIDA';
      hint.className = 'pwd-strength strong';
    }
  });

  // Submissão do formulário de Login / Cadastro / Recuperação
  $('#authForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!navigator.onLine) {
      showAuthMessage('SEM CONEXÃO COM A INTERNET.', 'error');
      return;
    }
    const email = $('#authEmail').value.trim();
    const password = $('#authPassword').value;
    const username = $('#authUsername')?.value.trim() || '';
    const submitBtn = $('#authSubmitBtn');
    const prevTxt = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'AGUARDE...';
    showAuthMessage('');

    try {
      if (authMode === 'forgot') {
        await window.SB.auth.resetPasswordForEmail(email);
        showAuthMessage('LINK DE RECUPERAÇÃO ENVIADO! VERIFIQUE SEU E-MAIL.', 'success');
      } else if (authMode === 'signup') {
        const res = await window.SB.auth.signUp(email, password, username);
        if (res.user && !res.session) {
          showAuthMessage('CONTA CRIADA! VERIFIQUE SEU E-MAIL PARA CONFIRMAR O CADASTRO ANTES DE ENTRAR.', 'success');
        } else {
          toast('CONTA CRIADA E AUTENTICADA COM SUCESSO!');
        }
      } else {
        await window.SB.auth.signIn(email, password);
        toast('ACESSO AUTORIZADO!');
      }
    } catch (err) {
      showAuthMessage(err.message, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = prevTxt;
    }
  });

  // Botões OAuth 2.0 (Google, Discord, GitHub) com PKCE
  document.querySelectorAll('[data-oauth]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!navigator.onLine) {
        showAuthMessage('SEM CONEXÃO COM A INTERNET.', 'error');
        return;
      }
      const provider = btn.dataset.oauth;
      try {
        showAuthMessage(`REDIRECIONANDO PARA ${provider.toUpperCase()} (PKCE)...`);
        await window.SB.auth.signInWithOAuth(provider);
      } catch (err) {
        showAuthMessage(err.message, 'error');
      }
    });
  });

  // Configuração rápida de URL e Anon Key do Supabase no HUD
  $('#toggleSbConfigBtn')?.addEventListener('click', () => {
    const panel = $('#sbConfigPanel');
    panel.classList.toggle('hidden');
    const cfg = window.SB.getConfig();
    if (! cfg.url.includes('SEU-PROJETO-ID')) $('#sbUrlInput').value = cfg.url;
    if (! cfg.anonKey.includes('SUA_SUPABASE_ANON_KEY')) $('#sbAnonInput').value = cfg.anonKey;
  });

  $('#saveSbConfigBtn')?.addEventListener('click', () => {
    const url = $('#sbUrlInput').value.trim().replace(/\/auth\/v1\/callback\/?$/i, '').replace(/\/+$/, '');
    const key = $('#sbAnonInput').value.trim();
    if (!url.startsWith('http') || url.includes('SEU-PROJETO-ID') || !key) {
      showAuthMessage('INFORME UMA URL HTTPS VÁLIDA (EX: https://pbqgfsgouqvubofphevk.supabase.co) E A ANON PUBLIC KEY.', 'error');
      return;
    }
    if (!key.startsWith('eyJ') && !key.startsWith('sb_publishable_')) {
      showAuthMessage('CHAVE INVÁLIDA! AS CHAVES DO GITHUB/GOOGLE/DISCORD DEVEM SER COLADAS LÁ NO SITE DO SUPABASE (AUTHENTICATION > PROVIDERS), E NÃO AQUI.', 'error');
      return;
    }
    localStorage.setItem('sistemaMissoes.supabaseUrl', url);
    localStorage.setItem('sistemaMissoes.supabaseAnonKey', key);
    window.__ENV__ = { SUPABASE_URL: url, SUPABASE_ANON_KEY: key };
    window.SB.init();
    $('#sbConfigPanel').classList.add('hidden');
    showAuthMessage('CONEXÃO SUPABASE CONFIGURADA! VOCÊ JÁ PODE ENTRAR OU CRIAR SUA CONTA.', 'success');
    bindAuthStateListener();
  });

  // Botões de Conta e Sair na Topbar
  $('#accountSettingsBtn')?.addEventListener('click', openAccountSettings);
  $('#logoutBtn')?.addEventListener('click', async () => {
    if (!confirm('Deseja encerrar sua sessão atual?')) return;
    try {
      await window.SB.auth.signOut();
      window.currentUser = null;
      state = DEFAULT_STATE();
      setRouteProtection(false);
      toast('SESSÃO ENCERRADA COM SEGURANÇA.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Formulários do Modal de Configurações da Conta
  $('#usernameForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    if (!window.currentUser) return;
    const newName = $('#settingsUsername').value.trim();
    const btn = $('#saveUsernameBtn');
    btn.disabled = true;
    try {
      const updated = await window.SB.perfil.atualizarUsername(window.currentUser.id, newName);
      state.username = updated.username;
      toast(`CODINOME ATUALIZADO PARA @${updated.username.toUpperCase()}!`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('#passwordForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const newPwd = $('#settingsNewPassword').value;
    const btn = $('#savePasswordBtn');
    btn.disabled = true;
    try {
      await window.SB.auth.updatePassword(newPwd);
      $('#settingsNewPassword').value = '';
      toast('SENHA ATUALIZADA COM SUCESSO!');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('#deleteAccountBtn')?.addEventListener('click', async () => {
    const confirmText = prompt(
      'ATENÇÃO: Esta ação é irreversível e apagará seu perfil, personagem, missões, fotos e conquistas do banco.\n\nDigite EXCLUIR para confirmar:'
    );
    if (confirmText !== 'EXCLUIR') return;
    try {
      await window.SB.perfil.excluirMinhaConta();
      window.currentUser = null;
      state = DEFAULT_STATE();
      closeModal('accountModal');
      setRouteProtection(false);
      toast('SUA CONTA E TODOS OS DADOS FORAM EXCLUÍDOS PERMANENTEMENTE.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Eventos originais de Missões e Diário
  $('#addBtn').addEventListener('click', () => openTaskModal());
  $('#manageBtn').addEventListener('click', () => openTaskModal());
  $('#taskForm').addEventListener('submit', saveTask);
  $('#cancelEditBtn').addEventListener('click', resetTaskForm);

  $('#taskAdminList').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.edit) startEdit(b.dataset.edit);
    if (b.dataset.del) deleteTask(b.dataset.del);
  });
  $('#missionList').addEventListener('click', e => {
    const b = e.target.closest('[data-log]');
    if (b) openLogModal(b.dataset.log);
  });

  $('#logText').addEventListener('input', validateLog);
  $('#logPhoto').addEventListener('change', handlePhoto);
  $('#removePhoto').addEventListener('click', removePhoto);
  $('#completeBtn').addEventListener('click', completeMission);

  document.querySelectorAll('.modal').forEach(m => {
    m.addEventListener('click', e => {
      if (e.target === m || e.target.closest('[data-close]') || m.id === 'lightbox') m.classList.remove('open');
    });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
      $('#levelUp').classList.remove('active');
    }
  });
  $('#levelUp').addEventListener('click', () => $('#levelUp').classList.remove('active'));

  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    const diary = btn.dataset.tab === 'diary';
    $('#tabMissions').classList.toggle('hidden', diary);
    $('#tabDiary').classList.toggle('hidden', !diary);
    if (diary) renderDiary();
  }));

  $('#calPrev').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
  $('#calNext').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });
  $('#calGrid').addEventListener('click', e => {
    const d = e.target.closest('[data-day]'); if (!d) return;
    diaryFilter = diaryFilter === d.dataset.day ? null : d.dataset.day;
    renderDiary();
  });
  $('#clearFilterBtn').addEventListener('click', () => { diaryFilter = null; renderDiary(); });
  $('#diaryList').addEventListener('click', e => {
    const img = e.target.closest('[data-zoom]'); if (!img) return;
    $('#lightboxImg').src = img.src;
    openModal('lightbox');
  });

  setInterval(checkDayChange, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDayChange(); });
}

let authSubscription = null;
function bindAuthStateListener() {
  if (authSubscription) {
    authSubscription.unsubscribe();
    authSubscription = null;
  }
  const cfg = window.SB.getConfig();
  if (!cfg.isConfigured) {
    setRouteProtection(false);
    showAuthMessage('CONFIGURE A URL E A ANON KEY DO SEU PROJETO SUPABASE ABAIXO (OU EM JS/ENV.JS) PARA INICIAR.', 'info');
    $('#toggleSbConfigBtn')?.classList.remove('hidden');
    $('#sbConfigPanel')?.classList.remove('hidden');
    return;
  }

  // Oculta o painel de chaves na tela de login quando o projeto já está conectado em js/env.js
  $('#toggleSbConfigBtn')?.classList.add('hidden');
  $('#sbConfigPanel')?.classList.add('hidden');

  const { data } = window.SB.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      setRouteProtection(true);
      openAccountSettings();
      toast('DEFINA SUA NOVA SENHA NAS CONFIGURAÇÕES DA CONTA.');
      return;
    }
    if (session?.user) {
      if (!window.currentUser || window.currentUser.id !== session.user.id) {
        loadAuthenticatedApp(session.user);
      }
    } else {
      window.currentUser = null;
      setRouteProtection(false);
    }
  });
  authSubscription = data?.subscription || null;
}

/* =====================================================================
   17. INICIALIZAÇÃO
   ===================================================================== */
async function init() {
  $('#xpSegments').innerHTML = '<span></span>'.repeat(CONFIG.BAR_SEGMENTS);
  $('#xpSegments').style.gridTemplateColumns = `repeat(${CONFIG.BAR_SEGMENTS},1fr)`;
  buildDifficultyOptions();

  bindEvents();
  if (typeof initCharacter === 'function') initCharacter();
  if (typeof initGame === 'function') initGame();
  updateOnlineState();

  window.SB.init();
  bindAuthStateListener();

  // Captura eventuais erros de callback OAuth retornados na URL (?error=... ou #error=...)
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const urlErrDesc = searchParams.get('error_description') || hashParams.get('error_description') || searchParams.get('error') || hashParams.get('error');
  if (urlErrDesc) {
    showAuthMessage(window.SB.translateError({ message: decodeURIComponent(urlErrDesc.replace(/\+/g, ' ')) }), 'error');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Verifica sessão existente no carregamento
  try {
    const session = await window.SB.auth.getSession();
    if (session?.user && !window.currentUser) {
      await loadAuthenticatedApp(session.user);
    } else if (!session) {
      setRouteProtection(false);
    }
  } catch (err) {
    setRouteProtection(false);
    showAuthMessage(err.message, 'error');
  }
}

init();
