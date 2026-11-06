/* Sistema de Missões — Lógica Principal & Integração Supabase */
/* =====================================================================
   1. CONSTANTES DE JOGO  (ajuste XP, limites e regras aqui)
   ===================================================================== */
const CONFIG = {
  XP_BY_DIFFICULTY: { facil: 10, media: 25, dificil: 50, epica: 100 },
  TICKETS_BY_DIFFICULTY: { facil: 1, media: 2, dificil: 3, epica: 5 },
  DIFFICULTY_LABELS:{ facil: 'FÁCIL', media: 'MÉDIA', dificil: 'DIFÍCIL', epica: 'ÉPICA' },
  BASE_XP_TO_LEVEL: 100,      // XP do nível 1 <i data-ico="arrowRight"></i> 2
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
  privacy: 'publico',
  moldura_equipada: null,
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
    pill.innerHTML = `${pxIcon('warn')} OFFLINE`;
  } else if (mode === 'syncing') {
    pill.classList.add('syncing');
    pill.innerHTML = `${pxIcon('reset')} ${escapeHTML(customText || 'SINCRONIZANDO...')}`;
  } else if (mode === 'error') {
    pill.classList.add('error');
    pill.innerHTML = `${pxIcon('close')} ${escapeHTML(customText || 'ERRO DE REDE')}`;
  } else {
    pill.innerHTML = `${pxIcon('dot')} ${escapeHTML(customText || 'ONLINE • SUPABASE')}`;
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
    // clamp mantém a etiqueta de % sempre dentro da tela (no celular ela cortava na borda)
    tag.style.left = `clamp(22px, ${p}%, calc(100% - 22px))`;
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
  $('#streakText').innerHTML = `<i data-ico="flame"></i> SEQUÊNCIA: ${st} ${st === 1 ? 'DIA' : 'DIAS'}${bonus ? ` • +${bonus}% XP` : ''}`;
  $('#levelNum').firstChild.textContent = state.level;
}

function renderAchievements(justUnlocked = []) {
  const ach = state.achievements;
  $('#achList').innerHTML = ACHIEVEMENTS.map(a => {
    const on = (a.daily ? ach.daily : ach.permanent)[a.id];
    return `<li class="ach-item ${on ? 'unlocked' : ''} ${justUnlocked.includes(a.id) ? 'just-unlocked' : ''}">
      <span class="ach-icon">${on ? '<i data-ico="check"></i>' : ''}</span><span>${a.label}</span></li>`;
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
          <span class="tkt-chip" title="Fichas de entrada na Cidade"><i data-ico="ticket"></i> +${tkts} ${tkts === 1 ? 'FICHA' : 'FICHAS'}</span>
        </div>
      </div>
      ${done ? `<span class="done-chip"><i data-ico="check"></i> CONCLUÍDA HOJE</span>`
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
            <div class="entry-time"><i data-ico="clock"></i> ${new Date(r.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>
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
    <label for="diff_${k}">${CONFIG.DIFFICULTY_LABELS[k]}<small>${CONFIG.XP_BY_DIFFICULTY[k]} XP • <i data-ico="ticket"></i> +${CONFIG.TICKETS_BY_DIFFICULTY[k]}</small></label>`).join('');
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
        ${t.category && typeof CATEGORIES !== 'undefined' && CATEGORIES[t.category] ? `<span class="cat-badge">${pxIcon(CATEGORIES[t.category].icon)}</span>` : ''}
        <span class="badge ${t.difficulty}">${CONFIG.DIFFICULTY_LABELS[t.difficulty]}</span>
        <button class="icon-btn" data-edit="${t.id}" title="Editar" aria-label="Editar"><i data-ico="pencil"></i></button>
        <button class="icon-btn del" data-del="${t.id}" title="Excluir" aria-label="Excluir"><i data-ico="trash"></i></button>
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
    hint.innerHTML = ok
      ? '<i data-ico="check"></i> REGISTRO VÁLIDO. PRONTO PARA ENVIAR AO SERVIDOR!'
      : '<i data-ico="warn"></i> ENVIE UMA FOTO (PNG/JPG/WEBP ATÉ 5 MB) OU ESCREVA UMA DESCRIÇÃO PARA CONCLUIR.';
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
  el.innerHTML = typeof pxText === 'function' ? pxText(escapeHTML(msg)) : escapeHTML(msg);
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
      privacy: prof?.privacy || 'publico',
      moldura_equipada: prof?.moldura_equipada || null,
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

    // 5. Inicializa canais Realtime sociais (Presence global + Postgres Changes em friendships/notifications)
    await initSocialRealtime(user.id);

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
      btn.innerHTML = '<i data-ico="upload"></i> IMPORTAR PARA MINHA CONTA';
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
  { id: 'github',  name: 'GITHUB',  desc: 'OAuth 2.0 Identity' }
];

async function openAccountSettings() {
  if (!window.currentUser) return;
  $('#accountEmailDisplay').textContent = `E-MAIL DA CONTA: ${window.currentUser.email || 'PROVEDOR EXTERNO'} • ID: ${window.currentUser.id.slice(0, 8)}`;
  $('#settingsUsername').value = state.username || '';
  if ($('#settingsPrivacy')) $('#settingsPrivacy').value = ['publico', 'amigos', 'privado'].includes(state.privacy) ? state.privacy : 'publico';
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
            <b>${prov.name} ${linked ? '<i data-ico="check"></i> CONECTADO' : ''}</b>
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
      hint.innerHTML = `<i data-ico="warn"></i> SENHA FRACA (${val.length}/8 CARACTERES MÍNIMOS)`;
      hint.className = 'pwd-strength weak';
    } else {
      hint.innerHTML = '<i data-ico="check"></i> SENHA FORTE VÁLIDA';
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
      await cleanupAllSocialSubscriptions();
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
    const newPrivacy = $('#settingsPrivacy') ? $('#settingsPrivacy').value : 'publico';
    const btn = $('#saveUsernameBtn');
    btn.disabled = true;
    try {
      const updated = await window.SB.perfil.atualizarUsername(window.currentUser.id, newName);
      await window.SB.perfil.atualizarPrivacidade(window.currentUser.id, { privacy: newPrivacy });
      state.username = updated.username;
      state.privacy = newPrivacy;
      toast(`PERFIL ATUALIZADO: @${updated.username.toUpperCase()} (${newPrivacy.toUpperCase()})!`);
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
      await cleanupAllSocialSubscriptions();
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

  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', async () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $('#tabMissions').classList.toggle('hidden', tab !== 'missions');
    $('#tabDiary').classList.toggle('hidden', tab !== 'diary');
    $('#tabSocial')?.classList.toggle('hidden', tab !== 'social');
    $('#tabRanking')?.classList.toggle('hidden', tab !== 'ranking');

    // Se saiu da aba social, cancela assinatura Realtime da conversa ativa (supabase.removeChannel)
    if (tab !== 'social' && window.SB?.services?.chat) {
      await window.SB.services.chat.desconectarConversaAtiva();
    }

    if (tab === 'diary') renderDiary();
    if (tab === 'social') switchSocialSubSection(activeSocialSec);
    if (tab === 'ranking') renderRankingTab();
  }));

  bindSocialAndRankingEvents();

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

/* =====================================================================
   16.5 CAMADA SOCIAL, CHAT REALTIME, ESQUADRÕES, CO-OP & RANKINGS
   ===================================================================== */
let activeSocialSec = 'friends';
let activeConversationId = '00000000-0000-0000-0000-000000000001'; // Canal Global padrão
let activeConversationTitle = 'REDE GLOBAL DE AGENTES';

/** Remove emoji do começo de um título (os canais agora usam ícones pixel art) */
function stripLeadingEmoji(text) {
  return String(text || '').replace(/^[\p{Extended_Pictographic}\u2190-\u21FF\u2600-\u27BF\uFE0F\s:]+/u, '').trim() || String(text || '');
}
let loadedChatMessages = [];
let pendingChatAttachmentFile = null;
let typingUsersMap = {}; // { username: timeoutId }
let activeRankCat = 'xp';
let activeRankPeriod = 'weekly';

/** Cancela todas as assinaturas Realtime ao sair da conta ou fechar canais (supabase.removeChannel) */
async function cleanupAllSocialSubscriptions() {
  try {
    if (window.SB?.services?.chat) await window.SB.services.chat.desconectarConversaAtiva();
    if (window.SB?.services?.amigos) await window.SB.services.amigos.desconectarTudo();
    if (window.SB?.services?.multiplayer) await window.SB.services.multiplayer.sairDaSala();
  } catch {}
}

/** Inicializa Presence Global e Postgres Changes em friendships e notifications */
async function initSocialRealtime(userId) {
  if (!window.SB?.services?.amigos) return;
  try {
    window.SB.services.amigos.conectarPresenceGlobal(userId, 'online', () => {
      if (!$('#tabSocial')?.classList.contains('hidden') && activeSocialSec === 'friends') {
        renderFriendsSection();
      }
    });

    window.SB.services.amigos.assinarEventosSociais(userId, {
      onFriendshipChange: () => {
        if (!$('#tabSocial')?.classList.contains('hidden') && activeSocialSec === 'friends') {
          renderFriendsSection();
        }
        refreshUnreadBadges();
      },
      onNotification: newNotif => {
        if (newNotif?.titulo) toast(`🔔 ${newNotif.titulo}`);
        refreshUnreadBadges();
        if (!$('#tabSocial')?.classList.contains('hidden') && activeSocialSec === 'notifs') {
          renderNotificationsSection();
        }
      }
    });

    await refreshUnreadBadges();
  } catch {}
}

async function refreshUnreadBadges() {
  if (!window.currentUser || !window.SB?.services?.amigos) return;
  try {
    const uid = window.currentUser.id;
    const [notifs, convs] = await Promise.all([
      window.SB.services.amigos.listarNotificacoes(uid, 30),
      window.SB.services.chat?.listarConversasComNaoLidas
        ? window.SB.services.chat.listarConversasComNaoLidas(uid).catch(() => [])
        : Promise.resolve([])
    ]);
    const unreadNotifs = (notifs || []).filter(n => !n.lida).length;
    const unreadChat = (convs || []).reduce((acc, c) => acc + (c.unreadCount || 0), 0);
    const total = unreadNotifs + unreadChat;

    const mainBadge = $('#socialUnreadBadge');
    if (mainBadge) {
      mainBadge.textContent = total;
      mainBadge.classList.toggle('hidden', total <= 0);
    }
    const chatBadge = $('#chatSubUnread');
    if (chatBadge) {
      chatBadge.textContent = unreadChat;
      chatBadge.classList.toggle('hidden', unreadChat <= 0);
    }
    const notifBadge = $('#notifSubUnread');
    if (notifBadge) {
      notifBadge.textContent = unreadNotifs;
      notifBadge.classList.toggle('hidden', unreadNotifs <= 0);
    }
  } catch {}
}

async function switchSocialSubSection(sec) {
  const prevSec = activeSocialSec;
  activeSocialSec = sec;

  document.querySelectorAll('[data-social-sec]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.socialSec === sec);
  });

  $('#socialSecFriends')?.classList.toggle('hidden', sec !== 'friends');
  $('#socialSecChat')?.classList.toggle('hidden', sec !== 'chat');
  $('#socialSecGroups')?.classList.toggle('hidden', sec !== 'groups');
  $('#socialSecCoop')?.classList.toggle('hidden', sec !== 'coop');
  $('#socialSecNotifs')?.classList.toggle('hidden', sec !== 'notifs');

  // Se saiu da aba de chat, remove o canal Realtime da conversa ativa
  if (prevSec === 'chat' && sec !== 'chat' && window.SB?.services?.chat) {
    await window.SB.services.chat.desconectarConversaAtiva();
  }

  if (sec === 'friends') await renderFriendsSection();
  if (sec === 'chat') await renderChatSection();
  if (sec === 'groups') await renderGroupsSection();
  if (sec === 'coop') renderCoopLobbyUI();
  if (sec === 'notifs') await renderNotificationsSection();
}

/* --------------------- 1. AMIGOS, PRESENCE E BLOQUEIOS --------------------- */
async function renderFriendsSection() {
  if (!window.SB?.services?.amigos) return;
  const acceptedEl = $('#friendsAcceptedList');
  const pendingEl = $('#friendsPendingList');
  const blockedEl = $('#friendsBlockedList');
  if (!acceptedEl) return;

  try {
    if (!window.currentUser) return;
    const amigos = window.SB.services.amigos;
    const data = await amigos.listarRelacoes(window.currentUser.id);

    if (!data.accepted.length) {
      acceptedEl.innerHTML = `<div class="empty">NENHUM ALIADO ADICIONADO AINDA.<br>CONVIDE PELO @USERNAME ACIMA!</div>`;
    } else {
      acceptedEl.innerHTML = data.accepted.map(f => {
        const p = f.friendProfile || {};
        const peerId = p.id;
        // Presence usa 'online' | 'jogando' | 'offline'; a classe CSS do ponto usa 'playing'
        const rawSt = amigos.obterStatusAgente(peerId);
        const st = rawSt === 'jogando' ? 'playing' : rawSt;
        const stLabel = st === 'playing' ? '<i data-ico="gamepad"></i> EM MISSÃO NA CIDADE' : st === 'online' ? '<i data-ico="dot"></i> ONLINE AGORA' : '<i data-ico="ring"></i> OFFLINE';
        return `
          <div class="social-item">
            <div class="social-user-meta">
              <span class="presence-dot ${st}" title="${stLabel}"></span>
              <div>
                <div style="font-weight:700;font-size:14px">@${escapeHTML(p.username || 'agente')} <span style="color:var(--lime);font-size:11px">NV.${p.level || 1}</span></div>
                <div style="font-size:11px;color:var(--mint)">${stLabel} • <i data-ico="flame"></i> ${p.streak_atual || 0}d</div>
              </div>
            </div>
            <div class="social-actions">
              <button type="button" class="small-btn" data-open-dm="${peerId}" data-dm-name="@${escapeHTML(p.username || 'agente')}"><i data-ico="chat"></i> DM</button>
              <button type="button" class="small-btn" data-remove-friend="${f.id}" title="Desfazer amizade" aria-label="Desfazer amizade"><i data-ico="close"></i></button>
              <button type="button" class="small-btn" data-block-user="${peerId}" title="Bloquear agente" aria-label="Bloquear agente"><i data-ico="block"></i></button>
            </div>
          </div>`;
      }).join('');
    }

    const allPending = [...data.incoming, ...data.outgoing];
    if (!allPending.length) {
      pendingEl.innerHTML = `<div class="empty">NENHUMA SOLICITAÇÃO PENDENTE.</div>`;
    } else {
      pendingEl.innerHTML = allPending.map(f => {
        const p = f.friendProfile || {};
        const isIncoming = f.direction === 'incoming';
        return `
          <div class="social-item">
            <div>
              <div style="font-weight:700">@${escapeHTML(p.username || 'agente')} <small style="color:var(--cyan)">(NV.${p.level || 1})</small></div>
              <div style="font-size:11px;opacity:.8">${isIncoming ? 'RECEBIDO • AGUARDANDO SUA RESPOSTA' : 'ENVIADO • AGUARDANDO CONFIRMAÇÃO'}</div>
            </div>
            <div class="social-actions">
              ${isIncoming
                ? `<button type="button" class="small-btn" style="border-color:var(--lime);color:var(--lime)" data-accept-friend="${f.id}"><i data-ico="check"></i> ACEITAR</button>
                   <button type="button" class="small-btn" data-reject-friend="${f.id}"><i data-ico="close"></i> RECUSAR</button>`
                : `<button type="button" class="small-btn" data-remove-friend="${f.id}">CANCELAR</button>`
              }
            </div>
          </div>`;
      }).join('');
    }

    if (!data.blocks.length) {
      blockedEl.innerHTML = `<div class="empty">NENHUM AGENTE BLOQUEADO.</div>`;
    } else {
      blockedEl.innerHTML = data.blocks.map(b => `
        <div class="social-item">
          <div style="font-size:12px"><i data-ico="block"></i> <b>@${escapeHTML(b.blockedProfile?.username || b.blocked_id.slice(0, 8))}</b></div>
          <button type="button" class="small-btn" data-unblock-user="${b.blocked_id}">DESBLOQUEAR</button>
        </div>
      `).join('');
    }
  } catch (err) {
    acceptedEl.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
  }
}

/* --------------------- 2. CHAT REALTIME (GLOBAL, GRUPO E DM) --------------------- */
async function renderChatSection() {
  if (!window.SB?.services?.chat) return;
  const listEl = $('#chatConversationsList');
  if (!listEl) return;

  try {
    if (!window.currentUser) return;
    const convs = await window.SB.services.chat.listarConversasComNaoLidas(window.currentUser.id);
    if (!convs.length) {
      listEl.innerHTML = `<div class="empty">NENHUM CANAL DISPONÍVEL.</div>`;
      return;
    }

    if (!convs.some(c => c.id === activeConversationId)) {
      activeConversationId = convs[0].id;
      activeConversationTitle = convs[0].titulo || 'REDE GLOBAL DE AGENTES';
    }

    listEl.innerHTML = convs.map(c => {
      // O serviço já devolve o título com ícone (ex.: "🌐 REDE GLOBAL", "💬 @FULANO", "🛡️ ESQUADRÃO [TAG]")
      const fallback = c.tipo === 'global' ? 'REDE GLOBAL' : c.tipo === 'group' ? 'CHAT DO ESQUADRÃO' : 'MENSAGEM DIRETA';
      const label = stripLeadingEmoji(c.titulo || fallback);
      const convIco = c.tipo === 'global' ? 'globe' : c.tipo === 'group' ? 'shield' : 'chat';
      return `
        <button type="button" class="chat-conv-btn ${c.id === activeConversationId ? 'active' : ''}" data-select-conv="${c.id}" data-conv-title="${escapeHTML(label)}">
          <span>${pxIcon(convIco)} ${escapeHTML(label)}</span>
          ${c.unreadCount > 0 ? `<span class="mini-badge">${c.unreadCount}</span>` : ''}
        </button>`;
    }).join('');

    await openChatConversation(activeConversationId, activeConversationTitle);
  } catch (err) {
    listEl.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
  }
}

async function openChatConversation(convId, title) {
  activeConversationId = convId;
  if (title) activeConversationTitle = title;
  $('#chatActiveTitle').textContent = stripLeadingEmoji(activeConversationTitle);
  const box = $('#chatMessagesBox');
  box.innerHTML = `<div class="empty">SINCRONIZANDO MENSAGENS CRIPTOGRAFADAS...</div>`;

  document.querySelectorAll('.chat-conv-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.selectConv === convId);
  });

  try {
    const page = await window.SB.services.chat.carregarMensagensPaginadas(convId, { limit: 30 });
    loadedChatMessages = page.messages || [];
    $('#chatLoadMoreBtn')?.classList.toggle('hidden', !page.hasMore);
    await renderChatMessagesList(true);

    await window.SB.services.chat.marcarComoLida(convId);
    refreshUnreadBadges();

    window.SB.services.chat.assinarConversa(convId, {
      onNewMessage: async newMsg => {
        if (!loadedChatMessages.some(m => m.id === newMsg.id)) {
          loadedChatMessages.push(newMsg);
          await renderChatMessagesList(true);
          await window.SB.services.chat.marcarComoLida(convId);
        }
      },
      onTyping: payload => {
        if (!payload?.username || payload.user_id === window.currentUser?.id) return;
        clearTimeout(typingUsersMap[payload.username]);
        typingUsersMap[payload.username] = setTimeout(() => {
          delete typingUsersMap[payload.username];
          updateTypingIndicatorUI();
        }, 2600);
        updateTypingIndicatorUI();
      }
    });
  } catch (err) {
    box.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
  }
}

function updateTypingIndicatorUI() {
  const el = $('#chatTypingIndicator');
  if (!el) return;
  const names = Object.keys(typingUsersMap);
  if (!names.length) {
    el.classList.add('hidden');
    el.textContent = '';
  } else {
    el.classList.remove('hidden');
    el.innerHTML = `<i data-ico="keyboard"></i> ${escapeHTML(names.map(n => '@' + n).join(', '))} está digitando...`;
  }
}

async function renderChatMessagesList(scrollToBottom = false) {
  const box = $('#chatMessagesBox');
  if (!box) return;
  if (!loadedChatMessages.length) {
    box.innerHTML = `<div class="empty">NENHUMA TRANSMISSÃO NESTE CANAL AINDA. SEJA O PRIMEIRO!</div>`;
    return;
  }

  box.innerHTML = loadedChatMessages.map(m => {
    const isMine = m.sender_id === window.currentUser?.id;
    const senderName = m.is_system ? 'SISTEMA HUD' : `@${m.sender?.username || 'agente'}`;
    const timeStr = new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="chat-msg ${isMine ? 'mine' : ''} ${m.is_system ? 'system' : ''} ${m.flagged_for_review ? 'flagged' : ''}">
        <div class="chat-msg-head">
          <span>${escapeHTML(senderName)} ${m.sender?.level ? `(NV.${m.sender.level})` : ''}</span>
          <span>
            ${timeStr}
            ${!isMine && !m.is_system ? `<button type="button" class="icon-btn" style="padding:0 4px;font-size:10px;margin-left:4px" data-report-msg="${m.id}" title="Denunciar mensagem" aria-label="Denunciar mensagem"><i data-ico="flag"></i></button>` : ''}
          </span>
        </div>
        <div class="chat-msg-body">${escapeHTML(m.content)}</div>
        ${m.attachment_url ? `<div style="margin-top:4px;font-size:11px;color:var(--cyan)"><i data-ico="image"></i> Anexo protegido: <button type="button" class="small-btn" data-open-chat-att="${escapeHTML(m.signedAttachmentUrl || '')}">ABRIR IMAGEM</button></div>` : ''}
      </div>`;
  }).join('');

  if (scrollToBottom) {
    box.scrollTop = box.scrollHeight;
  }
}

/* --------------------- 3. ESQUADRÕES (GROUPS) & METAS SEMANAIS --------------------- */
async function renderGroupsSection() {
  const wrap = $('#groupContainer');
  if (!wrap || !window.SB?.services?.grupos) return;
  wrap.innerHTML = `<div class="empty">CARREGANDO DADOS DO ESQUADRÃO...</div>`;

  try {
    if (!window.currentUser) return;
    const myGroupData = await window.SB.services.grupos.carregarMeuGrupo(window.currentUser.id);

    if (!myGroupData?.inGroup) {
      const publicGroups = await window.SB.services.grupos.listarGruposPublicos();
      wrap.innerHTML = `
        <div class="social-two-col">
          <div class="social-card">
            <div class="panel-title">FUNDAR NOVO ESQUADRÃO (MÁX. 30 AGENTES)</div>
            <form id="createGroupForm" style="display:flex;flex-direction:column;gap:10px">
              <input type="text" class="input" id="newGroupName" maxlength="32" minlength="3" required placeholder="Nome único do Esquadrão (ex.: ESQUADRÃO NEON)">
              <input type="text" class="input" id="newGroupTag" maxlength="5" placeholder="TAG de 2 a 5 letras (opcional, ex.: NEON)">
              <input type="text" class="input" id="newGroupDesc" maxlength="240" placeholder="Lema ou descrição tática do clã...">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                <select class="input" id="newGroupJoinType">
                  <option value="open">ABERTO (ENTRADA IMEDIATA)</option>
                  <option value="invite">APENAS POR CÓDIGO/CONVITE</option>
                  <option value="request">SOLICITAÇÃO</option>
                </select>
                <label class="btn ghost" style="text-align:center;cursor:pointer">
                  <i data-ico="shield"></i> EMBLEMA (OPCIONAL)
                  <input type="file" id="newGroupEmblemFile" accept="image/png,image/jpeg,image/webp" class="hidden">
                </label>
              </div>
              <button type="submit" class="btn green"><i data-ico="bolt"></i> CRIAR ESQUADRÃO</button>
            </form>

            <div class="panel-title" style="margin-top:18px">ENTRAR POR CÓDIGO DE CONVITE</div>
            <form id="joinGroupByCodeForm" class="social-bar-form" style="margin-bottom:0">
              <input type="text" class="input" id="groupInviteCodeInput" maxlength="12" placeholder="Código do Esquadrão (ex.: OMEGA77)">
              <button type="submit" class="btn ghost">ENTRAR</button>
            </form>
          </div>

          <div class="social-card">
            <div class="panel-title">ESQUADRÕES ATIVOS NA REDE</div>
            <div class="social-list">
              ${publicGroups.length ? publicGroups.map(g => `
                <div class="social-item">
                  <div>
                    <div style="font-weight:700;color:var(--lime)"><i data-ico="shield"></i> [${escapeHTML(g.tag || '')}] ${escapeHTML(g.nome)} <small style="color:var(--cyan)">(${g.total_membros || 1}/${g.max_members || 30})</small></div>
                    <div style="font-size:11px;opacity:.8;text-transform:none">${escapeHTML(g.descricao || 'Sem descrição.')}</div>
                  </div>
                  ${g.join_type === 'open'
                    ? `<button type="button" class="small-btn" data-join-group-id="${g.group_id}">ENTRAR</button>`
                    : `<span class="badge media">${g.join_type.toUpperCase()}</span>`
                  }
                </div>
              `).join('') : `<div class="empty">NENHUM ESQUADRÃO CRIADO AINDA.</div>`}
            </div>
          </div>
        </div>
      `;

      $('#createGroupForm')?.addEventListener('submit', async e => {
        e.preventDefault();
        const name = $('#newGroupName').value.trim();
        const tag = ($('#newGroupTag')?.value || '').trim();
        const description = $('#newGroupDesc').value.trim();
        const joinType = $('#newGroupJoinType').value;
        const emblemFile = $('#newGroupEmblemFile')?.files?.[0] || null;
        try {
          setSyncStatus('syncing', 'CRIANDO ESQUADRÃO...');
          // A TAG é opcional: o servidor gera uma a partir do nome se vier vazia
          const created = await window.SB.services.grupos.criarGrupo({ nome: name, tag: tag || null, descricao: description, joinType });
          // O emblema só pode ser enviado depois que o grupo existe (o caminho usa o ID do grupo)
          if (emblemFile && created?.group?.id) {
            try {
              await window.SB.services.grupos.uploadEmblemaGrupo(created.group.id, emblemFile);
            } catch (upErr) {
              toast(`ESQUADRÃO CRIADO, MAS O EMBLEMA FALHOU: ${upErr.message}`, true);
            }
          }
          setSyncStatus('online');
          toast(`ESQUADRÃO "${name.toUpperCase()}" FUNDADO COM SUCESSO!`);
          await renderGroupsSection();
        } catch (err) {
          setSyncStatus('error');
          toast(err.message, true);
        }
      });

      $('#joinGroupByCodeForm')?.addEventListener('submit', async e => {
        e.preventDefault();
        const codigo = $('#groupInviteCodeInput').value.trim();
        if (!codigo) return;
        try {
          await window.SB.services.grupos.entrarGrupo(codigo);
          toast('VOCÊ ENTROU NO ESQUADRÃO!');
          await renderGroupsSection();
        } catch (err) {
          toast(err.message, true);
        }
      });

      wrap.querySelectorAll('[data-join-group-id]').forEach(btn => {
        btn.onclick = async () => {
          try {
            await window.SB.services.grupos.entrarGrupo(btn.dataset.joinGroupId);
            toast('VOCÊ ENTROU NO ESQUADRÃO!');
            await renderGroupsSection();
          } catch (err) {
            toast(err.message, true);
          }
        };
      });
      return;
    }

    // Usuário pertence a um Esquadrão
    const { group, myRole, members, goals, conversationId: groupConversationId } = myGroupData;
    const isLeader = myRole === 'leader';
    const isOfficerOrLeader = myRole === 'leader' || myRole === 'officer';

    wrap.innerHTML = `
      <div class="social-two-col">
        <div class="social-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px">
            <div>
              <div style="font-family:'Orbitron',sans-serif;font-size:16px;font-weight:900;color:var(--lime)">
                <i data-ico="shield"></i> [${escapeHTML(group.tag || '')}] ${escapeHTML(group.nome)}
              </div>
              <div style="font-size:12px;color:var(--mint);text-transform:none">${escapeHTML(group.descricao || '')}</div>
              <div style="font-size:11px;margin-top:6px;color:var(--cyan)">
                CÓDIGO DE CONVITE: <b>${escapeHTML(group.codigo || '')}</b> • SEU CARGO: <b>${myRole.toUpperCase()}</b>
              </div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              ${groupConversationId ? `<button type="button" class="small-btn" id="openGroupChatBtn"><i data-ico="chat"></i> CHAT DO CLÃ</button>` : ''}
              <button type="button" class="small-btn" id="leaveGroupBtn" style="border-color:#FF5A5A;color:#FF8080"><i data-ico="exit"></i> SAIR</button>
            </div>
          </div>

          <div class="panel-title">METAS SEMANAIS COLETIVAS (ATUALIZADAS VIA TRIGGER)</div>
          <div class="social-list">
            ${goals.length ? goals.map(gl => {
              const pct = Math.min(100, Math.floor((gl.progresso / Math.max(1, gl.meta)) * 100));
              return `
                <div class="social-item" style="flex-direction:column;align-items:stretch">
                  <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700">
                    <span>${gl.concluida ? '<i data-ico="check"></i> ' : '<i data-ico="target"></i> '}${escapeHTML(gl.titulo || '')}</span>
                    <span style="color:var(--lime)">${gl.progresso} / ${gl.meta} (${pct}%) • <i data-ico="coin"></i> +${gl.recompensa_moedas}</span>
                  </div>
                  <div class="group-goal-bar"><div class="group-goal-fill" style="width:${pct}%"></div></div>
                </div>`;
            }).join('') : `<div class="empty">NENHUMA META SEMANAL ATIVA.</div>`}
          </div>
        </div>

        <div class="social-card">
          <div class="panel-title">MEMBROS DO ESQUADRÃO (${members.length}/${group.max_members || 30})</div>
          <div class="social-list">
            ${members.map(m => {
              const p = m.profile || {};
              const isMe = m.user_id === window.currentUser?.id;
              return `
                <div class="social-item">
                  <div>
                    <div style="font-weight:700">
                      @${escapeHTML(p.username || 'agente')}
                      <span class="badge ${m.role === 'leader' ? 'epica' : m.role === 'officer' ? 'dificil' : 'facil'}">${m.role.toUpperCase()}</span>
                    </div>
                    <div style="font-size:11px;color:var(--mint)">NV.${p.level || 1} • <i data-ico="bolt"></i> ${p.xp_total || 0} XP</div>
                  </div>
                  <div class="social-actions">
                    ${isLeader && !isMe && m.role === 'member' ? `<button type="button" class="small-btn" data-promote-member="${m.user_id}" data-role="officer"><i data-ico="triUp"></i> OFICIAL</button>` : ''}
                    ${isLeader && !isMe && m.role === 'officer' ? `<button type="button" class="small-btn" data-promote-member="${m.user_id}" data-role="member"><i data-ico="triDown"></i> MEMBRO</button>` : ''}
                    ${isOceanLeaderCanKick(isOfficerOrLeader, myRole, m.role, isMe) ? `<button type="button" class="small-btn" data-kick-member="${m.user_id}"><i data-ico="close"></i> EXPULSAR</button>` : ''}
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>
      </div>
    `;

    $('#openGroupChatBtn')?.addEventListener('click', async () => {
      activeConversationId = groupConversationId;
      activeConversationTitle = `ESQUADRÃO [${group.tag || ''}]`;
      await switchSocialSubSection('chat');
    });

    $('#leaveGroupBtn')?.addEventListener('click', async () => {
      if (!confirm('Deseja sair do esquadrão? (Se você for o líder, a liderança será transferida automaticamente).')) return;
      try {
        await window.SB.services.grupos.sairDoGrupo();
        toast('VOCÊ SAIU DO ESQUADRÃO.');
        await renderGroupsSection();
      } catch (err) {
        toast(err.message, true);
      }
    });

    wrap.querySelectorAll('[data-promote-member]').forEach(btn => {
      btn.onclick = async () => {
        try {
          await window.SB.services.grupos.promoverMembro(btn.dataset.promoteMember, btn.dataset.role);
          toast('CARGO ATUALIZADO!');
          await renderGroupsSection();
        } catch (err) {
          toast(err.message, true);
        }
      };
    });

    wrap.querySelectorAll('[data-kick-member]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Expulsar este agente do esquadrão?')) return;
        try {
          await window.SB.services.grupos.expulsarMembro(btn.dataset.kickMember);
          toast('AGENTE EXPULSO DO ESQUADRÃO.');
          await renderGroupsSection();
        } catch (err) {
          toast(err.message, true);
        }
      };
    });
  } catch (err) {
    wrap.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
  }
}

function isOceanLeaderCanKick(isOfficerOrLeader, myRole, targetRole, isMe) {
  if (isMe || !isOfficerOrLeader) return false;
  if (myRole === 'leader') return true;
  return myRole === 'officer' && targetRole === 'member';
}

/* --------------------- 4. SALA COOPERATIVA MULTIPLAYER --------------------- */
/** Resumo da sala ativa no formato usado pela interface do lobby */
function getCoopRoomInfo() {
  const mp = window.SB?.services?.multiplayer;
  const room = mp?.obterSalaAtiva?.() || null;
  return {
    roomId: room?.id || null,
    code: room?.code || '',
    seed: room?.seed,
    isHost: Boolean(mp?.souHost?.())
  };
}

async function renderCoopLobbyUI() {
  const box = $('#coopLobbyContent');
  if (!box || !window.SB?.services?.multiplayer) return;
  const active = getCoopRoomInfo();
  if (!active.roomId) {
    box.innerHTML = `<div class="empty">NENHUMA SALA ATIVA NO MOMENTO.<br>CRIE UMA SALA OU DIGITE O CÓDIGO DE UM ALIADO.</div>`;
    return;
  }

  try {
    const { players } = await window.SB.services.multiplayer.sincronizarParticipantesBanco(active.roomId);
    box.innerHTML = `
      <div style="text-align:left">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div>
            <span style="font-size:11px;color:var(--mint)">CÓDIGO DA SALA:</span>
            <b style="font-family:'Orbitron',sans-serif;font-size:18px;color:var(--lime);margin-left:6px">${escapeHTML(active.code || '')}</b>
          </div>
          <span class="badge ${active.isHost ? 'epica' : 'facil'}">${active.isHost ? 'HOST (AUTORIDADE)' : 'CONECTADO'}</span>
        </div>
        <div class="panel-title">AGENTES NA FREQUÊNCIA (${players.length}/4)</div>
        <div class="social-list" style="margin-bottom:12px">
          ${players.map(p => `
            <div class="social-item">
              <span><i data-ico="gamepad"></i> <b>@${escapeHTML(p.character_snapshot?.username || p.character_snapshot?.nome || 'agente')}</b> (NV.${p.character_snapshot?.level || 1})</span>
              <span style="color:var(--lime);font-size:11px"><i data-ico="dot"></i> PRONTO</span>
            </div>
          `).join('')}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${active.isHost
            ? `<button type="button" class="btn green" id="hostStartCoopBtn"><i data-ico="play"></i> INICIAR MISSÃO CO-OP</button>`
            : `<div style="font-size:12px;color:var(--cyan);padding:8px 0">AGUARDANDO O HOST INICIAR A PARTIDA...</div>`
          }
          <button type="button" class="btn red" id="leaveCoopRoomBtn">SAIR DA SALA</button>
        </div>
      </div>
    `;

    $('#hostStartCoopBtn')?.addEventListener('click', async () => {
      try {
        const started = await window.SB.services.multiplayer.iniciarPartidaSala();
        if (typeof window.startCoopCityMission === 'function') {
          window.startCoopCityMission({ roomId: active.roomId, seed: started.seed, isHost: true });
        }
      } catch (err) {
        toast(err.message, true);
      }
    });

    $('#leaveCoopRoomBtn')?.addEventListener('click', async () => {
      await window.SB.services.multiplayer.sairDaSala();
      renderCoopLobbyUI();
      toast('VOCÊ SAIU DA SALA COOPERATIVA.');
    });
  } catch (err) {
    box.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
  }
}

/**
 * Callbacks do canal `room:{id}` no formato do serviço de multiplayer.
 * (A posição dos jogadores remotos é tratada dentro do próprio serviço.)
 */
function buildCoopListeners() {
  return {
    onLobbyUpdate: () => renderCoopLobbyUI(),
    onMatchStart: payload => {
      const info = getCoopRoomInfo();
      toast('⚡ OPERAÇÃO CO-OP INICIADA! ENTRANDO NA CIDADE...');
      if (typeof window.startCoopCityMission === 'function') {
        window.startCoopCityMission({
          roomId: info.roomId || payload?.room?.id,
          seed: payload?.seed ?? info.seed,
          isHost: info.isHost
        });
      }
    },
    onWorldState: payload => {
      if (typeof window.applyCoopWorldStateFromHost === 'function') {
        window.applyCoopWorldStateFromHost(payload);
      }
    },
    onHostEnemyDamage: payload => {
      if (typeof window.handleCoopClientHitOnHost === 'function') {
        window.handleCoopClientHitOnHost(payload);
      }
    },
    onConnectionStatus: st => {
      if (st === 'SUBSCRIBED') setSyncStatus('online');
      else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') setSyncStatus('syncing', 'RECONECTANDO SALA CO-OP...');
    }
  };
}

/* --------------------- 5. NOTIFICAÇÕES EM TEMPO REAL --------------------- */
async function renderNotificationsSection() {
  const listEl = $('#notificationsList');
  if (!listEl || !window.SB?.services?.amigos) return;
  try {
    if (!window.currentUser) return;
    const items = await window.SB.services.amigos.listarNotificacoes(window.currentUser.id, 40);
    if (!items.length) {
      listEl.innerHTML = `<div class="empty">NENHUMA NOTIFICAÇÃO REGISTRADA.</div>`;
      return;
    }
    listEl.innerHTML = items.map(n => `
      <div class="social-item ${!n.lida ? 'unread' : ''}">
        <div>
          <div style="font-weight:700;color:var(--lime)"><i data-ico="bell"></i> ${escapeHTML(n.titulo || '')}</div>
          <div style="font-size:12px;text-transform:none;opacity:.9">${escapeHTML(n.mensagem || '')}</div>
          <div style="font-size:10px;color:var(--mint);margin-top:3px">${new Date(n.created_at).toLocaleString('pt-BR')}</div>
        </div>
        ${!n.lida ? `<span class="badge facil">NOVO</span>` : ''}
      </div>
    `).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
  }
}

/* --------------------- 6. RANKINGS E TEMPORADAS (SEASONS) --------------------- */
async function renderRankingTab() {
  if (!window.SB?.services?.ranking) return;
  const listEl = $('#rankingListContainer');
  const myPosEl = $('#rankMyPositionBar');
  const seasonEl = $('#rankSeasonBanner');
  if (!listEl) return;

  listEl.innerHTML = `<div class="empty">CONSULTANDO CLASSIFICAÇÃO OFICIAL...</div>`;

  try {
    const rankingSvc = window.SB.services.ranking;
    const result = await rankingSvc.carregarRankingCompleto({
      categoria: activeRankCat,
      periodo: activeRankPeriod,
      limite: 50,
      offset: 0
    });
    const rows = result.items || [];
    const myPos = result.minhaPosicao || null;
    const season = activeRankPeriod === 'all' ? null : result.season;
    const unit = (rankingSvc.CATEGORIES || []).find(c => c.id === activeRankCat)?.unit || '';

    if (seasonEl) {
      if (season) {
        const endStr = new Date(season.ends_at).toLocaleDateString('pt-BR');
        seasonEl.innerHTML = `
          <span><i data-ico="trophy"></i> <b>TEMPORADA ${season.period === 'monthly' ? 'MENSAL' : 'SEMANAL'} ATIVA</b> • ENCERRA EM ${endStr}</span>
          <span style="color:var(--lime)">TOP 1–3 GANHAM +500/+300/+150 <i data-ico="coin"></i> E MOLDURA EXCLUSIVA!</span>`;
      } else {
        seasonEl.innerHTML = `<span><i data-ico="trophy"></i> CLASSIFICAÇÃO GERAL DE AGENTES E ESQUADRÕES</span>`;
      }
    }

    if (myPosEl) {
      if (myPos && myPos.posicao) {
        myPosEl.innerHTML = `
          <span>SUA POSIÇÃO ATUAL: <b>#${myPos.posicao}</b></span>
          <span>VALOR: <b>${myPos.valor ?? 0}</b> ${escapeHTML(unit)}</span>`;
      } else {
        myPosEl.innerHTML = `<span>CONCLUA MISSÕES OU PARTIDAS PARA ENTRAR NESTE RANKING!</span>`;
      }
    }

    if (!rows.length) {
      listEl.innerHTML = `<div class="empty">NENHUM REGISTRO NESTA CATEGORIA/PERÍODO AINDA.</div>`;
      return;
    }

    listEl.innerHTML = rows.map(r => {
      const pos = Number(r.posicao);
      const topCls = pos === 1 ? 'top-1' : pos === 2 ? 'top-2' : pos === 3 ? 'top-3' : '';
      const isGroups = activeRankCat === 'groups';
      const isMe = !isGroups && r.user_id === window.currentUser?.id;
      const displayName = isGroups ? `[${r.tag || ''}] ${r.nome || 'esquadrão'}` : (r.username || 'agente');
      const medal = pos <= 3 ? `<span class="px-medal medal-${pos}">${pxIcon('medal')}</span>` : `#${pos}`;
      return `
        <div class="rank-row ${topCls} ${isMe ? 'me' : ''}">
          <div class="rank-pos">${medal}</div>
          <div>
            <div style="font-weight:700;font-size:14px">
              ${isGroups ? '<i data-ico="shield"></i> ' : '@'}${escapeHTML(displayName)}
              ${r.moldura_equipada ? `<span class="badge epica" title="Moldura de Temporada"><i data-ico="star"></i> ${escapeHTML(r.moldura_equipada)}</span>` : ''}
            </div>
            <div style="font-size:11px;color:var(--mint)">
              ${isGroups ? `Membros: ${r.total_membros || 1}/${r.max_members || 30}` : `Nível ${r.level || 1}${r.group_tag ? ` • [${escapeHTML(r.group_tag)}]` : ''}`}
            </div>
          </div>
          <div class="rank-val">${r.valor ?? 0} <small style="font-size:10px;opacity:.8">${escapeHTML(unit)}</small></div>
        </div>`;
    }).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
  }
}

function bindSocialAndRankingEvents() {
  // Sub-abas sociais
  document.querySelectorAll('[data-social-sec]').forEach(btn => {
    btn.addEventListener('click', () => switchSocialSubSection(btn.dataset.socialSec));
  });

  // Enviar pedido de amizade
  $('#addFriendForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#friendUsernameInput');
    const username = input.value.trim();
    if (!username) return;
    try {
      const res = await window.SB.services.amigos.enviarPedidoAmizade(username.replace(/^@/, ''));
      input.value = '';
      const alvo = (res?.target_username || username.replace(/^@/, '')).toUpperCase();
      toast(res?.friendship?.status === 'accepted' ? 'AMIZADE CONECTADA!' : `PEDIDO ENVIADO PARA @${alvo}!`);
      await renderFriendsSection();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Cliques delegados nas listas de amigos
  $('#socialSecFriends')?.addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    try {
      if (btn.dataset.acceptFriend) {
        await window.SB.services.amigos.responderPedido(btn.dataset.acceptFriend, true);
        toast('PEDIDO DE AMIZADE ACEITO!');
        await renderFriendsSection();
      } else if (btn.dataset.rejectFriend) {
        await window.SB.services.amigos.responderPedido(btn.dataset.rejectFriend, false);
        toast('SOLICITAÇÃO RECUSADA.');
        await renderFriendsSection();
      } else if (btn.dataset.removeFriend) {
        await window.SB.services.amigos.removerAmizade(btn.dataset.removeFriend);
        toast('CONEXÃO REMOVIDA.');
        await renderFriendsSection();
      } else if (btn.dataset.blockUser) {
        if (!confirm('Bloquear este usuário? Isso impedirá DMs e convites em qualquer direção.')) return;
        await window.SB.services.amigos.bloquearUsuario(btn.dataset.blockUser);
        toast('USUÁRIO BLOQUEADO.');
        await renderFriendsSection();
      } else if (btn.dataset.unblockUser) {
        await window.SB.services.amigos.desbloquearUsuario(btn.dataset.unblockUser);
        toast('USUÁRIO DESBLOQUEADO.');
        await renderFriendsSection();
      } else if (btn.dataset.openDm) {
        const convId = await window.SB.services.chat.abrirOuCriarDM(btn.dataset.openDm);
        activeConversationId = convId;
        activeConversationTitle = `DM: ${btn.dataset.dmName || 'ALIADO'}`;
        await switchSocialSubSection('chat');
      }
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Trocar canal de chat na barra lateral
  $('#chatConversationsList')?.addEventListener('click', async e => {
    const btn = e.target.closest('[data-select-conv]');
    if (!btn) return;
    await openChatConversation(btn.dataset.selectConv, btn.dataset.convTitle);
  });

  // Paginação por cursor (carregar mensagens anteriores)
  $('#chatLoadMoreBtn')?.addEventListener('click', async () => {
    if (!loadedChatMessages.length) return;
    const oldest = loadedChatMessages[0]?.created_at;
    try {
      const page = await window.SB.services.chat.carregarMensagensPaginadas(activeConversationId, {
        limit: 30,
        beforeCreatedAt: oldest
      });
      loadedChatMessages = [...(page.messages || []), ...loadedChatMessages];
      $('#chatLoadMoreBtn')?.classList.toggle('hidden', !page.hasMore);
      await renderChatMessagesList(false);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Broadcast de "digitando..." (nunca gravado no banco)
  $('#chatMessageInput')?.addEventListener('input', () => {
    if (window.SB?.services?.chat && window.currentUser) {
      window.SB.services.chat.emitirDigitando(window.currentUser.id, state.username || 'agente');
    }
  });

  // Anexo opcional de imagem no chat (máx. 2 MB)
  $('#chatAttachmentInput')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast('A IMAGEM DO CHAT DEVE TER NO MÁXIMO 2 MB.', true);
      e.target.value = '';
      return;
    }
    pendingChatAttachmentFile = file;
    const prev = $('#chatAttachPreview');
    if (prev) {
      prev.classList.remove('hidden');
      prev.innerHTML = `<span><i data-ico="image"></i> ${escapeHTML(file.name)}</span> <button type="button" class="small-btn" id="clearChatAttachBtn" aria-label="Remover anexo"><i data-ico="close"></i></button>`;
      $('#clearChatAttachBtn').onclick = () => {
        pendingChatAttachmentFile = null;
        $('#chatAttachmentInput').value = '';
        prev.classList.add('hidden');
      };
    }
  });

  // Enviar mensagem no chat (RPC com rate limit de 2s)
  $('#chatSendForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const input = $('#chatMessageInput');
    const content = input.value.trim();
    if (!content && !pendingChatAttachmentFile) return;

    const btn = $('#chatSendBtn');
    btn.disabled = true;
    try {
      let attachmentPath = null;
      if (pendingChatAttachmentFile) {
        attachmentPath = await window.SB.services.chat.uploadAnexoChat(activeConversationId, window.currentUser.id, pendingChatAttachmentFile);
      }
      const sent = await window.SB.services.chat.enviarMensagem(
        activeConversationId,
        content || '[IMAGEM ANEXADA]',
        attachmentPath
      );
      input.value = '';
      pendingChatAttachmentFile = null;
      $('#chatAttachmentInput').value = '';
      $('#chatAttachPreview')?.classList.add('hidden');

      // A RPC `enviar_mensagem` devolve { message, sender }
      const msg = sent?.message || null;
      if (msg && !loadedChatMessages.some(m => m.id === msg.id)) {
        loadedChatMessages.push({
          ...msg,
          sender: { username: state.username, level: state.level }
        });
        await renderChatMessagesList(true);
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // Denunciar mensagem ou abrir anexo privado do chat
  $('#chatMessagesBox')?.addEventListener('click', async e => {
    const repBtn = e.target.closest('[data-report-msg]');
    if (repBtn) {
      const reason = prompt('Informe o motivo da denúncia (ex.: spam, ofensa, link suspeito):');
      if (!reason) return;
      try {
        await window.SB.services.chat.denunciarMensagem({ messageId: repBtn.dataset.reportMsg, reason });
        toast('DENÚNCIA ENVIADA PARA A MODERAÇÃO.');
      } catch (err) {
        toast(err.message, true);
      }
    }
    const attBtn = e.target.closest('[data-open-chat-att]');
    if (attBtn) {
      // A URL assinada (válida por 1h) já vem pronta na hidratação das mensagens
      const signedUrl = attBtn.dataset.openChatAtt;
      if (signedUrl) {
        $('#lightboxImg').src = signedUrl;
        openModal('lightbox');
      } else {
        toast('ANEXO INDISPONÍVEL OU EXPIRADO. RECARREGUE A CONVERSA.', true);
      }
    }
  });

  // Sala Co-op: Criar ou Entrar
  $('#createCoopRoomBtn')?.addEventListener('click', async () => {
    try {
      // criarSala já conecta ao canal Realtime da sala com os callbacks informados
      const res = await window.SB.services.multiplayer.criarSala(4, buildCoopListeners());
      toast(`SALA CO-OP CRIADA! CÓDIGO: ${res?.room?.code || ''}`);
      await renderCoopLobbyUI();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#joinCoopRoomForm')?.addEventListener('submit', async e => {
    e.preventDefault();
    const code = $('#joinRoomCodeInput').value.trim();
    if (!code) return;
    try {
      const res = await window.SB.services.multiplayer.entrarSala(code, buildCoopListeners());
      toast(`CONECTADO À SALA ${res?.room?.code || code.toUpperCase()}!`);
      await renderCoopLobbyUI();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Marcar notificações como lidas
  $('#markAllNotifsReadBtn')?.addEventListener('click', async () => {
    try {
      if (!window.currentUser) return;
      await window.SB.services.amigos.marcarNotificacoesComoLidas(window.currentUser.id);
      await renderNotificationsSection();
      await refreshUnreadBadges();
      toast('TODAS AS NOTIFICAÇÕES FORAM MARCADAS COMO LIDAS.');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Rankings: filtros de período e categoria
  document.querySelectorAll('[data-rank-period]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-rank-period]').forEach(b => b.classList.toggle('active', b === btn));
      activeRankPeriod = btn.dataset.rankPeriod;
      renderRankingTab();
    });
  });

  document.querySelectorAll('[data-rank-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-rank-cat]').forEach(b => b.classList.toggle('active', b === btn));
      activeRankCat = btn.dataset.rankCat;
      renderRankingTab();
    });
  });
}

/** Garante que o app seja carregado uma única vez por usuário (evita carga dupla listener + getSession) */
let authLoadingUserId = null;
async function ensureAuthenticatedApp(user) {
  if (!user) return;
  if (window.currentUser?.id === user.id || authLoadingUserId === user.id) return;
  authLoadingUserId = user.id;
  try {
    cleanAuthParamsFromUrl();
    await loadAuthenticatedApp(user);
  } finally {
    authLoadingUserId = null;
  }
}

/** Remove ?code= / #access_token= da URL após o retorno OAuth para não reprocessar no reload */
function cleanAuthParamsFromUrl() {
  const sp = new URLSearchParams(window.location.search);
  const hasHashToken = /access_token=|refresh_token=/.test(window.location.hash);
  if (sp.has('code') || hasHashToken) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
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
      // Adia para fora do callback: chamadas ao Supabase dentro do
      // onAuthStateChange podem travar o cliente (lock interno do supabase-js).
      setTimeout(() => ensureAuthenticatedApp(session.user), 0);
    } else if (event === 'SIGNED_OUT') {
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
    if (session?.user) {
      await ensureAuthenticatedApp(session.user);
    } else if (!session && !window.currentUser) {
      setRouteProtection(false);
    }
  } catch (err) {
    setRouteProtection(false);
    showAuthMessage(err.message, 'error');
  }
}

init();
