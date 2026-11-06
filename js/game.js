/* =====================================================================
   Sistema de Missões — JOGO 2D DE PLATAFORMA EM PIXEL ART ("MISSÃO NA CIDADE")
   ---------------------------------------------------------------------
   Integrado ao perfil do personagem, nível, classes, tarefas (fichas),
   XP (com limite diário), loja de upgrades/cosméticos e conquistas.
   Resolução interna: 320x180 (16-bit pixel art) @ 60 FPS passo fixo.
   ===================================================================== */

/* =====================================================================
   1. CONSTANTES DE BALANCEAMENTO (fácil ajuste no topo)
   ===================================================================== */
const GAME_CONFIG = {
  WIDTH: 320,
  HEIGHT: 180,
  FIXED_DT: 1 / 60,

  // Atributos base do jogador e escalonamento por nível/upgrade
  BASE_HP: 100,
  HP_PER_LEVEL: 14,
  HP_PER_UPGRADE: 25,

  BASE_DAMAGE: 16,
  DMG_PER_LEVEL: 3.5,
  DMG_PER_UPGRADE: 5,

  BASE_SPEED: 88,          // px/s
  SPD_PER_LEVEL: 1.4,
  SPD_PER_UPGRADE: 6,
  MAX_BONUS_SPEED: 38,

  // Física de plataforma responsiva
  GRAVITY: 410,
  JUMP_FORCE: -178,
  DOUBLE_JUMP_FORCE: -156,
  VARIABLE_JUMP_CUT: 0.48, // multiplicador de vy ao soltar o pulo cedo
  COYOTE_TIME: 0.11,       // segundos após sair da borda
  JUMP_BUFFER: 0.12,       // segundos antes de tocar o chão
  MAX_FALL_SPEED: 260,

  // Recompensas e Economia
  TICKET_COST: 1,
  DAILY_XP_CAP_RATIO: 0.30, // máx 30% do XP necessário para o nível atual por dia
  XP_PER_ENEMY: 6,
  XP_PER_SEGMENT: 8,
  XP_BOSS_BONUS: 45,
  COIN_VALUE: 3,
  BOSS_COIN_BONUS: 45,
  BOSS_RARE_DROP_CHANCE: 0.55, // 55% de chance de ganhar cosmético/upgrade raro ao vencer o Boss

  // Geração de Fase
  MIN_SEGMENTS: 6,
  MAX_SEGMENTS: 8,

  // Chances de drop ao destruir maletas ou derrotar inimigos
  SUITCASE_DROP_CHANCE: 0.28,
  ENEMY_ITEM_DROP_CHANCE: 0.32,

  // Custos da Loja
  SHOP_UPGRADES: {
    hp:  { name: 'FIBRA NANOCARBONO', desc: '+25 Vida Máxima permanente', max: 5, baseCost: 30, costMult: 1.6, icon: '❤️' },
    dmg: { name: 'AMPLIFICADOR DE PULSO', desc: '+5 Dano de Arma permanente', max: 5, baseCost: 35, costMult: 1.65, icon: '⚔️' },
    spd: { name: 'PROPULSOR NEURAL', desc: '+6 Velocidade de Movimento', max: 5, baseCost: 25, costMult: 1.55, icon: '⚡' }
  },
  SHOP_OUTFITS: [
    { id: 'cyber_agente',   name: 'Traje Agente Cyber',   cost: 80,  desc: 'Visor neon ciano e jaqueta tática.' },
    { id: 'executivo_neon', name: 'Traje Executivo Neon', cost: 110, desc: 'Terno de alta cúpula com gravata laser.' },
    { id: 'armadura_omega', name: 'Exotraje Ômega',       cost: 160, desc: 'Armadura pesada com núcleo de fótons.' }
  ],
  SHOP_SKINS: [
    { id: 'neon_cyan', name: 'Skin Ciano Cyber',   cost: 60,  desc: 'Lâmina/disparo energizado em ciano puro.' },
    { id: 'plasma',    name: 'Skin Plasma Roxo',   cost: 85,  desc: 'Matéria escura violeta de alta voltagem.' },
    { id: 'carmesim',  name: 'Skin Laser Rubro',   cost: 100, desc: 'Feixe carmesim sobrecarregado.' },
    { id: 'solar',     name: 'Skin Fóton Dourado', cost: 130, desc: 'Brilho reluzente de ouro cibernético.' }
  ]
};

/* =====================================================================
   2. ESTILOS DE COMBATE POR CLASSE (12 classes em 5 arquétipos)
   ===================================================================== */
const CLASS_COMBAT = {
  // Corpo a corpo forte
  guerreiro:  { group: 'melee_heavy', hpMult: 1.20, dmgMult: 1.22, spdMult: 0.96, range: 24, cd: 0.34, color: '#7CFF3A', skillCd: 6.5, skillName: 'ONDA SÍSMICA' },
  barbaro:    { group: 'melee_heavy', hpMult: 1.28, dmgMult: 1.30, spdMult: 0.95, range: 25, cd: 0.38, color: '#FF3B2F', skillCd: 7.0, skillName: 'FÚRIA DEMOLIDORA' },
  paladino:   { group: 'melee_heavy', hpMult: 1.30, dmgMult: 1.15, spdMult: 0.94, range: 23, cd: 0.35, color: '#FFC21A', skillCd: 7.5, skillName: 'ESCUDO CONSAGRADO' },

  // Tiro à distância
  arqueiro:   { group: 'ranged_bow',  hpMult: 0.95, dmgMult: 1.05, spdMult: 1.06, projSpd: 210, cd: 0.28, color: '#7CFF3A', skillCd: 5.5, skillName: 'RAJADA TRIPLA' },
  cacador:    { group: 'ranged_bow',  hpMult: 1.00, dmgMult: 1.12, spdMult: 1.04, projSpd: 225, cd: 0.31, color: '#00F0FF', skillCd: 6.0, skillName: 'DISPARO PERFURANTE' },

  // Projéteis mágicos
  mago:       { group: 'magic',       hpMult: 0.90, dmgMult: 1.25, spdMult: 1.00, projSpd: 165, cd: 0.36, color: '#00F0FF', skillCd: 6.5, skillName: 'ORBE SUPERNOVA' },
  necromante: { group: 'magic',       hpMult: 0.92, dmgMult: 1.20, spdMult: 1.00, projSpd: 160, cd: 0.35, color: '#B84DFF', skillCd: 6.5, skillName: 'CEIFA DRENANTE' },
  druida:     { group: 'magic',       hpMult: 1.04, dmgMult: 1.10, spdMult: 1.02, projSpd: 170, cd: 0.34, color: '#7CFF3A', skillCd: 6.0, skillName: 'TEMPESTADE BIO-NEON' },

  // Rápidos, ataque curto
  ladino:     { group: 'melee_fast',  hpMult: 0.92, dmgMult: 0.95, spdMult: 1.20, range: 18, cd: 0.18, color: '#00F0FF', skillCd: 4.8, skillName: 'PASSO FANTASMA' },
  monge:      { group: 'melee_fast',  hpMult: 1.02, dmgMult: 1.00, spdMult: 1.16, range: 19, cd: 0.20, color: '#FFC21A', skillCd: 5.0, skillName: 'PUNHO DE CHI' },

  // Suporte: cura leve ou buff ao acertar
  clerigo:    { group: 'support',     hpMult: 1.12, dmgMult: 0.96, spdMult: 1.00, projSpd: 175, cd: 0.33, color: '#FFC21A', skillCd: 7.0, skillName: 'LUZ RESTAURADORA' },
  bardo:      { group: 'support',     hpMult: 1.00, dmgMult: 0.95, spdMult: 1.10, projSpd: 185, cd: 0.30, color: '#FF6FB5', skillCd: 6.5, skillName: 'ACORDE TURBO' }
};

/* =====================================================================
   3. INIMIGOS (Homens de Terno) & VARIAÇÕES DE BOSS
   ===================================================================== */
const ENEMY_TYPES = {
  estagiario: {
    id: 'estagiario', name: 'Estagiário Corredor', weight: 30,
    hp: 26, dmg: 10, spd: 68, score: 10,
    suit: '#2E3B4E', tie: '#7CFF3A', shirt: '#E8F4F8', hair: '#4A2E1B', glasses: false,
    behavior: 'runner'
  },
  executivo: {
    id: 'executivo', name: 'Executivo Arremessador', weight: 32,
    hp: 38, dmg: 12, spd: 36, score: 15,
    suit: '#1B263B', tie: '#FF3B2F', shirt: '#FFFFFF', hair: '#1C1C24', glasses: false,
    behavior: 'thrower_arc'
  },
  seguranca: {
    id: 'seguranca', name: 'Segurança Pesado', weight: 18,
    hp: 72, dmg: 16, spd: 26, score: 25,
    suit: '#0D1117', tie: '#00F0FF', shirt: '#DCE6F2', hair: '#E8C35A', glasses: true,
    behavior: 'thrower_fast'
  },
  gerente: {
    id: 'gerente', name: 'Gerente Saltador', weight: 20,
    hp: 44, dmg: 13, spd: 48, score: 20,
    suit: '#3B2848', tie: '#FFC21A', shirt: '#F4F4F8', hair: '#C8551F', glasses: false,
    behavior: 'jumper'
  },
  contador: {
    id: 'contador', name: 'Contador Sniper', weight: 15,
    hp: 34, dmg: 18, spd: 20, score: 25,
    suit: '#1E3A3A', tie: '#1FD1B0', shirt: '#FFFFFF', hair: '#E3ECF0', glasses: true,
    behavior: 'sniper'
  },
  diretor: {
    id: 'diretor', name: 'Diretor Corporativo', weight: 8,
    hp: 115, dmg: 18, spd: 30, score: 50, isMiniBoss: true,
    suit: '#2A1215', tie: '#FFD23A', shirt: '#FFF8E7', hair: '#E3ECF0', glasses: true, crown: true,
    behavior: 'director'
  }
};

const BOSS_VARIANTS = [
  { id: 'mk1', name: 'MECHA-CEO ÔMEGA MK-I',   hull: '#1E2D3D', trim: '#00F0FF', core: '#7CFF3A', eye: '#FF3B2F', arenaType: 'rooftop' },
  { id: 'mk2', name: 'TITÃ AUDITOR NEXUS-II',  hull: '#2B1E3D', trim: '#FFC21A', core: '#00F0FF', eye: '#7CFF3A', arenaType: 'hangar' },
  { id: 'mk3', name: 'COLOSSO EXECUTIVO V-III',hull: '#162E2A', trim: '#7CFF3A', core: '#FF3B2F', eye: '#FFC21A', arenaType: 'rooftop' }
];

const WEATHERS = [
  { id: 'clean', name: 'NOITE LIMPA',  enemyMult: 1.0, skyTop: '#061B24', skyBot: '#1D6B52' },
  { id: 'rain',  name: 'CHUVA NEON',   enemyMult: 1.05, skyTop: '#051520', skyBot: '#13524E' },
  { id: 'fog',   name: 'NEBLINA VERDE',enemyMult: 1.0, skyTop: '#07221F', skyBot: '#2E8555' },
  { id: 'rush',  name: 'HORA DE PICO', enemyMult: 1.35, skyTop: '#091826', skyBot: '#246E5B' }
];

/* =====================================================================
   4. ÁUDIO DO JOGO (Web Audio API com silenciador)
   ===================================================================== */
let gameAudioCtx = null;

function isGameMuted() {
  return !!(typeof state !== 'undefined' && state?.game?.muted) || !CONFIG.SOUND_ENABLED;
}

function playGameSfx(type) {
  if (isGameMuted()) return;
  try {
    gameAudioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const ctx = gameAudioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;

    const tone = (freq, endFreq, dur, wave = 'square', gainVal = 0.05, delay = 0) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const t = now + delay;
      o.type = wave;
      o.frequency.setValueAtTime(freq, t);
      if (endFreq && endFreq !== freq) {
        o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
      }
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gainVal, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    };

    switch (type) {
      case 'jump':
        tone(220, 520, 0.12, 'square', 0.045);
        break;
      case 'double_jump':
        tone(320, 740, 0.13, 'triangle', 0.05);
        break;
      case 'shoot':
        tone(680, 210, 0.09, 'sawtooth', 0.045);
        break;
      case 'melee':
        tone(180, 90, 0.08, 'sawtooth', 0.055);
        tone(420, 160, 0.06, 'triangle', 0.03, 0.02);
        break;
      case 'skill':
        tone(330, 880, 0.18, 'sawtooth', 0.06);
        tone(440, 1120, 0.22, 'square', 0.05, 0.06);
        break;
      case 'hit':
        tone(160, 65, 0.10, 'square', 0.05);
        break;
      case 'hurt':
        tone(140, 48, 0.22, 'sawtooth', 0.07);
        break;
      case 'coin':
        tone(987, 987, 0.06, 'square', 0.045);
        tone(1318, 1318, 0.14, 'square', 0.045, 0.06);
        break;
      case 'item':
        tone(523, 659, 0.08, 'triangle', 0.05);
        tone(659, 1046, 0.15, 'triangle', 0.05, 0.08);
        break;
      case 'explosion':
        tone(110, 32, 0.28, 'sawtooth', 0.08);
        break;
      case 'boss_roar':
        tone(95, 42, 0.45, 'sawtooth', 0.09);
        tone(140, 55, 0.40, 'square', 0.06, 0.08);
        break;
      case 'victory':
        [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, f * 1.02, 0.18, 'square', 0.055, i * 0.09));
        break;
      case 'gameover':
        [392, 349, 311, 261].forEach((f, i) => tone(f, f * 0.96, 0.22, 'sawtooth', 0.05, i * 0.14));
        break;
    }
  } catch (e) { /* AudioContext bloqueado ou indisponível */ }
}

/* =====================================================================
   5. CACHE DE SPRITES GERADOS POR CÓDIGO (Agente, Ternos, Maletas, Itens)
   ===================================================================== */
const spriteCache = {
  playerIdle: null,
  playerRun1: null,
  playerRun2: null,
  enemies: {},
  suitcases: {},
  drone: null
};

/** Cria um canvas 18x18 a partir da grade 16x16 com contorno automático */
function makeSpriteCanvas(grid) {
  const c = document.createElement('canvas');
  drawGrid(c, grid);
  return c;
}

/** Gera quadros de caminhada deslocando os pés na linha 14-15 */
function shiftLegsGrid(baseGrid, step) {
  const g = baseGrid.map(row => [...row]);
  for (let y = 13; y < 16; y++) {
    const row = [...baseGrid[y]];
    for (let x = 0; x < 16; x++) {
      if (y === 14 || y === 15) {
        const isLeft = x < 8;
        const dy = (step === 1 && isLeft) || (step === 2 && !isLeft) ? -1 : 0;
        if (dy === -1 && y === 14) {
          g[13][x] = row[x] || g[13][x];
          g[14][x] = baseGrid[15][x];
          g[15][x] = null;
        }
      }
    }
  }
  return g;
}

function buildPlayerSprites() {
  if (!state.profile) return;
  const baseGrid = composeSprite(state.profile, { level: state.level });
  spriteCache.playerIdle = makeSpriteCanvas(baseGrid);
  spriteCache.playerRun1 = makeSpriteCanvas(shiftLegsGrid(baseGrid, 1));
  spriteCache.playerRun2 = makeSpriteCanvas(shiftLegsGrid(baseGrid, 2));
}

/** Constrói um Homem de Terno 16x16 em código a partir da configuração */
function composeSuitEnemyGrid(cfg, step = 0) {
  const skin = '#F2C29B', skinShade = '#C9936B';
  const pal = {
    S: skin, s: skinShade, E: '#101622',
    H: cfg.hair,
    U: cfg.suit, u: shadeHex(cfg.suit, 0.28),
    W: cfg.shirt, T: cfg.tie,
    G: '#00F0FF', K: '#080B10',
    Y: '#FFD23A', D: '#181C24'
  };
  const m = px({
    1:  cfg.crown ? '.....YYYYYY.....' : '.....HHHHHH.....',
    2:  '....HHHHHHHH....',
    3:  '....HHHHHHHH....',
    4:  '....SSSSSSSS....',
    5:  cfg.glasses ? '....KKKKKKKK....' : '....SSESSESS....',
    6:  cfg.glasses ? '....KGGKKGGK....' : '....SSESSESS....',
    7:  '....sSSSSSSs....',
    8:  '.....sWWWWs.....',
    9:  '...UUUWTWUUUU...',
    10: '...UUUWTWUUUU...',
    11: '...uUUWTWUUUu...',
    12: '...SSUWTWUUSS...',
    13: '....UUUUUUUU....',
    14: '.....UU..UU.....',
    15: '.....DD..DD.....'
  });
  const grid = Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (__, x) => {
      const ch = m[y][x];
      return ch !== '.' && pal[ch] ? pal[ch] : null;
    })
  );
  return step ? shiftLegsGrid(grid, step) : grid;
}

function getEnemySprite(typeId, frame = 0) {
  const key = `${typeId}_${frame}`;
  if (!spriteCache.enemies[key]) {
    const cfg = ENEMY_TYPES[typeId] || ENEMY_TYPES.executivo;
    spriteCache.enemies[key] = makeSpriteCanvas(composeSuitEnemyGrid(cfg, frame));
  }
  return spriteCache.enemies[key];
}

/* =====================================================================
   6. BIBLIOTECA DE SEGMENTOS DE FASE (Telhados, Escritórios, Transições)
   Cada segmento tem largura entre 360 e 480 px.
   Alturas (y): chão base em y=156 (altura 24).
   Todas as distâncias horizontais e verticais respeitam o pulo máximo.
   ===================================================================== */
const SEGMENT_LIBRARY = [
  // ---- TELHADOS (ROOFTOPS) ----
  {
    id: 'roof_antennas', type: 'rooftop', name: 'TELHADOS DE TELECOM', width: 420,
    platforms: [
      { x: 0,   y: 156, w: 125, h: 24, style: 'building' },
      { x: 152, y: 146, w: 95,  h: 34, style: 'building' },
      { x: 274, y: 154, w: 146, h: 26, style: 'building' },
      { x: 65,  y: 118, w: 46,  h: 6,  style: 'billboard', oneWay: true },
      { x: 175, y: 106, w: 54,  h: 6,  style: 'billboard', oneWay: true },
      { x: 310, y: 116, w: 58,  h: 6,  style: 'billboard', oneWay: true }
    ],
    features: [
      { kind: 'wind', x: 126, y: 78, w: 24, h: 78, vy: -195 },
      { kind: 'drone', x: 210, y: 74, range: 55, spd: 38 },
      { kind: 'antenna', x: 40, y: 156 },
      { kind: 'antenna', x: 365, y: 154 }
    ],
    spawns: [
      { x: 95,  y: 138, role: 'ground' },
      { x: 195, y: 128, role: 'ground' },
      { x: 330, y: 98,  role: 'high' },
      { x: 365, y: 136, role: 'ground' }
    ]
  },
  {
    id: 'roof_neon_plaza', type: 'rooftop', name: 'TERRAÇO HOLOGRÁFICO', width: 440,
    platforms: [
      { x: 0,   y: 156, w: 105, h: 24, style: 'building' },
      { x: 125, y: 136, w: 42,  h: 6,  style: 'falling', oneWay: true },
      { x: 185, y: 152, w: 110, h: 28, style: 'building' },
      { x: 315, y: 134, w: 42,  h: 6,  style: 'falling', oneWay: true },
      { x: 372, y: 156, w: 68,  h: 24, style: 'building' },
      { x: 205, y: 110, w: 68,  h: 6,  style: 'billboard', oneWay: true }
    ],
    features: [
      { kind: 'drone', x: 145, y: 68, range: 50, spd: 42 },
      { kind: 'drone', x: 325, y: 72, range: 45, spd: 45 },
      { kind: 'holo_ad', x: 215, y: 110, text: 'CYBER CORP' }
    ],
    spawns: [
      { x: 75,  y: 138, role: 'ground' },
      { x: 230, y: 134, role: 'ground' },
      { x: 235, y: 92,  role: 'high' },
      { x: 405, y: 138, role: 'ground' }
    ]
  },
  {
    id: 'roof_sky_vents', type: 'rooftop', name: 'TORRES DE VENTILAÇÃO', width: 430,
    platforms: [
      { x: 0,   y: 156, w: 95,  h: 24, style: 'building' },
      { x: 115, y: 128, w: 50,  h: 6,  style: 'moving_x', range: 36, spd: 32, oneWay: true },
      { x: 215, y: 150, w: 95,  h: 30, style: 'building' },
      { x: 335, y: 156, w: 95,  h: 24, style: 'building' },
      { x: 230, y: 108, w: 55,  h: 6,  style: 'billboard', oneWay: true }
    ],
    features: [
      { kind: 'wind', x: 310, y: 80, w: 24, h: 76, vy: -200 },
      { kind: 'antenna', x: 255, y: 150 },
      { kind: 'holo_ad', x: 25, y: 156, text: 'NEO-CITY' }
    ],
    spawns: [
      { x: 65,  y: 138, role: 'ground' },
      { x: 255, y: 132, role: 'ground' },
      { x: 255, y: 90,  role: 'high' },
      { x: 385, y: 138, role: 'ground' }
    ]
  },

  // ---- ESCRITÓRIOS (INTERIOR CORPORATIVO) ----
  {
    id: 'office_cubicles', type: 'office', name: 'ANDAR DOS CUBÍCULOS', width: 420,
    ceiling: true,
    platforms: [
      { x: 0,   y: 156, w: 420, h: 24, style: 'office_floor' },
      { x: 55,  y: 124, w: 48,  h: 6,  style: 'desk', oneWay: true },
      { x: 135, y: 118, w: 75,  h: 8,  style: 'conveyor', vx: -34, oneWay: true },
      { x: 240, y: 124, w: 48,  h: 6,  style: 'desk', oneWay: true },
      { x: 310, y: 96,  w: 68,  h: 6,  style: 'cubicle_top', oneWay: true }
    ],
    features: [
      { kind: 'laser', x: 122, y: 108, h: 48, period: 2.4, activeRatio: 0.5 },
      { kind: 'laser', x: 298, y: 108, h: 48, period: 2.4, activeRatio: 0.5, phase: 1.2 },
      { kind: 'server_rack', x: 170, y: 156 },
      { kind: 'server_rack', x: 345, y: 156 }
    ],
    spawns: [
      { x: 95,  y: 138, role: 'ground' },
      { x: 175, y: 100, role: 'high' },
      { x: 265, y: 138, role: 'ground' },
      { x: 345, y: 78,  role: 'high' }
    ]
  },
  {
    id: 'office_servers', type: 'office', name: 'CENTRAL DE SERVIDORES', width: 440,
    ceiling: true,
    platforms: [
      { x: 0,   y: 156, w: 440, h: 24, style: 'office_floor' },
      { x: 60,  y: 122, w: 62,  h: 6,  style: 'desk', oneWay: true },
      { x: 155, y: 92,  w: 64,  h: 6,  style: 'cubicle_top', oneWay: true },
      { x: 245, y: 130, w: 42,  h: 6,  style: 'elevator', rangeY: 42, spd: 32, oneWay: true },
      { x: 315, y: 100, w: 80,  h: 6,  style: 'cubicle_top', oneWay: true }
    ],
    features: [
      { kind: 'security_door', x: 228, y: 112, h: 44, keyX: 185, keyY: 74 },
      { kind: 'laser', x: 350, y: 106, h: 50, period: 2.2, activeRatio: 0.55 },
      { kind: 'server_rack', x: 85,  y: 156 },
      { kind: 'server_rack', x: 110, y: 156 },
      { kind: 'server_rack', x: 380, y: 156 }
    ],
    spawns: [
      { x: 115, y: 138, role: 'ground' },
      { x: 185, y: 74,  role: 'high' },
      { x: 295, y: 138, role: 'ground' },
      { x: 365, y: 82,  role: 'high' }
    ]
  },
  {
    id: 'office_boardroom', type: 'office', name: 'CORREDOR DA DIRETORIA', width: 420,
    ceiling: true,
    platforms: [
      { x: 0,   y: 156, w: 420, h: 24, style: 'office_floor' },
      { x: 50,  y: 126, w: 85,  h: 8,  style: 'conveyor', vx: 38, oneWay: true },
      { x: 165, y: 98,  w: 85,  h: 6,  style: 'desk', oneWay: true },
      { x: 280, y: 126, w: 85,  h: 8,  style: 'conveyor', vx: -38, oneWay: true }
    ],
    features: [
      { kind: 'laser', x: 150, y: 106, h: 50, period: 2.0, activeRatio: 0.5 },
      { kind: 'laser', x: 265, y: 106, h: 50, period: 2.0, activeRatio: 0.5, phase: 1.0 },
      { kind: 'vent_duct', x: 180, y: 42, w: 60 }
    ],
    spawns: [
      { x: 95,  y: 108, role: 'ground' },
      { x: 205, y: 80,  role: 'high' },
      { x: 215, y: 138, role: 'ground' },
      { x: 335, y: 138, role: 'ground' }
    ]
  },

  // ---- TRANSIÇÕES (Ponte Holográfica, Tirolesa, Elevador Externo, Dutos) ----
  {
    id: 'trans_holo_bridge', type: 'transition', name: 'PONTE HOLOGRÁFICA & TIROLESA', width: 380,
    platforms: [
      { x: 0,   y: 156, w: 85,  h: 24, style: 'building' },
      { x: 95,  y: 152, w: 185, h: 6,  style: 'holo_bridge', oneWay: true },
      { x: 290, y: 156, w: 90,  h: 24, style: 'building' },
      { x: 40,  y: 118, w: 42,  h: 6,  style: 'billboard', oneWay: true }
    ],
    features: [
      { kind: 'zipline', x1: 72, y1: 82, x2: 295, y2: 104 },
      { kind: 'drone', x: 190, y: 118, range: 60, spd: 46 }
    ],
    spawns: [
      { x: 145, y: 134, role: 'ground' },
      { x: 230, y: 134, role: 'ground' },
      { x: 335, y: 138, role: 'ground' }
    ]
  },
  {
    id: 'trans_ext_elevator', type: 'transition', name: 'ELEVADOR PANORÂMICO & DUTOS', width: 380,
    platforms: [
      { x: 0,   y: 156, w: 90,  h: 24, style: 'building' },
      { x: 108, y: 144, w: 52,  h: 6,  style: 'elevator', rangeY: 44, spd: 36, oneWay: true },
      { x: 178, y: 114, w: 96,  h: 10, style: 'vent_platform', oneWay: true },
      { x: 178, y: 156, w: 96,  h: 24, style: 'building' },
      { x: 292, y: 156, w: 88,  h: 24, style: 'building' }
    ],
    features: [
      { kind: 'wind', x: 276, y: 82, w: 16, h: 74, vy: -185 },
      { kind: 'vent_duct', x: 178, y: 114, w: 96 }
    ],
    spawns: [
      { x: 220, y: 96,  role: 'high' },
      { x: 225, y: 138, role: 'ground' },
      { x: 340, y: 138, role: 'ground' }
    ]
  }
];

/* =====================================================================
   7. GERAÇÃO PROCEDURAL DA FASE (6 a 8 segmentos + Arena do Boss)
   ===================================================================== */
let game = null; // Instância ativa da partida
let currentStageRng = Math.random;

function setStageSeed(seed) {
  if (typeof seed === 'number' && !Number.isNaN(seed) && window.SB?.multiplayer?.createSeededRandom) {
    currentStageRng = window.SB.multiplayer.createSeededRandom(seed);
  } else {
    currentStageRng = Math.random;
  }
}

function stageRand() {
  return currentStageRng();
}

function pickWeighted(items, weightFn, excludeIds = []) {
  const pool = items.filter(it => !excludeIds.includes(it.id || it));
  const list = pool.length ? pool : items;
  const total = list.reduce((s, it) => s + weightFn(it), 0);
  let r = stageRand() * total;
  for (const it of list) {
    r -= weightFn(it);
    if (r <= 0) return it;
  }
  return list[list.length - 1];
}

function generateStage(level, seed = null) {
  setStageSeed(seed);
  const numMainSegments = GAME_CONFIG.MIN_SEGMENTS + Math.floor(stageRand() * (GAME_CONFIG.MAX_SEGMENTS - GAME_CONFIG.MIN_SEGMENTS + 1)); // 6..8
  const weather = WEATHERS[Math.floor(stageRand() * WEATHERS.length)];
  const bossVariant = BOSS_VARIANTS[Math.floor(stageRand() * BOSS_VARIANTS.length)];

  const rooftops = SEGMENT_LIBRARY.filter(s => s.type === 'rooftop');
  const offices  = SEGMENT_LIBRARY.filter(s => s.type === 'office');
  const trans    = SEGMENT_LIBRARY.filter(s => s.type === 'transition');

  const segments = [];
  const platforms = [];
  const features = [];
  const enemies = [];
  const items = [];

  // Zona segura de largada (x: 0..110)
  platforms.push({ x: 0, y: 156, w: 110, h: 24, style: 'building', segIndex: 0 });
  let cursorX = 110;
  let lastSegId = null;
  let lastEnemyComboKey = '';

  for (let i = 0; i < numMainSegments; i++) {
    // Alterna telhado -> interior -> transição -> telhado...
    let pool;
    if (i % 3 === 2 && trans.length) pool = trans;
    else if (i % 2 === 0) pool = rooftops;
    else pool = offices;

    const avail = pool.filter(s => s.id !== lastSegId);
    const tpl = (avail.length ? avail : pool)[Math.floor(stageRand() * (avail.length || pool.length))];
    lastSegId = tpl.id;

    const segStart = cursorX;
    const segEnd = cursorX + tpl.width;
    segments.push({
      index: i + 1,
      id: tpl.id,
      type: tpl.type,
      name: tpl.name,
      ceiling: !!tpl.ceiling,
      startX: segStart,
      endX: segEnd
    });

    // Validação e inserção das plataformas do segmento
    let prevPlatEnd = segStart;
    tpl.platforms.forEach(p => {
      const px0 = segStart + p.x;
      // Garante rota possível: se houver buraco > 68px no chão, cria plataforma de segurança
      if (!p.oneWay && px0 - prevPlatEnd > 68) {
        platforms.push({
          x: prevPlatEnd + 16,
          y: 146,
          w: 36,
          h: 6,
          style: 'billboard',
          oneWay: true,
          segIndex: i + 1
        });
      }
      if (!p.oneWay) prevPlatEnd = Math.max(prevPlatEnd, px0 + p.w);

      platforms.push({
        ...p,
        x: px0,
        baseX: px0,
        baseY: p.y,
        fallTimer: 0,
        fallingState: 'idle', // idle | shake | fall | respawn
        segIndex: i + 1
      });
    });

    // Elementos especiais (lasers, esteiras, tirolesas, drones, portas, vento)
    (tpl.features || []).forEach(f => {
      const feat = { ...f, segIndex: i + 1 };
      if (f.x !== undefined) feat.x = segStart + f.x;
      if (f.x1 !== undefined) { feat.x1 = segStart + f.x1; feat.x2 = segStart + f.x2; }
      if (f.keyX !== undefined) { feat.keyX = segStart + f.keyX; feat.unlocked = false; }
      if (f.kind === 'drone') { feat.baseX = feat.x; feat.hp = 24 + level * 4; feat.alive = true; feat.vx = f.spd || 38; }
      features.push(feat);
    });

    // Sorteia 2 a 3 tipos de inimigos para este segmento sem repetir a combinação anterior
    const allTypes = Object.values(ENEMY_TYPES).filter(e => !e.isMiniBoss);
    const numTypes = i >= 2 ? 3 : 2;
    let chosenTypes = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      chosenTypes = [];
      for (let k = 0; k < numTypes; k++) {
        const picked = pickWeighted(allTypes, e => e.weight + (i * 3), chosenTypes.map(c => c.id));
        chosenTypes.push(picked);
      }
      const key = chosenTypes.map(c => c.id).sort().join('+');
      if (key !== lastEnemyComboKey) { lastEnemyComboKey = key; break; }
    }

    // Escala de dificuldade por distância (i) e nível do jogador
    const scaleMult = (1 + (level - 1) * 0.14) * (1 + i * 0.10) * weather.enemyMult;
    const spawnList = [...(tpl.spawns || [])];
    if (weather.id === 'rush' && spawnList.length >= 2) {
      spawnList.push({ x: Math.round(tpl.width * 0.52), y: 138, role: 'ground' });
    }

    spawnList.forEach((sp, spIdx) => {
      let eCfg;
      if (sp.role === 'high') {
        eCfg = chosenTypes.find(c => c.id === 'contador' || c.id === 'executivo') || ENEMY_TYPES.contador;
      } else if (i === Math.floor(numMainSegments / 2) && spIdx === spawnList.length - 1) {
        // Mini-chefe Diretor ocasional no meio da fase
        eCfg = ENEMY_TYPES.diretor;
      } else {
        eCfg = chosenTypes[spIdx % chosenTypes.length];
      }
      enemies.push(createEnemyInstance(eCfg, segStart + sp.x, sp.y, scaleMult));
    });

    // Moedas, chips de cura e itens ao longo do segmento
    for (let c = 0; c < 4; c++) {
      items.push({
        id: uid(),
        kind: 'coin',
        x: segStart + 45 + c * 85,
        y: (c % 2 === 0) ? 136 : 102,
        vy: 0,
        collected: false
      });
    }
    // Chip de cura garantido no meio de cada segmento para recuperar vida durante a run
    items.push({
      id: uid(),
      kind: 'heal_chip',
      x: segStart + Math.round(tpl.width * 0.42),
      y: 126,
      vy: 0,
      collected: false
    });
    if (i % 2 === 1) {
      const itemKinds = ['heal_chip', 'shield', 'ammo', 'overdrive'];
      const rKind = itemKinds[(i + Math.floor(stageRand() * itemKinds.length)) % itemKinds.length];
      items.push({
        id: uid(),
        kind: rKind,
        x: segStart + Math.round(tpl.width * 0.68),
        y: 96,
        vy: 0,
        collected: false
      });
    }

    cursorX = segEnd;
  }

  // ---- ARENA DO BOSS NO FINAL DA FASE ----
  const arenaStart = cursorX;
  const arenaWidth = 360;
  const arenaEnd = arenaStart + arenaWidth;
  segments.push({
    index: numMainSegments + 1,
    id: 'boss_arena',
    type: bossVariant.arenaType,
    name: `ARENA: ${bossVariant.name}`,
    ceiling: bossVariant.arenaType === 'hangar',
    startX: arenaStart,
    endX: arenaEnd,
    isBossArena: true
  });

  // Chão da arena + 3 plataformas táticas (2 laterais que podem desabar na fase 3 + 1 central alta)
  platforms.push(
    { x: arenaStart,       y: 156, w: arenaWidth, h: 24, style: 'building', segIndex: numMainSegments + 1 },
    { x: arenaStart + 34,  y: 118, w: 62, h: 6, style: 'billboard', oneWay: true, bossCollapsible: true, fallingState: 'idle', fallTimer: 0, baseX: arenaStart + 34, baseY: 118 },
    { x: arenaStart + 135, y: 92,  w: 66, h: 6, style: 'billboard', oneWay: true, baseX: arenaStart + 135, baseY: 92 },
    { x: arenaStart + 232, y: 118, w: 62, h: 6, style: 'billboard', oneWay: true, bossCollapsible: true, fallingState: 'idle', fallTimer: 0, baseX: arenaStart + 232, baseY: 118 }
  );

  const bossMaxHp = Math.round((420 + (level - 1) * 75) * (1 + numMainSegments * 0.05));
  const boss = {
    variant: bossVariant,
    name: bossVariant.name,
    x: arenaStart + 250,
    y: 92,
    w: 58,
    h: 64,
    hp: bossMaxHp,
    maxHp: bossMaxHp,
    phase: 1,
    active: false,
    defeated: false,
    exposed: false,
    exposeTimer: 0,
    state: 'idle', // idle | telegraph | slam | missiles | laser_sweep | mega_case | summon | exposed
    stateTimer: 1.5,
    attackQueue: [],
    facing: -1,
    animTime: 0,
    armAngle: 0,
    laserY: 140,
    hitFlash: 0
  };

  return {
    weather,
    segments,
    platforms,
    features,
    enemies,
    items,
    boss,
    arenaStart,
    arenaEnd,
    totalWidth: arenaEnd
  };
}

function createEnemyInstance(cfg, x, y, scaleMult = 1) {
  const maxHp = Math.round(cfg.hp * scaleMult);
  return {
    id: uid(),
    typeId: cfg.id,
    name: cfg.name,
    cfg,
    x,
    y,
    vx: 0,
    vy: 0,
    w: 14,
    h: 16,
    hp: maxHp,
    maxHp,
    dmg: Math.round(cfg.dmg * (0.85 + scaleMult * 0.15)),
    spd: cfg.spd,
    facing: -1,
    onGround: false,
    aiState: 'patrol', // patrol | detect | telegraph | attack | retreat
    stateTimer: 0.6 + Math.random() * 0.8,
    telegraphTime: 0,
    patrolDir: Math.random() < 0.5 ? -1 : 1,
    spawnX: x,
    hitFlash: 0,
    summonedOnce: false,
    aimLaser: null
  };
}

/* =====================================================================
   8. INICIALIZAÇÃO DA PARTIDA E CÁLCULO DE PODER DO AGENTE
   ===================================================================== */
const keys = {
  left: false,
  right: false,
  down: false,
  jump: false,
  jumpJustPressed: false,
  attack: false,
  attackJustPressed: false,
  skill: false,
  skillJustPressed: false
};

function computePlayerStats() {
  const lvl = state.level || 1;
  const upg = state.game?.upgrades || { hp: 0, dmg: 0, spd: 0 };
  const clsId = state.profile?.classe || 'guerreiro';
  const combat = CLASS_COMBAT[clsId] || CLASS_COMBAT.guerreiro;

  const maxHp = Math.round(
    (GAME_CONFIG.BASE_HP + (lvl - 1) * GAME_CONFIG.HP_PER_LEVEL + (upg.hp || 0) * GAME_CONFIG.HP_PER_UPGRADE) * combat.hpMult
  );
  const damage = Math.round(
    (GAME_CONFIG.BASE_DAMAGE + (lvl - 1) * GAME_CONFIG.DMG_PER_LEVEL + (upg.dmg || 0) * GAME_CONFIG.DMG_PER_UPGRADE) * combat.dmgMult
  );
  const bonusSpd = Math.min(GAME_CONFIG.MAX_BONUS_SPEED, (lvl - 1) * GAME_CONFIG.SPD_PER_LEVEL + (upg.spd || 0) * GAME_CONFIG.SPD_PER_UPGRADE);
  const speed = Math.round((GAME_CONFIG.BASE_SPEED + bonusSpd) * combat.spdMult);

  return { maxHp, damage, speed, combat, clsId };
}

function getDailyXPCap() {
  return Math.max(30, Math.round(xpToNext(state.level) * GAME_CONFIG.DAILY_XP_CAP_RATIO));
}

function getRemainingDailyGameXP() {
  const g = state.game;
  if (!g) return 30;
  if (g.dailyXPDate !== todayKey()) {
    g.dailyXPDate = todayKey();
    g.dailyXP = 0;
  }
  return Math.max(0, getDailyXPCap() - (g.dailyXP || 0));
}

function areAllDailyTasksCompleted() {
  return Array.isArray(state.tasks) && state.tasks.length > 0 && state.tasks.every(t => t.lastDone === todayKey());
}

async function startCityMission(coopOptions = null) {
  if (!navigator.onLine) {
    toast('VOCÊ ESTÁ OFFLINE. A MISSÃO NA CIDADE REQUER CONEXÃO COM O SERVIDOR.', true);
    return;
  }
  if (!state.profile) {
    toast('CRIE SEU PERSONAGEM PRIMEIRO!', true);
    openCharEditor('create');
    return;
  }
  state.game = state.game || DEFAULT_GAME_STATE();
  const isCoop = Boolean(coopOptions && coopOptions.roomId);
  const freePlay = areAllDailyTasksCompleted() || isCoop;
  if (!freePlay && (state.game.tickets || 0) < GAME_CONFIG.TICKET_COST) {
    toast('SEM FICHAS DE ENTRADA! CONCLUA UMA TAREFA DIÁRIA PARA GANHAR FICHAS.', true);
    return;
  }

  // Valida e desconta 1 ficha no servidor (RPC anti-cheat) se for partida solo
  if (!isCoop && window.currentUser && window.SB?.jogo) {
    try {
      if (typeof setSyncStatus === 'function') setSyncStatus('syncing', 'VALIDANDO FICHA...');
      const res = await window.SB.jogo.iniciarPartida();
      if (res?.profile) {
        state.game.tickets = res.profile.fichas;
      }
      if (typeof setSyncStatus === 'function') setSyncStatus('online');
    } catch (err) {
      if (typeof setSyncStatus === 'function') setSyncStatus('error');
      toast(err.message || 'ERRO AO INICIAR PARTIDA NO SERVIDOR.', true);
      return;
    }
  } else if (!freePlay) {
    state.game.tickets -= GAME_CONFIG.TICKET_COST;
  }

  // Atualiza status Presence para 'jogando'
  if (window.currentUser && window.SB?.amigos) {
    window.SB.amigos.atualizarStatusPresence(window.currentUser.id, 'jogando');
  }

  state.game.matchesPlayed = (state.game.matchesPlayed || 0) + 1;
  saveState();
  renderCityBanner();

  buildPlayerSprites();
  const pStats = computePlayerStats();
  const stage = generateStage(state.level, isCoop ? coopOptions.seed : null);
  const wpnColor = getWeaponColors({ level: state.level });

  game = {
    running: true,
    paused: false,
    over: false,
    won: false,
    isCoop,
    coopRoomId: isCoop ? coopOptions.roomId : null,
    coopSeed: isCoop ? coopOptions.seed : null,
    time: 0,
    cameraX: (28 + 6) - GAME_CONFIG.WIDTH / 2,
    cameraY: (130 + 8) - GAME_CONFIG.HEIGHT / 2,
    shakeTime: 0,
    shakeMag: 0,
    paperBlindTimer: 0,

    // Estatísticas da sessão
    distance: 0,
    maxX: 28,
    enemiesKilled: 0,
    coinsEarned: 0,
    rawXPEarned: 0,
    tookDamage: false,
    visitedSegments: new Set([1]),

    stage,
    weaponPalette: wpnColor,

    player: {
      x: 28,
      y: 130,
      vx: 0,
      vy: 0,
      w: 12,
      h: 16,
      facing: 1,
      hp: pStats.maxHp,
      maxHp: pStats.maxHp,
      shield: 0,
      maxShield: Math.round(pStats.maxHp * 0.5),
      damage: pStats.damage,
      speed: pStats.speed,
      combat: pStats.combat,
      clsId: pStats.clsId,
      onGround: false,
      coyoteTimer: 0,
      jumpBufferTimer: 0,
      jumpsLeft: 2,
      crouching: false,
      groundPlat: null,
      dropThroughTimer: 0,
      onZipline: null,
      atkTimer: 0,
      atkVisualTimer: 0,
      skillTimer: 0,
      invulnTimer: 0,
      specialAmmo: 0,
      overdriveTimer: 0,
      supportBuffTimer: 0,
      animTimer: 0,
      animFrame: 0
    },

    projectiles: [],      // tiros do jogador
    suitcases: [],        // maletas/mísseis inimigos
    shockwaves: [],       // ondas de choque no chão (boss / guerreiro)
    particles: [],        // faíscas, explosões, folhas, notas musicais
    floatingTexts: [],    // números de dano/cura/moedas
    bgRain: Array.from({ length: 42 }, () => ({
      x: Math.random() * GAME_CONFIG.WIDTH,
      y: Math.random() * GAME_CONFIG.HEIGHT,
      len: 5 + Math.random() * 6,
      spd: 150 + Math.random() * 70
    }))
  };

  // Prepara HUD da tela do jogo
  drawSprite($('#ghAvatarCanvas'), state.profile);
  $('#ghCharName').textContent = state.profile.nome;
  const clsObj = getClass(state.profile.classe);
  $('#ghCharClass').textContent = `NV ${state.level} • ${clsObj.name}`;
  $('#ghWeather').textContent = stage.weather.name;
  $('#bossHud').classList.add('hidden');
  $('#gameOverlay').classList.add('hidden');
  $('#paperBlindOverlay').classList.add('hidden');
  updateMuteButtonUI();
  updateGameHUD();

  const gameScreenEl = $('#gameScreen');
  gameScreenEl.classList.toggle('touch-mode', isTouchDevice());
  gameScreenEl.classList.add('open');
  document.body.classList.add('no-scroll');
  if (isTouchDevice()) enterGameFullscreen();
  playGameSfx('skill');
  startGameLoop();
}

/* =====================================================================
   9. LOOP PRINCIPAL EM requestAnimationFrame COM PASSO DE TEMPO FIXO
   ===================================================================== */
let rafId = null;
let lastFrameTime = 0;
let accumulator = 0;

function startGameLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  lastFrameTime = performance.now();
  accumulator = 0;
  rafId = requestAnimationFrame(gameLoopStep);
}

function gameLoopStep(now) {
  if (!game || !game.running) return;
  let frameDt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  if (frameDt > 0.1) frameDt = 0.1; // evita espiral após aba oculta

  if (!game.paused && !game.over) {
    accumulator += frameDt;
    while (accumulator >= GAME_CONFIG.FIXED_DT) {
      updateGame(GAME_CONFIG.FIXED_DT);
      accumulator -= GAME_CONFIG.FIXED_DT;
    }
  }
  renderGameCanvas();
  rafId = requestAnimationFrame(gameLoopStep);
}

/* =====================================================================
   10. ATUALIZAÇÃO DE FÍSICA, COMBATE, IA E ELEMENTOS DE PLATAFORMA
   ===================================================================== */
function updateGame(dt) {
  game.time += dt;
  const p = game.player;
  const st = game.stage;

  if (game.shakeTime > 0) game.shakeTime = Math.max(0, game.shakeTime - dt);
  if (game.paperBlindTimer > 0) {
    game.paperBlindTimer = Math.max(0, game.paperBlindTimer - dt);
    $('#paperBlindOverlay').classList.toggle('hidden', game.paperBlindTimer <= 0);
  }

  // Timers do jogador
  if (p.atkTimer > 0) p.atkTimer = Math.max(0, p.atkTimer - dt);
  if (p.atkVisualTimer > 0) p.atkVisualTimer = Math.max(0, p.atkVisualTimer - dt);
  if (p.skillTimer > 0) p.skillTimer = Math.max(0, p.skillTimer - dt);
  if (p.invulnTimer > 0) p.invulnTimer = Math.max(0, p.invulnTimer - dt);
  if (p.overdriveTimer > 0) p.overdriveTimer = Math.max(0, p.overdriveTimer - dt);
  if (p.supportBuffTimer > 0) p.supportBuffTimer = Math.max(0, p.supportBuffTimer - dt);

  // 1. Atualiza plataformas móveis, elevadores e plataformas que caem
  st.platforms.forEach(plat => {
    plat.prevX = plat.x;
    plat.prevY = plat.y;
    if (plat.style === 'moving_x') {
      plat.x = plat.baseX + Math.sin(game.time * (plat.spd / 20)) * plat.range;
    } else if (plat.style === 'elevator') {
      plat.y = plat.baseY - Math.abs(Math.sin(game.time * (plat.spd / 28))) * plat.rangeY;
    } else if (plat.style === 'falling' || plat.bossCollapsible) {
      if (plat.fallingState === 'shake') {
        plat.fallTimer -= dt;
        if (plat.fallTimer <= 0) {
          plat.fallingState = 'fall';
          plat.fallTimer = 2.6;
        }
      } else if (plat.fallingState === 'fall') {
        plat.y += 160 * dt;
        plat.fallTimer -= dt;
        if (plat.fallTimer <= 0) {
          plat.fallingState = 'idle';
          plat.y = plat.baseY;
        }
      }
    }
  });

  // 2. Movimento horizontal do jogador
  const spdMult = (p.overdriveTimer > 0 ? 1.28 : 1) * (p.supportBuffTimer > 0 ? 1.18 : 1);
  const moveSpd = p.speed * spdMult;
  let moveDir = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);

  if (p.onZipline) {
    // Deslizando na tirolesa
    const zip = p.onZipline;
    const dx = zip.x2 - zip.x1, dy = zip.y2 - zip.y1;
    const len = Math.hypot(dx, dy) || 1;
    p.vx = (dx / len) * 145;
    p.vy = (dy / len) * 145;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.facing = 1;
    if (p.x >= zip.x2 - 6 || keys.jumpJustPressed) {
      p.onZipline = null;
      if (keys.jumpJustPressed) {
        p.vy = GAME_CONFIG.JUMP_FORCE * 0.9;
        playGameSfx('jump');
      }
    }
  } else {
    // Abaixar em cima de plataforma vazada (oneWay) faz o personagem descer por ela
    p.dropThroughTimer = Math.max(0, (p.dropThroughTimer || 0) - dt);
    if (keys.down && p.onGround && p.groundPlat?.oneWay) {
      p.dropThroughTimer = 0.25;
      p.onGround = false;
      p.groundPlat = null;
      p.coyoteTimer = 0;
      p.jumpBufferTimer = 0;
      p.y += 2;
      p.vy = Math.max(p.vy, 40);
    }
    p.crouching = keys.down && p.onGround;
    if (moveDir !== 0) {
      p.facing = moveDir;
      p.vx = moveDir * (p.crouching ? moveSpd * 0.45 : moveSpd);
    } else {
      p.vx *= 0.72;
      if (Math.abs(p.vx) < 4) p.vx = 0;
    }

    // Coyote time & Jump buffer
    if (p.onGround) {
      p.coyoteTimer = GAME_CONFIG.COYOTE_TIME;
      p.jumpsLeft = 2;
    } else {
      p.coyoteTimer = Math.max(0, p.coyoteTimer - dt);
    }

    if (keys.jumpJustPressed) {
      p.jumpBufferTimer = GAME_CONFIG.JUMP_BUFFER;
    } else {
      p.jumpBufferTimer = Math.max(0, p.jumpBufferTimer - dt);
    }

    // Executa pulo ou pulo duplo
    if (p.jumpBufferTimer > 0) {
      if (p.coyoteTimer > 0) {
        p.vy = GAME_CONFIG.JUMP_FORCE;
        p.onGround = false;
        p.coyoteTimer = 0;
        p.jumpBufferTimer = 0;
        p.jumpsLeft = 1;
        spawnParticles(p.x + p.w / 2, p.y + p.h, '#00F0FF', 5);
        playGameSfx('jump');
      } else if (p.jumpsLeft > 0) {
        p.vy = GAME_CONFIG.DOUBLE_JUMP_FORCE;
        p.jumpsLeft--;
        p.jumpBufferTimer = 0;
        spawnParticles(p.x + p.w / 2, p.y + p.h, '#7CFF3A', 7);
        playGameSfx('double_jump');
      }
    }

    // Altura de pulo variável ao soltar a tecla de pulo
    if (!keys.jump && p.vy < -40) {
      p.vy *= GAME_CONFIG.VARIABLE_JUMP_CUT;
    }

    // Gravidade
    p.vy = Math.min(GAME_CONFIG.MAX_FALL_SPEED, p.vy + GAME_CONFIG.GRAVITY * dt);

    // Move X e checa portas de segurança trancadas
    const prevX = p.x;
    p.x += p.vx * dt;

    // Limites da fase / arena do boss
    const minBoundX = st.boss.active ? st.arenaStart + 4 : 4;
    const maxBoundX = st.totalWidth - p.w - 4;
    if (p.x < minBoundX) p.x = minBoundX;
    if (p.x > maxBoundX) p.x = maxBoundX;

    st.features.forEach(f => {
      if (f.kind === 'security_door' && !f.unlocked) {
        if (rectsOverlap(p.x, p.y, p.w, p.h, f.x, f.y, 8, f.h)) {
          p.x = prevX;
          p.vx = 0;
        }
      }
    });

    // Move Y e resolve colisão com plataformas
    const prevBottom = p.y + p.h;
    p.y += p.vy * dt;
    p.onGround = false;
    p.groundPlat = null;

    for (const plat of st.platforms) {
      if (plat.fallingState === 'fall') continue;
      const withinX = p.x + p.w > plat.x + 1 && p.x < plat.x + plat.w - 1;
      if (!withinX) continue;

      // Descendo sobre a plataforma
      if (p.vy >= 0 && prevBottom <= plat.prevY + 5 && p.y + p.h >= plat.y) {
        // Ignora plataformas vazadas enquanto o personagem está descendo por elas (abaixar)
        if (plat.oneWay && (p.dropThroughTimer > 0 || keys.down)) continue;
        p.y = plat.y - p.h;
        p.vy = 0;
        p.onGround = true;
        p.groundPlat = plat;

        // Acompanha plataforma móvel ou esteira
        if (plat.style === 'moving_x') {
          p.x += (plat.x - plat.prevX);
        } else if (plat.style === 'conveyor') {
          p.x += (plat.vx || 0) * dt;
        } else if (plat.style === 'falling' && plat.fallingState === 'idle') {
          plat.fallingState = 'shake';
          plat.fallTimer = 0.48;
        }
        break;
      }
    }

    // Queda em vão entre prédios: resgata no último prédio seguro com dano leve
    if (p.y > GAME_CONFIG.HEIGHT + 24) {
      damagePlayer(15, true);
      p.vy = -120;
      p.y = 95;
      p.x = Math.max(24, p.x - 42);
    }
  }

  // 3. Interações com features do cenário (ventos, tirolesas, cartões de acesso, lasers, drones)
  st.features.forEach(f => {
    if (f.kind === 'wind') {
      if (rectsOverlap(p.x, p.y, p.w, p.h, f.x, f.y, f.w, f.h)) {
        p.vy = Math.max(-185, p.vy + f.vy * dt * 2.4);
      }
    } else if (f.kind === 'zipline' && !p.onZipline && p.vy >= -20) {
      if (Math.abs((p.x + p.w / 2) - f.x1) < 14 && Math.abs(p.y - f.y1) < 16) {
        p.onZipline = f;
        p.y = f.y1;
        playGameSfx('item');
      }
    } else if (f.kind === 'security_door' && !f.unlocked) {
      // Cartão de acesso
      if (rectsOverlap(p.x, p.y, p.w, p.h, f.keyX - 6, f.keyY - 6, 12, 12)) {
        f.unlocked = true;
        addFloatingText(f.keyX, f.keyY - 8, 'ACESSO LIBERADO!', '#7CFF3A');
        playGameSfx('item');
      }
    } else if (f.kind === 'laser') {
      const cycle = ((game.time + (f.phase || 0)) % f.period) / f.period;
      f.isOn = cycle < (f.activeRatio || 0.5);
      f.isWarning = !f.isOn && cycle > 0.82;
      if (f.isOn && rectsOverlap(p.x, p.y, p.w, p.h, f.x - 2, f.y, 4, f.h)) {
        damagePlayer(14);
      }
    } else if (f.kind === 'drone' && f.alive) {
      f.x += f.vx * dt;
      if (Math.abs(f.x - f.baseX) > f.range) f.vx = -f.vx;
      if (rectsOverlap(p.x, p.y, p.w, p.h, f.x - 7, f.y - 6, 14, 12)) {
        damagePlayer(12);
      }
    }
  });

  // 4. Ataques e Habilidade Especial da Classe
  if (keys.attackJustPressed && p.atkTimer <= 0) {
    performPlayerAttack();
    if (game.isCoop && window.SB?.multiplayer) {
      window.SB.multiplayer.transmitirAcaoJogador('attack', p);
    }
  }
  if (keys.skillJustPressed && p.skillTimer <= 0) {
    performPlayerSkill();
    if (game.isCoop && window.SB?.multiplayer) {
      window.SB.multiplayer.transmitirAcaoJogador('skill', p);
    }
  }

  // Animação de passos do agente
  if (Math.abs(p.vx) > 10 && p.onGround) {
    p.animTimer += dt;
    if (p.animTimer >= 0.12) {
      p.animTimer = 0;
      p.animFrame = p.animFrame === 1 ? 2 : 1;
    }
  } else {
    p.animFrame = 0;
  }

  // 5. Atualiza distância e progresso por segmentos
  if (p.x > game.maxX) {
    game.maxX = p.x;
    game.distance = Math.floor((game.maxX - 28) / 8);
  }
  const curSeg = st.segments.find(s => p.x >= s.startX && p.x <= s.endX) || st.segments[0];
  if (curSeg && !game.visitedSegments.has(curSeg.index)) {
    game.visitedSegments.add(curSeg.index);
    awardMatchXP(GAME_CONFIG.XP_PER_SEGMENT);
    addFloatingText(p.x, p.y - 14, `SETOR ${curSeg.index}! +${GAME_CONFIG.XP_PER_SEGMENT} XP`, '#00F0FF');
  }

  // Ativa o Boss quando o jogador entra na Arena Final
  if (!st.boss.active && !st.boss.defeated && p.x >= st.arenaStart + 24) {
    st.boss.active = true;
    $('#bossHud').classList.remove('hidden');
    $('#bossName').textContent = st.boss.name;
    addFloatingText(st.boss.x, st.boss.y - 12, 'ALERTA DE BOSS!', '#FF3B2F');
    playGameSfx('boss_roar');
  }

  // 6. Atualiza Projéteis do Jogador, Inimigos, Maletas, Boss e Itens
  updateProjectiles(dt);
  updateEnemies(dt);
  if (st.boss.active && !st.boss.defeated) updateBoss(dt);
  updateSuitcases(dt);
  updateShockwaves(dt);
  updateItems(dt);
  updateParticlesAndTexts(dt);

  // Sincronização em tempo real do Multiplayer Cooperativo (Broadcast 15-20 msgs/s + Interpolação)
  if (game.isCoop && window.SB?.multiplayer) {
    window.SB.multiplayer.transmitirEstadoJogador(p);
    window.SB.multiplayer.interpolarJogadoresRemotos(dt);
    if (window.SB.multiplayer.souHost()) {
      window.SB.multiplayer.transmitirEstadoMundoHost(game);
    }
  }

  // 7. Câmera suave centralizada no personagem (X e Y)
  const targetCamX = (p.x + p.w / 2) - GAME_CONFIG.WIDTH / 2;
  const targetCamY = (p.y + p.h / 2) - GAME_CONFIG.HEIGHT / 2;
  game.cameraX += (targetCamX - game.cameraX) * Math.min(1, dt * 12);
  game.cameraY += (targetCamY - game.cameraY) * Math.min(1, dt * 10);

  // Limpa flags "justPressed" do frame
  keys.jumpJustPressed = false;
  keys.attackJustPressed = false;
  keys.skillJustPressed = false;

  updateGameHUD();
}

/* =====================================================================
   11. SISTEMA DE COMBATE POR CLASSE & HABILIDADES ESPECIAIS
   ===================================================================== */
function getEffectivePlayerDamage() {
  const p = game.player;
  let d = p.damage;
  if (p.overdriveTimer > 0) d *= 1.35;
  if (p.supportBuffTimer > 0) d *= 1.20;
  if (p.specialAmmo > 0) d *= 1.45;
  return Math.round(d);
}

function performPlayerAttack() {
  const p = game.player;
  const cb = p.combat;
  const cdMult = p.overdriveTimer > 0 ? 0.65 : 1;
  p.atkTimer = cb.cd * cdMult;
  p.atkVisualTimer = 0.14;

  const dmg = getEffectivePlayerDamage();
  const wColor = game.weaponPalette?.W || cb.color;
  if (p.specialAmmo > 0) p.specialAmmo--;

  if (cb.group === 'melee_heavy' || cb.group === 'melee_fast') {
    playGameSfx('melee');
    const reach = cb.range || 22;
    const hx = p.facing > 0 ? p.x + p.w - 2 : p.x - reach + 2;
    const hy = p.y - 2;
    const hw = reach;
    const hh = p.h + 4;

    // Corta maletas no ar com ataque corpo a corpo
    game.suitcases.forEach(sc => {
      if (!sc.mega && rectsOverlap(hx, hy, hw, hh, sc.x - 5, sc.y - 4, 10, 8)) {
        destroySuitcase(sc, true);
      }
    });

    // Dano em drones
    game.stage.features.forEach(f => {
      if (f.kind === 'drone' && f.alive && rectsOverlap(hx, hy, hw, hh, f.x - 8, f.y - 8, 16, 16)) {
        damageDrone(f, dmg);
      }
    });

    // Dano em inimigos
    game.stage.enemies.forEach(en => {
      if (en.hp > 0 && rectsOverlap(hx, hy, hw, hh, en.x, en.y, en.w, en.h)) {
        damageEnemy(en, dmg, p.facing * 90);
      }
    });

    // Dano no Boss
    const b = game.stage.boss;
    if (b.active && !b.defeated && rectsOverlap(hx, hy, hw, hh, b.x, b.y, b.w, b.h)) {
      damageBoss(dmg);
    }

    // Ladino / Monge solta onda curta de vento energético
    if (cb.group === 'melee_fast') {
      game.projectiles.push({
        x: p.facing > 0 ? p.x + p.w + 2 : p.x - 6,
        y: p.y + 6,
        vx: p.facing * 220,
        vy: 0,
        r: 3,
        dmg: Math.round(dmg * 0.55),
        color: wColor,
        life: 0.14,
        pierce: true
      });
    }
  } else {
    // Arqueiro/Caçador, Mago/Necromante/Druida, Clérigo/Bardo
    playGameSfx('shoot');
    const spd = cb.projSpd || 185;
    game.projectiles.push({
      x: p.facing > 0 ? p.x + p.w + 2 : p.x - 4,
      y: p.y + (p.crouching ? 9 : 6),
      vx: p.facing * spd,
      vy: 0,
      r: cb.group === 'magic' ? 4 : 3,
      dmg,
      color: wColor,
      group: cb.group,
      clsId: p.clsId,
      life: 1.35,
      pierce: p.specialAmmo > 0
    });
  }
}

function performPlayerSkill() {
  const p = game.player;
  const cb = p.combat;
  p.skillTimer = cb.skillCd;
  p.atkVisualTimer = 0.25;
  playGameSfx('skill');

  const dmg = Math.round(getEffectivePlayerDamage() * 1.9);
  const wColor = game.weaponPalette?.G || cb.color;
  addFloatingText(p.x, p.y - 12, cb.skillName + '!', cb.color);

  if (cb.group === 'melee_heavy') {
    // Onda de choque dupla no chão + escudo leve (Paladino)
    if (p.clsId === 'paladino') {
      p.shield = Math.min(p.maxShield, p.shield + 28);
    }
    game.shockwaves.push(
      { x: p.x + p.w / 2, y: 154, vx: p.facing * 170, w: 12, h: 12, dmg, friendly: true, color: cb.color, life: 1.1 },
      { x: p.x + p.w / 2, y: 154, vx: -p.facing * 130, w: 10, h: 10, dmg: Math.round(dmg * 0.8), friendly: true, color: cb.color, life: 0.7 }
    );
    triggerScreenShake(0.22, 3);
  } else if (cb.group === 'ranged_bow') {
    // Rajada de 3 disparos perfurantes em leque
    [-28, 0, 28].forEach(vy => {
      game.projectiles.push({
        x: p.facing > 0 ? p.x + p.w : p.x - 4,
        y: p.y + 6,
        vx: p.facing * 235,
        vy,
        r: 4,
        dmg: Math.round(dmg * 0.75),
        color: wColor,
        group: cb.group,
        clsId: p.clsId,
        life: 1.2,
        pierce: true
      });
    });
  } else if (cb.group === 'magic') {
    // Grande Orbe Arcano que atravessa inimigos e destrói maletas
    game.projectiles.push({
      x: p.facing > 0 ? p.x + p.w + 4 : p.x - 8,
      y: p.y + 4,
      vx: p.facing * 145,
      vy: 0,
      r: 7,
      dmg,
      color: cb.color,
      group: 'magic_skill',
      clsId: p.clsId,
      life: 1.6,
      pierce: true
    });
  } else if (cb.group === 'melee_fast') {
    // Dash relâmpago invulnerável cortando todos no caminho
    p.invulnTimer = 0.45;
    const startX = p.x;
    const dashDist = p.facing * 72;
    p.x = Math.max(8, Math.min(game.stage.totalWidth - 20, p.x + dashDist));
    const minX = Math.min(startX, p.x), maxX = Math.max(startX + p.w, p.x + p.w);
    spawnParticles((minX + maxX) / 2, p.y + 8, cb.color, 14);
    game.stage.enemies.forEach(en => {
      if (en.hp > 0 && rectsOverlap(minX, p.y - 6, maxX - minX, p.h + 12, en.x, en.y, en.w, en.h)) {
        damageEnemy(en, dmg, p.facing * 110);
      }
    });
    const b = game.stage.boss;
    if (b.active && !b.defeated && rectsOverlap(minX, p.y - 6, maxX - minX, p.h + 12, b.x, b.y, b.w, b.h)) {
      damageBoss(dmg);
    }
  } else if (cb.group === 'support') {
    // Cura imediata + Buff de velocidade/dano + onda sônica/luminosa
    const heal = Math.round(p.maxHp * 0.24);
    p.hp = Math.min(p.maxHp, p.hp + heal);
    p.supportBuffTimer = 6.0;
    addFloatingText(p.x, p.y - 20, `+${heal} VIDA & BUFF!`, '#7CFF3A');
    spawnParticles(p.x + p.w / 2, p.y + 8, '#7CFF3A', 14);
    [-1, 1].forEach(dir => {
      game.projectiles.push({
        x: p.x + p.w / 2,
        y: p.y + 6,
        vx: dir * 185,
        vy: 0,
        r: 5,
        dmg: Math.round(dmg * 0.8),
        color: cb.color,
        group: 'support',
        clsId: p.clsId,
        life: 1.0,
        pierce: true
      });
    });
  }
}

function onPlayerSuccessfulHit() {
  const p = game.player;
  // Passiva de Clérigo/Bardo: cura leve ou buff ao acertar inimigos
  if (p.combat.group === 'support') {
    if (p.clsId === 'clerigo') {
      const heal = Math.max(2, Math.round(p.maxHp * 0.03));
      if (p.hp < p.maxHp) {
        p.hp = Math.min(p.maxHp, p.hp + heal);
        addFloatingText(p.x, p.y - 6, `+${heal}`, '#7CFF3A');
      }
    } else {
      p.supportBuffTimer = Math.max(p.supportBuffTimer, 3.2);
    }
  } else if (p.clsId === 'necromante' && Math.random() < 0.35) {
    p.hp = Math.min(p.maxHp, p.hp + 2);
  }
}

function updateProjectiles(dt) {
  for (let i = game.projectiles.length - 1; i >= 0; i--) {
    const pr = game.projectiles[i];
    pr.x += pr.vx * dt;
    pr.y += pr.vy * dt;
    pr.life -= dt;

    let hit = false;

    // Intercepta maletas no ar
    for (let j = game.suitcases.length - 1; j >= 0; j--) {
      const sc = game.suitcases[j];
      if (!sc.mega && rectsOverlap(pr.x - pr.r, pr.y - pr.r, pr.r * 2, pr.r * 2, sc.x - 5, sc.y - 4, 10, 8)) {
        destroySuitcase(sc, true);
        if (!pr.pierce) { hit = true; break; }
      }
    }

    // Dano em drones
    if (!hit) {
      for (const f of game.stage.features) {
        if (f.kind === 'drone' && f.alive && rectsOverlap(pr.x - pr.r, pr.y - pr.r, pr.r * 2, pr.r * 2, f.x - 7, f.y - 6, 14, 12)) {
          damageDrone(f, pr.dmg);
          if (!pr.pierce) { hit = true; break; }
        }
      }
    }

    // Dano em inimigos
    if (!hit) {
      for (const en of game.stage.enemies) {
        if (en.hp > 0 && rectsOverlap(pr.x - pr.r, pr.y - pr.r, pr.r * 2, pr.r * 2, en.x, en.y, en.w, en.h)) {
          damageEnemy(en, pr.dmg, Math.sign(pr.vx) * 60);
          onPlayerSuccessfulHit();
          if (!pr.pierce) { hit = true; break; }
        }
      }
    }

    // Dano no Boss
    const b = game.stage.boss;
    if (!hit && b.active && !b.defeated && rectsOverlap(pr.x - pr.r, pr.y - pr.r, pr.r * 2, pr.r * 2, b.x, b.y, b.w, b.h)) {
      damageBoss(pr.dmg);
      onPlayerSuccessfulHit();
      if (!pr.pierce) hit = true;
    }

    if (hit || pr.life <= 0) {
      game.projectiles.splice(i, 1);
    }
  }
}

/* =====================================================================
   12. IA DOS INIMIGOS (Homens de Terno) & MALETAS VARIÁVEIS
   ===================================================================== */
function updateEnemies(dt) {
  const p = game.player;

  game.stage.enemies.forEach(en => {
    if (en.hp <= 0) return;
    if (en.hitFlash > 0) en.hitFlash = Math.max(0, en.hitFlash - dt);

    const distToPlayer = Math.hypot((p.x + p.w / 2) - (en.x + en.w / 2), (p.y + p.h / 2) - (en.y + en.h / 2));
    if (distToPlayer > 290) return; // só processa inimigos próximos da tela

    const dx = (p.x + p.w / 2) - (en.x + en.w / 2);
    const absDx = Math.abs(dx);
    en.facing = dx >= 0 ? 1 : -1;

    // Gravidade e colisão simples de plataforma para o inimigo
    en.vy = Math.min(220, en.vy + GAME_CONFIG.GRAVITY * dt);
    const prevBottom = en.y + en.h;
    en.y += en.vy * dt;
    en.onGround = false;
    for (const plat of game.stage.platforms) {
      if (plat.fallingState === 'fall') continue;
      if (en.x + en.w > plat.x + 2 && en.x < plat.x + plat.w - 2) {
        if (en.vy >= 0 && prevBottom <= plat.y + 5 && en.y + en.h >= plat.y) {
          en.y = plat.y - en.h;
          en.vy = 0;
          en.onGround = true;
          break;
        }
      }
    }

    // Estados de IA: patrol -> detect -> telegraph -> attack -> retreat
    en.stateTimer -= dt;
    en.aimLaser = null;

    if (en.cfg.behavior === 'runner') {
      // Estagiário Corredor: avança rápido e causa dano por contato
      if (absDx < 150) {
        en.vx = en.facing * en.spd;
        if (en.onGround && Math.abs(p.y - en.y) > 22 && absDx < 55) {
          en.vy = -145;
        }
      } else {
        en.vx = en.patrolDir * (en.spd * 0.45);
        if (Math.abs(en.x - en.spawnX) > 35) en.patrolDir = -en.patrolDir;
      }
      if (rectsOverlap(p.x, p.y, p.w, p.h, en.x + 2, en.y + 2, en.w - 4, en.h - 2)) {
        damagePlayer(en.dmg);
        en.vx = -en.facing * 80;
      }
    } else {
      // Inimigos que lançam maletas (Executivo, Segurança, Gerente, Contador, Diretor)
      if (en.aiState === 'patrol') {
        en.vx = en.patrolDir * (en.spd * 0.5);
        if (Math.abs(en.x - en.spawnX) > 28) en.patrolDir = -en.patrolDir;
        if (absDx < 165) {
          en.aiState = 'detect';
          en.stateTimer = 0.45;
        }
      } else if (en.aiState === 'detect') {
        en.vx = 0;
        if (en.cfg.behavior === 'jumper' && en.onGround) {
          en.vy = -155;
          en.vx = en.facing * 45;
        }
        if (en.stateTimer <= 0) {
          en.aiState = 'telegraph';
          en.telegraphTime = en.cfg.behavior === 'sniper' ? 0.75 : 0.45;
          en.stateTimer = en.telegraphTime;
        }
      } else if (en.aiState === 'telegraph') {
        en.vx = 0;
        if (en.cfg.behavior === 'sniper') {
          en.aimLaser = { x1: en.x + en.w / 2, y1: en.y + 6, x2: p.x + p.w / 2, y2: p.y + p.h / 2 };
        }
        if (en.stateTimer <= 0) {
          spawnEnemySuitcaseAttack(en);
          en.aiState = 'retreat';
          en.stateTimer = 0.9 + Math.random() * 0.5;
        }
      } else if (en.aiState === 'retreat') {
        en.vx = (absDx < 55 && en.cfg.behavior !== 'sniper') ? -en.facing * (en.spd * 0.75) : 0;
        if (en.stateTimer <= 0) {
          en.aiState = 'detect';
          en.stateTimer = 0.5 + Math.random() * 0.4;
        }
      }
    }

    // Move X mantendo o inimigo sobre a plataforma atual
    const nextX = en.x + en.vx * dt;
    const hasFloorAhead = game.stage.platforms.some(pl =>
      pl.fallingState !== 'fall' &&
      nextX + en.w / 2 >= pl.x + 4 &&
      nextX + en.w / 2 <= pl.x + pl.w - 4 &&
      Math.abs(pl.y - (en.y + en.h)) < 28
    );
    if (hasFloorAhead || !en.onGround) {
      en.x = nextX;
    } else {
      en.patrolDir = -en.patrolDir;
      en.vx = 0;
    }
  });
}

function chooseSuitcaseKind() {
  const r = Math.random();
  if (r < 0.48) return 'normal';
  if (r < 0.68) return 'explosive';
  if (r < 0.85) return 'bouncy';
  return 'paper';
}

function spawnEnemySuitcaseAttack(en) {
  const p = game.player;
  const sx = en.x + en.w / 2 + en.facing * 6;
  const sy = en.y + 6;
  const kind = chooseSuitcaseKind();
  playGameSfx('shoot');

  if (en.cfg.behavior === 'thrower_arc' || en.cfg.behavior === 'jumper') {
    const dx = (p.x + p.w / 2) - sx;
    game.suitcases.push({
      x: sx, y: sy,
      vx: Math.max(-135, Math.min(135, dx * 1.15)),
      vy: -135,
      gravity: 280,
      dmg: en.dmg,
      kind,
      bounces: kind === 'bouncy' ? 3 : 0,
      rot: 0,
      life: 3.2
    });
  } else if (en.cfg.behavior === 'thrower_fast') {
    game.suitcases.push({
      x: sx, y: sy,
      vx: en.facing * 155,
      vy: 0,
      gravity: 0,
      dmg: en.dmg,
      kind,
      bounces: kind === 'bouncy' ? 2 : 0,
      rot: 0,
      life: 2.5
    });
  } else if (en.cfg.behavior === 'sniper') {
    const ang = Math.atan2((p.y + p.h / 2) - sy, (p.x + p.w / 2) - sx);
    game.suitcases.push({
      x: sx, y: sy,
      vx: Math.cos(ang) * 195,
      vy: Math.sin(ang) * 195,
      gravity: 0,
      dmg: en.dmg,
      kind: 'explosive',
      bounces: 0,
      rot: 0,
      life: 2.2
    });
  } else if (en.cfg.behavior === 'director') {
    // Diretor: atira 3 maletas em leque e invoca um estagiário se ainda não invocou
    [-55, -15, 25].forEach(vy => {
      game.suitcases.push({
        x: sx, y: sy,
        vx: en.facing * 135,
        vy,
        gravity: 90,
        dmg: en.dmg,
        kind: chooseSuitcaseKind(),
        bounces: 1,
        rot: 0,
        life: 2.8
      });
    });
    if (!en.summonedOnce) {
      en.summonedOnce = true;
      const minion = createEnemyInstance(ENEMY_TYPES.estagiario, en.x + en.facing * 18, en.y - 4, 1 + (state.level - 1) * 0.1);
      game.stage.enemies.push(minion);
      addFloatingText(en.x, en.y - 12, 'ESTAGIÁRIO, RESOLVA ISSO!', '#FFC21A');
    }
  }
}

function updateSuitcases(dt) {
  const p = game.player;

  for (let i = game.suitcases.length - 1; i >= 0; i--) {
    const sc = game.suitcases[i];
    sc.vy += (sc.gravity || 0) * dt;
    sc.x += sc.vx * dt;
    sc.y += sc.vy * dt;
    sc.rot += dt * 10;
    sc.life -= dt;

    // Colisão com o chão / plataformas
    let hitFloor = false;
    for (const plat of game.stage.platforms) {
      if (plat.fallingState === 'fall') continue;
      if (sc.x >= plat.x && sc.x <= plat.x + plat.w && sc.y + 4 >= plat.y && sc.y - 4 <= plat.y + plat.h) {
        if (sc.bounces > 0) {
          sc.bounces--;
          sc.vy = -Math.abs(sc.vy || 110) * 0.78;
          sc.y = plat.y - 5;
          playGameSfx('hit');
        } else {
          hitFloor = true;
        }
        break;
      }
    }

    // Rebate nas bordas da câmera se for bouncy
    if (sc.bounces > 0 && (sc.x < game.cameraX + 6 || sc.x > game.cameraX + GAME_CONFIG.WIDTH - 6)) {
      sc.vx = -sc.vx;
      sc.bounces--;
    }

    // Colisão com o jogador
    const hitW = sc.mega ? 14 : 9;
    const hitH = sc.mega ? 12 : 7;
    if (rectsOverlap(p.x, p.y, p.w, p.h, sc.x - hitW / 2, sc.y - hitH / 2, hitW, hitH)) {
      triggerSuitcaseEffect(sc);
      game.suitcases.splice(i, 1);
      continue;
    }

    if (hitFloor || sc.life <= 0) {
      if (sc.kind === 'explosive' || sc.mega) {
        spawnParticles(sc.x, sc.y, '#FF3B2F', 12);
        playGameSfx('explosion');
        if (Math.hypot((p.x + p.w / 2) - sc.x, (p.y + p.h / 2) - sc.y) < (sc.mega ? 34 : 22)) {
          damagePlayer(sc.dmg);
        }
      }
      game.suitcases.splice(i, 1);
    }
  }
}

function triggerSuitcaseEffect(sc) {
  damagePlayer(sc.dmg);
  if (sc.kind === 'explosive' || sc.mega) {
    spawnParticles(sc.x, sc.y, '#FF3B2F', 14);
    playGameSfx('explosion');
    triggerScreenShake(0.2, 3);
  } else if (sc.kind === 'paper') {
    spawnParticles(sc.x, sc.y, '#FFFFFF', 12);
    game.paperBlindTimer = 1.65;
    $('#paperBlindOverlay').classList.remove('hidden');
    addFloatingText(game.player.x, game.player.y - 12, 'BUROCRACIA CEGANTE!', '#FFFFFF');
  } else {
    spawnParticles(sc.x, sc.y, '#FFC21A', 6);
  }
}

function destroySuitcase(sc, dropAllowed = true) {
  spawnParticles(sc.x, sc.y, '#00F0FF', 7);
  playGameSfx('hit');
  sc.life = 0;
  if (dropAllowed && Math.random() < GAME_CONFIG.SUITCASE_DROP_CHANCE) {
    const dropKind = Math.random() < 0.65 ? 'coin' : 'heal_chip';
    game.stage.items.push({ id: uid(), kind: dropKind, x: sc.x, y: sc.y, vy: -65, collected: false });
  }
}

/* =====================================================================
   13. BOSS: ROBÔ GIGANTE (3 Fases, Ponto Fraco no Núcleo, Ataques Variáveis)
   ===================================================================== */
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getBossNextAttack(b) {
  if (!b.attackQueue || !b.attackQueue.length) {
    let pool = ['slam', 'missiles'];
    if (b.phase >= 2) pool.push('laser_sweep', 'mega_case');
    if (b.phase >= 3) pool.push('summon_collapse');
    b.attackQueue = shuffleArray(pool);
  }
  return b.attackQueue.pop();
}

function updateBoss(dt) {
  const b = game.stage.boss;
  const p = game.player;
  b.animTime += dt;
  if (b.hitFlash > 0) b.hitFlash = Math.max(0, b.hitFlash - dt);

  // Atualiza fase conforme a vida diminui (100-66% = F1, 66-33% = F2, <33% = F3 Fúria)
  const hpRatio = b.hp / b.maxHp;
  const newPhase = hpRatio <= 0.34 ? 3 : hpRatio <= 0.67 ? 2 : 1;
  if (newPhase > b.phase) {
    b.phase = newPhase;
    b.attackQueue = [];
    b.exposed = false;
    b.state = 'idle';
    b.stateTimer = 0.8;
    triggerScreenShake(0.4, 4);
    playGameSfx('boss_roar');
    addFloatingText(b.x, b.y - 16, b.phase === 3 ? 'MODO FÚRIA ATIVADO!' : 'FASE 2: PROTOCOLO LASER!', '#FF3B2F');
  }

  $('#bossPhaseTxt').textContent = `FASE ${b.phase}/3 ${b.exposed ? '• ⚡ NÚCLEO EXPOSTO!' : '• BLINDAGEM ATIVA'}`;
  $('#bossHpFill').style.width = Math.max(0, Math.round(hpRatio * 100)) + '%';

  b.facing = (p.x + p.w / 2) < (b.x + b.w / 2) ? -1 : 1;
  b.stateTimer -= dt;

  // Na Fase 3 (Fúria), o núcleo permanece mais vulnerável
  if (b.state === 'exposed') {
    b.exposed = true;
    b.armAngle = Math.sin(b.animTime * 4) * 0.15;
    if (b.stateTimer <= 0) {
      b.exposed = false;
      b.state = 'idle';
      b.stateTimer = b.phase === 3 ? 0.55 : 0.9;
    }
    return;
  }

  if (b.state === 'idle') {
    b.exposed = b.phase === 3; // Na fúria o núcleo brilha sem parar
    b.armAngle = Math.sin(b.animTime * 3) * 0.25;
    // Move levemente na arena
    const targetX = game.stage.arenaStart + 235 + Math.sin(b.animTime * 1.2) * 35;
    b.x += (targetX - b.x) * Math.min(1, dt * 2.5);

    if (b.stateTimer <= 0) {
      b.currentAttack = getBossNextAttack(b);
      b.state = 'telegraph';
      b.stateTimer = b.phase === 3 ? 0.55 : 0.78;
    }
  } else if (b.state === 'telegraph') {
    b.armAngle = -0.9;
    if (b.stateTimer <= 0) {
      executeBossAttack(b);
      // Após executar o ataque, o boss abre o núcleo (ponto fraco) para o jogador contra-atacar!
      b.state = 'exposed';
      b.exposed = true;
      b.stateTimer = b.phase === 1 ? 2.5 : b.phase === 2 ? 2.2 : 2.6;
    }
  }
}

function executeBossAttack(b) {
  const p = game.player;
  const baseDmg = 16 + state.level * 3;

  if (b.currentAttack === 'slam') {
    // Socos no chão com ondas de choque para os dois lados (pular)
    triggerScreenShake(0.35, 5);
    playGameSfx('explosion');
    addFloatingText(b.x, b.y - 10, 'IMPACTO SÍSMICO!', '#FF3B2F');
    [-1, 1].forEach(dir => {
      game.shockwaves.push({
        x: b.x + b.w / 2 + dir * 18,
        y: 154,
        vx: dir * (125 + b.phase * 18),
        w: 12,
        h: 11,
        dmg: baseDmg,
        friendly: false,
        color: '#FF3B2F',
        life: 2.2
      });
    });
  } else if (b.currentAttack === 'missiles') {
    // Mísseis corporativos em arco
    playGameSfx('shoot');
    addFloatingText(b.x, b.y - 10, 'MÍSSEIS EXECUTIVOS!', '#FFC21A');
    const count = b.phase + 2;
    for (let i = 0; i < count; i++) {
      const targetX = game.stage.arenaStart + 35 + (i * 75) + (Math.random() * 30 - 15);
      const dx = targetX - (b.x + b.w / 2);
      game.suitcases.push({
        x: b.x + b.w / 2,
        y: b.y + 10,
        vx: dx * 0.75,
        vy: -165 - i * 18,
        gravity: 250,
        dmg: baseDmg,
        kind: 'explosive',
        bounces: 0,
        rot: 0,
        life: 3.5
      });
    }
  } else if (b.currentAttack === 'laser_sweep') {
    // Laser varrendo a arena (pular para plataforma alta ou agachar se alto)
    playGameSfx('skill');
    addFloatingText(b.x, b.y - 10, 'VARREDURA LASER!', '#00F0FF');
    const sweepY = Math.random() < 0.5 ? 142 : 124; // 142 exige pulo, 124 permite agachar no chão
    game.shockwaves.push({
      x: b.x,
      y: sweepY,
      vx: -175,
      w: 28,
      h: 6,
      dmg: baseDmg + 4,
      friendly: false,
      isLaserBeam: true,
      color: '#00F0FF',
      life: 1.9
    });
  } else if (b.currentAttack === 'mega_case') {
    // Maleta gigante explosiva
    playGameSfx('shoot');
    addFloatingText(b.x, b.y - 10, 'MALETA SUPREMA!', '#FFC21A');
    const dx = (p.x + p.w / 2) - (b.x + b.w / 2);
    game.suitcases.push({
      x: b.x + 8,
      y: b.y + 18,
      vx: Math.max(-145, Math.min(145, dx * 1.1)),
      vy: -130,
      gravity: 230,
      dmg: baseDmg + 6,
      kind: 'explosive',
      mega: true,
      bounces: 1,
      rot: 0,
      life: 3.5
    });
  } else if (b.currentAttack === 'summon_collapse') {
    // Fase 3 Fúria: invoca homens de terno e derruba plataformas laterais
    playGameSfx('boss_roar');
    addFloatingText(b.x, b.y - 14, 'REFORÇOS & COLAPSO!', '#FF3B2F');
    game.stage.platforms.forEach(pl => {
      if (pl.bossCollapsible && pl.fallingState === 'idle') {
        pl.fallingState = 'shake';
        pl.fallTimer = 0.65;
      }
    });
    const aliveInArena = game.stage.enemies.filter(e => e.hp > 0 && e.x >= game.stage.arenaStart).length;
    if (aliveInArena < 2) {
      const minionCfg = Math.random() < 0.5 ? ENEMY_TYPES.estagiario : ENEMY_TYPES.executivo;
      game.stage.enemies.push(createEnemyInstance(minionCfg, game.stage.arenaStart + 65, 110, 1 + (state.level - 1) * 0.12));
    }
  }
}

function damageBoss(amount, fromNetwork = false) {
  const b = game.stage.boss;
  if (b.defeated) return;

  // Se for cliente não-host em partida cooperativa, reporta o acerto ao Host (autoridade)
  if (!fromNetwork && game.isCoop && window.SB?.multiplayer && !window.SB.multiplayer.souHost()) {
    window.SB.multiplayer.transmitirAcertoClienteParaHost({
      targetType: 'boss',
      dmg: amount
    });
  }

  // Ponto fraco (núcleo/cabeça) só recebe dano total quando exposto!
  const actualDmg = b.exposed ? amount : Math.max(1, Math.round(amount * 0.15));
  b.hp = Math.max(0, b.hp - actualDmg);
  b.hitFlash = 0.12;
  spawnParticles(b.x + b.w / 2, b.y + b.h / 2, b.exposed ? '#7CFF3A' : '#8A96A3', b.exposed ? 8 : 3);
  addFloatingText(b.x + b.w / 2, b.y + 10, b.exposed ? `-${actualDmg} CRÍTICO!` : `-${actualDmg} BLINDADO`, b.exposed ? '#7CFF3A' : '#9FB0C8');
  playGameSfx('hit');

  if (b.hp <= 0) {
    b.defeated = true;
    b.active = false;
    $('#bossHud').classList.add('hidden');
    triggerScreenShake(0.6, 6);
    spawnParticles(b.x + b.w / 2, b.y + b.h / 2, '#7CFF3A', 32);
    spawnParticles(b.x + b.w / 2, b.y + b.h / 2, '#FFC21A', 28);
    finishCityMission(true);
  }
}

/* =====================================================================
   14. ONDAS DE CHOQUE, DANO, DROPS, ITENS E FIM DE PARTIDA
   ===================================================================== */
function updateShockwaves(dt) {
  const p = game.player;
  for (let i = game.shockwaves.length - 1; i >= 0; i--) {
    const sw = game.shockwaves[i];
    sw.x += sw.vx * dt;
    sw.life -= dt;

    if (sw.friendly) {
      game.stage.enemies.forEach(en => {
        if (en.hp > 0 && rectsOverlap(sw.x - sw.w / 2, sw.y - sw.h, sw.w, sw.h, en.x, en.y, en.w, en.h)) {
          damageEnemy(en, sw.dmg, Math.sign(sw.vx) * 80);
          sw.life = 0;
        }
      });
      const b = game.stage.boss;
      if (b.active && !b.defeated && rectsOverlap(sw.x - sw.w / 2, sw.y - sw.h, sw.w, sw.h, b.x, b.y, b.w, b.h)) {
        damageBoss(sw.dmg);
        sw.life = 0;
      }
    } else {
      const ph = p.crouching ? p.h - 5 : p.h;
      const py = p.crouching ? p.y + 5 : p.y;
      if (rectsOverlap(p.x, py, p.w, ph, sw.x - sw.w / 2, sw.y - sw.h, sw.w, sw.h)) {
        damagePlayer(sw.dmg);
        sw.life = 0;
      }
    }

    if (sw.life <= 0) game.shockwaves.splice(i, 1);
  }
}

function damageEnemy(en, amount, knockbackVx = 0, fromNetwork = false) {
  if (!fromNetwork && game.isCoop && window.SB?.multiplayer && !window.SB.multiplayer.souHost()) {
    const idx = game.stage.enemies.indexOf(en);
    if (idx >= 0) {
      window.SB.multiplayer.transmitirAcertoClienteParaHost({
        targetType: 'enemy',
        enemyIndex: idx,
        dmg: amount
      });
    }
  }
  en.hp -= amount;
  en.hitFlash = 0.14;
  en.vx = knockbackVx;
  spawnParticles(en.x + en.w / 2, en.y + en.h / 2, '#7CFF3A', 6);
  addFloatingText(en.x + 4, en.y - 4, `-${amount}`, '#FFC21A');
  playGameSfx('hit');

  if (en.hp <= 0) {
    game.enemiesKilled++;
    state.game.enemiesDefeated = (state.game.enemiesDefeated || 0) + 1;
    awardMatchXP(en.cfg.isMiniBoss ? GAME_CONFIG.XP_PER_ENEMY * 3 : GAME_CONFIG.XP_PER_ENEMY);
    spawnParticles(en.x + en.w / 2, en.y + en.h / 2, '#00F0FF', 12);

    // Drop de moedas + chance de item (incluindo chips de cura)
    game.stage.items.push({ id: uid(), kind: 'coin', x: en.x + 4, y: en.y + 4, vy: -80, collected: false });
    if (en.cfg.isMiniBoss || Math.random() < GAME_CONFIG.ENEMY_ITEM_DROP_CHANCE) {
      const dropPool = ['coin', 'heal_chip', 'heal_chip', 'shield', 'ammo', 'overdrive'];
      const kind = dropPool[Math.floor(Math.random() * dropPool.length)];
      game.stage.items.push({ id: uid(), kind, x: en.x + 8, y: en.y, vy: -95, collected: false });
    }
  }
}

function damageDrone(drone, amount) {
  drone.hp -= amount;
  spawnParticles(drone.x, drone.y, '#00F0FF', 5);
  playGameSfx('hit');
  if (drone.hp <= 0) {
    drone.alive = false;
    spawnParticles(drone.x, drone.y, '#FF3B2F', 12);
    playGameSfx('explosion');
    awardMatchXP(5);
    game.stage.items.push({ id: uid(), kind: 'coin', x: drone.x, y: drone.y, vy: -50, collected: false });
  }
}

function damagePlayer(amount, ignoreInvuln = false) {
  const p = game.player;
  if (game.over || (!ignoreInvuln && p.invulnTimer > 0)) return;

  p.invulnTimer = 0.85;
  game.tookDamage = true;
  triggerScreenShake(0.22, 3);
  playGameSfx('hurt');

  let rem = amount;
  if (p.shield > 0) {
    const absorbed = Math.min(p.shield, rem);
    p.shield -= absorbed;
    rem -= absorbed;
    addFloatingText(p.x, p.y - 8, `ESCUDO -${absorbed}`, '#00F0FF');
  }
  if (rem > 0) {
    p.hp = Math.max(0, p.hp - rem);
    spawnParticles(p.x + p.w / 2, p.y + p.h / 2, '#FF3B2F', 9);
    addFloatingText(p.x, p.y - 4, `-${rem} HP`, '#FF3B2F');
  }

  if (p.hp <= 0) {
    finishCityMission(false);
  }
}

function updateItems(dt) {
  const p = game.player;
  game.stage.items.forEach(it => {
    if (it.collected) return;
    if (it.vy !== 0) {
      it.vy += GAME_CONFIG.GRAVITY * 0.6 * dt;
      it.y += it.vy * dt;
      for (const plat of game.stage.platforms) {
        if (plat.fallingState !== 'fall' && it.x >= plat.x && it.x <= plat.x + plat.w && it.y + 6 >= plat.y && it.y <= plat.y + 8) {
          it.y = plat.y - 6;
          it.vy = 0;
          break;
        }
      }
    }

    if (rectsOverlap(p.x - 2, p.y - 2, p.w + 4, p.h + 4, it.x - 5, it.y - 5, 10, 10)) {
      it.collected = true;
      switch (it.kind) {
        case 'coin':
          game.coinsEarned += GAME_CONFIG.COIN_VALUE;
          state.game.coins = (state.game.coins || 0) + GAME_CONFIG.COIN_VALUE;
          addFloatingText(it.x, it.y - 6, `+${GAME_CONFIG.COIN_VALUE} 🪙`, '#FFC21A');
          playGameSfx('coin');
          break;
        case 'heal_chip':
        case 'medkit': {
          const heal = Math.round(p.maxHp * 0.32);
          p.hp = Math.min(p.maxHp, p.hp + heal);
          spawnParticles(it.x, it.y, '#7CFF3A', 10);
          addFloatingText(it.x, it.y - 6, `+${heal} HP (CHIP)`, '#7CFF3A');
          playGameSfx('item');
          break;
        }
        case 'shield':
          p.shield = Math.min(p.maxShield, p.shield + Math.round(p.maxHp * 0.35));
          addFloatingText(it.x, it.y - 6, '+ESCUDO NEON', '#00F0FF');
          playGameSfx('item');
          break;
        case 'ammo':
          p.specialAmmo += 10;
          addFloatingText(it.x, it.y - 6, '+10 MUNIÇÃO LASER', '#FFC21A');
          playGameSfx('item');
          break;
        case 'overdrive':
          p.overdriveTimer = 7.0;
          addFloatingText(it.x, it.y - 6, 'TURBO OVERDRIVE!', '#FF6FB5');
          playGameSfx('item');
          break;
      }
    }
  });
}

function awardMatchXP(rawAmount) {
  const rem = getRemainingDailyGameXP();
  const granted = Math.min(rem, rawAmount);
  if (granted > 0) {
    state.game.dailyXPDate = todayKey();
    state.game.dailyXP = (state.game.dailyXP || 0) + granted;
    game.rawXPEarned += granted;
  }
}

async function finishCityMission(victory) {
  if (game.over) return;
  game.over = true;
  game.won = victory;

  let rareLootMsg = '';
  let dropRaroKey = null;
  let dropRaroTipo = null;

  if (victory) {
    playGameSfx('victory');
    state.game.bossesDefeated = (state.game.bossesDefeated || 0) + 1;
    if (!game.tookDamage) state.game.flawlessClear = true;

    game.coinsEarned += GAME_CONFIG.BOSS_COIN_BONUS;
    state.game.coins = (state.game.coins || 0) + GAME_CONFIG.BOSS_COIN_BONUS;
    awardMatchXP(GAME_CONFIG.XP_BOSS_BONUS);

    // Chance de recompensa rara do Boss (cosmético de roupa, skin de arma ou moedas extras)
    if (Math.random() < GAME_CONFIG.BOSS_RARE_DROP_CHANCE) {
      const lockedOutfits = GAME_CONFIG.SHOP_OUTFITS.filter(o => !state.game.unlockedOutfits.includes(o.id));
      const lockedSkins   = GAME_CONFIG.SHOP_SKINS.filter(s => !state.game.unlockedWeaponSkins.includes(s.id));
      if (lockedOutfits.length && Math.random() < 0.5) {
        const picked = lockedOutfits[Math.floor(Math.random() * lockedOutfits.length)];
        state.game.unlockedOutfits.push(picked.id);
        dropRaroKey = picked.id;
        dropRaroTipo = 'outfit';
        rareLootMsg = `🎁 DROP RARO DO BOSS: ${picked.name.toUpperCase()} DESBLOQUEADO!`;
      } else if (lockedSkins.length) {
        const picked = lockedSkins[Math.floor(Math.random() * lockedSkins.length)];
        state.game.unlockedWeaponSkins.push(picked.id);
        state.game.equippedWeaponSkin = picked.id;
        dropRaroKey = picked.id;
        dropRaroTipo = 'weapon_skin';
        rareLootMsg = `🎁 DROP RARO DO BOSS: ${picked.name.toUpperCase()} EQUIPADA!`;
      } else {
        state.game.coins += 35;
        game.coinsEarned += 35;
        rareLootMsg = `🎁 BÔNUS DE MESTRE: +35 MOEDAS EXTRAS!`;
      }
    }
  } else {
    playGameSfx('gameover');
  }

  if (game.distance > (state.game.bestDistance || 0)) {
    state.game.bestDistance = game.distance;
  }

  const prevLevel = state.level;
  let levelsGained = 0;
  let unlockedAch = [];

  // Sincroniza resultado da partida via RPC segura no PostgreSQL (finalizar_partida ou finalizar_partida_coop)
  if (window.currentUser && window.SB?.jogo) {
    try {
      if (typeof setSyncStatus === 'function') setSyncStatus('syncing', 'SALVANDO PARTIDA...');
      let res = null;
      if (game.isCoop && window.SB?.multiplayer?.obterSalaAtiva()) {
        res = await window.SB.multiplayer.finalizarPartidaCoop({
          distancia: game.distance,
          inimigos_derrotados: game.enemiesKilled,
          boss_vencido: victory,
          sem_dano: !game.tookDamage,
          moedas_coletadas: game.coinsEarned,
          duracao: Math.max(10, Math.round(game.time))
        });
      } else {
        res = await window.SB.jogo.finalizarPartida({
          distancia: game.distance,
          inimigosDerrotados: game.enemiesKilled,
          bossVencido: victory,
          semDano: !game.tookDamage,
          moedasColetadas: game.coinsEarned,
          duracao: Math.max(1, Math.round(game.time)),
          dropRaroKey,
          dropRaroTipo
        });
      }
      if (res?.profile) {
        state.level = res.profile.level;
        state.xp = res.profile.xp_nivel_atual;
        state.totalXP = res.profile.xp_total;
        state.game.coins = res.profile.moedas;
        state.game.tickets = res.profile.fichas;
        state.game.dailyXP = res.profile.xp_jogo_hoje;
        state.game.dailyXPDate = todayKey();
        game.rawXPEarned = res.xp_ganho ?? game.rawXPEarned;
        levelsGained = res.levels_gained || 0;
      }
      if (Array.isArray(res?.unlocked_achievements)) {
        unlockedAch = res.unlocked_achievements;
        unlockedAch.forEach(code => {
          const def = ACHIEVEMENTS.find(a => a.id === code);
          if (def) {
            (def.daily ? state.achievements.daily : state.achievements.permanent)[code] = true;
            toast(`🏆 CONQUISTA: ${def.label}`);
          }
        });
      }
      if (typeof setSyncStatus === 'function') setSyncStatus('online');
    } catch (err) {
      if (typeof setSyncStatus === 'function') setSyncStatus('error');
      toast(err.message || 'ERRO AO SALVAR PARTIDA NO SERVIDOR.', true);
    }
  } else {
    levelsGained = game.rawXPEarned > 0 ? addXP(game.rawXPEarned) : 0;
    unlockedAch = evaluateAchievements();
  }

  saveState();
  renderAll();
  if (unlockedAch.length) renderAchievements(unlockedAch);

  // Exibe relatório no overlay do jogo
  const titleEl = $('#goTitle');
  titleEl.textContent = victory ? 'VITÓRIA! BOSS DERROTADO' : 'FIM DE MISSÃO — AGENTE ABATIDO';
  titleEl.classList.toggle('defeat', !victory);
  $('#goSub').textContent = victory
    ? `${game.stage.boss.name} FOI NEUTRALIZADO COM SUCESSO!`
    : 'RETORNE À BASE, APRIMORE SEU EQUIPAMENTO E TENTE NOVAMENTE.';

  const capReached = getRemainingDailyGameXP() <= 0;
  $('#goStats').innerHTML = `
    <div class="go-Stats-item"><small>DISTÂNCIA PERCORRIDA</small><b>${game.distance}m</b></div>
    <div class="go-Stats-item"><small>INIMIGOS DERROTADOS</small><b>${game.enemiesKilled} 💼</b></div>
    <div class="go-Stats-item"><small>MOEDAS GANHAS</small><b>+${game.coinsEarned} 🪙</b></div>
    <div class="go-Stats-item"><small>XP DE COMBATE${capReached ? ' (LIMITE DIÁRIO)' : ''}</small><b>+${game.rawXPEarned} ⚡</b></div>
  `;

  const lootEl = $('#goLoot');
  if (rareLootMsg) {
    lootEl.textContent = rareLootMsg;
    lootEl.classList.remove('hidden');
  } else {
    lootEl.classList.add('hidden');
  }

  const freePlay = areAllDailyTasksCompleted();
  const canReplay = freePlay || (state.game.tickets || 0) >= GAME_CONFIG.TICKET_COST;
  $('#goActions').innerHTML = `
    <button type="button" class="btn ghost" id="goExitBtn">↩ PAINEL PRINCIPAL</button>
    <button type="button" class="btn ghost" id="goShopBtn">🛒 LOJA &amp; UPGRADES</button>
    <button type="button" class="btn green" id="goReplayBtn" ${canReplay ? '' : 'disabled'}>
      ▶ JOGAR NOVAMENTE (${freePlay ? 'LIVRE ∞' : '1 🎫'})
    </button>
  `;

  $('#goExitBtn').onclick = () => closeCityMission(levelsGained > 0 ? prevLevel : null);
  $('#goShopBtn').onclick = () => { closeCityMission(null); openCityShop(); };
  $('#goReplayBtn').onclick = () => { if (canReplay) startCityMission(); };

  $('#gameOverlay').classList.remove('hidden');
}

function togglePauseGame() {
  if (!game || game.over) return;
  game.paused = !game.paused;
  if (game.paused) {
    $('#goTitle').textContent = 'MISSÃO PAUSADA';
    $('#goTitle').classList.remove('defeat');
    $('#goSub').textContent = 'OPERAÇÃO EM ESPERA';
    $('#goStats').innerHTML = `
      <div class="go-Stats-item"><small>DISTÂNCIA ATUAL</small><b>${game.distance}m</b></div>
      <div class="go-Stats-item"><small>INIMIGOS DERROTADOS</small><b>${game.enemiesKilled} 💼</b></div>
    `;
    $('#goLoot').classList.add('hidden');
    $('#goActions').innerHTML = `
      <button type="button" class="btn ghost" id="goAbortBtn">✕ ENCERRAR E SALVAR</button>
      <button type="button" class="btn green" id="goResumeBtn">▶ CONTINUAR</button>
    `;
    $('#goAbortBtn').onclick = () => finishCityMission(false);
    $('#goResumeBtn').onclick = () => togglePauseGame();
    $('#gameOverlay').classList.remove('hidden');
  } else {
    $('#gameOverlay').classList.add('hidden');
  }
}

function closeCityMission(levelUpPrevLevel = null) {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (game) {
    if (game.isCoop && window.SB?.multiplayer) {
      window.SB.multiplayer.sairDaSala();
    }
    game.running = false;
  }
  if (window.currentUser && window.SB?.amigos) {
    window.SB.amigos.atualizarStatusPresence(window.currentUser.id, 'online');
  }
  $('#gameScreen').classList.remove('open');
  document.body.classList.remove('no-scroll');
  releaseAllTouchKeys();
  exitGameFullscreen();
  renderAll();
  if (levelUpPrevLevel !== null) {
    setTimeout(() => showLevelUp(levelUpPrevLevel), 350);
  }
}

/* =====================================================================
   15. RENDERIZAÇÃO PIXEL ART 16-BIT (320x180) EM CAMADAS PARALLAX
   ===================================================================== */
function renderGameCanvas() {
  const cv = $('#gameCanvas');
  if (!cv || !game) return;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  const W = GAME_CONFIG.WIDTH;
  const H = GAME_CONFIG.HEIGHT;
  const camX = Math.round(game.cameraX);
  const camY = Math.round(game.cameraY || 0);
  const st = game.stage;
  const p = game.player;

  ctx.save();
  if (game.shakeTime > 0) {
    const sx = Math.round((Math.random() - 0.5) * game.shakeMag * 2);
    const sy = Math.round((Math.random() - 0.5) * game.shakeMag * 2);
    ctx.translate(sx, sy);
  }

  // ---- FUNDO FIXO EM ESTILO ART DECO ANIMADO ----
  renderArtDecoBackground(ctx, W, H, st.weather, game.time);

  // ---- MUNDO DO JOGO (deslocado verticalmente por -camY para manter o personagem centralizado) ----
  ctx.save();
  ctx.translate(0, -camY);

  // ---- AMBIENTAÇÃO DE SEGMENTOS DE ESCRITÓRIO (Paredes Internas Corporativas) ----
  st.segments.forEach(seg => {
    if (seg.endX < camX || seg.startX > camX + W) return;
    if (seg.ceiling) {
      const sx = Math.max(0, seg.startX - camX);
      const ex = Math.min(W, seg.endX - camX);
      ctx.fillStyle = 'rgba(8, 22, 34, 0.88)';
      ctx.fillRect(sx, 18, ex - sx, 138);
      // Teto neon e divisórias corporativas
      ctx.fillStyle = '#00F0FF';
      ctx.fillRect(sx, 18, ex - sx, 2);
      for (let lx = seg.startX + 24; lx < seg.endX - 20; lx += 56) {
        const rx = lx - camX;
        if (rx >= -20 && rx <= W + 20) {
          ctx.fillStyle = '#7CFF3A';
          ctx.fillRect(rx, 20, 22, 2);
          ctx.fillStyle = 'rgba(0, 240, 255, 0.06)';
          ctx.fillRect(rx - 4, 22, 30, 134);
        }
      }
    }
  });

  // ---- ELEMENTOS DE CENÁRIO (Antenas, Servidores, Dutos, Vento, Tirolesas, Lasers, Portas) ----
  st.features.forEach(f => {
    const fx = Math.round((f.x ?? f.x1 ?? 0) - camX);
    if (fx < -120 || fx > W + 120) return;

    if (f.kind === 'antenna') {
      ctx.fillStyle = '#1FD1B0';
      ctx.fillRect(fx, f.y - 34, 2, 34);
      ctx.fillRect(fx - 5, f.y - 24, 12, 1);
      ctx.fillStyle = (Math.floor(game.time * 4) % 2 === 0) ? '#FF3B2F' : '#FFC21A';
      ctx.fillRect(fx - 1, f.y - 36, 4, 3);
    } else if (f.kind === 'holo_ad') {
      ctx.fillStyle = 'rgba(0, 240, 255, 0.18)';
      ctx.fillRect(fx, f.y - 36, 46, 22);
      ctx.strokeStyle = '#00F0FF';
      ctx.strokeRect(fx, f.y - 36, 46, 22);
      ctx.fillStyle = '#7CFF3A';
      ctx.fillRect(fx + 4, f.y - 28, 38, 3);
      ctx.fillStyle = '#00F0FF';
      ctx.fillRect(fx + 8, f.y - 21, 26, 2);
    } else if (f.kind === 'server_rack') {
      ctx.fillStyle = '#102430';
      ctx.fillRect(fx, f.y - 34, 18, 34);
      ctx.strokeStyle = '#1FD1B0';
      ctx.strokeRect(fx, f.y - 34, 18, 34);
      for (let r = 0; r < 5; r++) {
        ctx.fillStyle = ((Math.floor(game.time * 6) + r) % 2 === 0) ? '#7CFF3A' : '#00F0FF';
        ctx.fillRect(fx + 3, f.y - 30 + r * 6, 4, 2);
        ctx.fillStyle = '#FFC21A';
        ctx.fillRect(fx + 10, f.y - 30 + r * 6, 5, 2);
      }
    } else if (f.kind === 'vent_duct') {
      ctx.fillStyle = '#1B3340';
      ctx.fillRect(fx, f.y, f.w, 10);
      ctx.strokeStyle = '#00F0FF';
      ctx.strokeRect(fx, f.y, f.w, 10);
    } else if (f.kind === 'wind') {
      ctx.fillStyle = 'rgba(124, 255, 58, 0.12)';
      ctx.fillRect(fx, f.y, f.w, f.h);
      ctx.fillStyle = '#7CFF3A';
      for (let w = 0; w < 4; w++) {
        const wy = f.y + ((f.h - ((game.time * 90 + w * 19) % f.h)));
        ctx.fillRect(fx + 4 + (w * 5) % (f.w - 6), wy, 2, 7);
      }
    } else if (f.kind === 'zipline') {
      const x1 = Math.round(f.x1 - camX), x2 = Math.round(f.x2 - camX);
      ctx.strokeStyle = '#FFC21A';
      ctx.beginPath();
      ctx.moveTo(x1, f.y1);
      ctx.lineTo(x2, f.y2);
      ctx.stroke();
      ctx.fillStyle = '#00F0FF';
      ctx.fillRect(x1 - 2, f.y1 - 2, 5, 5);
      ctx.fillRect(x2 - 2, f.y2 - 2, 5, 5);
    } else if (f.kind === 'security_door') {
      if (!f.unlocked) {
        ctx.fillStyle = 'rgba(255, 59, 47, 0.78)';
        ctx.fillRect(fx, f.y, 6, f.h);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(fx + 2, f.y + 4, 2, f.h - 8);
        // Cartão de acesso brilhante
        const kx = Math.round(f.keyX - camX), ky = Math.round(f.keyY + Math.sin(game.time * 5) * 2);
        ctx.fillStyle = '#FFC21A';
        ctx.fillRect(kx - 4, ky - 3, 8, 6);
        ctx.fillStyle = '#00F0FF';
        ctx.fillRect(kx - 2, ky - 1, 4, 2);
      } else {
        ctx.fillStyle = 'rgba(124, 255, 58, 0.25)';
        ctx.fillRect(fx, f.y, 4, 6);
      }
    } else if (f.kind === 'laser') {
      ctx.fillStyle = '#2A3F4D';
      ctx.fillRect(fx - 3, f.y, 6, 4);
      if (f.isOn) {
        ctx.fillStyle = '#FF3B2F';
        ctx.fillRect(fx - 2, f.y + 4, 4, f.h - 4);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(fx - 1, f.y + 4, 2, f.h - 4);
      } else if (f.isWarning && Math.floor(game.time * 16) % 2 === 0) {
        ctx.fillStyle = 'rgba(255, 59, 47, 0.45)';
        ctx.fillRect(fx - 1, f.y + 4, 2, f.h - 4);
      }
    } else if (f.kind === 'drone' && f.alive) {
      const dy = Math.round(f.y + Math.sin(game.time * 6) * 2);
      ctx.fillStyle = '#1B2838';
      ctx.fillRect(fx - 6, dy - 4, 12, 7);
      ctx.fillStyle = '#00F0FF';
      ctx.fillRect(fx - 8, dy - 6, 5, 2);
      ctx.fillRect(fx + 3, dy - 6, 5, 2);
      ctx.fillStyle = '#FF3B2F';
      ctx.fillRect(fx - 2, dy - 2, 4, 3);
    }
  });

  // ---- PLATAFORMAS ----
  st.platforms.forEach(plat => {
    if (plat.fallingState === 'fall' && plat.y > H) return;
    let px0 = Math.round(plat.x - camX);
    let py0 = Math.round(plat.y);
    if (px0 + plat.w < 0 || px0 > W) return;

    if (plat.fallingState === 'shake') {
      px0 += (Math.floor(game.time * 30) % 2 === 0) ? -1 : 1;
    }

    if (plat.style === 'building' || plat.style === 'office_floor') {
      ctx.fillStyle = plat.style === 'office_floor' ? '#102A38' : '#0B1D29';
      ctx.fillRect(px0, py0, plat.w, plat.h);
      ctx.fillStyle = '#00F0FF';
      ctx.fillRect(px0, py0, plat.w, 2);
      ctx.fillStyle = '#7CFF3A';
      for (let wx = px0 + 6; wx < px0 + plat.w - 8; wx += 14) {
        ctx.fillRect(wx, py0 + 6, 6, 3);
      }
    } else if (plat.style === 'holo_bridge') {
      ctx.fillStyle = 'rgba(0, 240, 255, 0.45)';
      ctx.fillRect(px0, py0, plat.w, plat.h);
      ctx.fillStyle = '#7CFF3A';
      ctx.fillRect(px0, py0, plat.w, 2);
    } else if (plat.style === 'conveyor') {
      ctx.fillStyle = '#1D3542';
      ctx.fillRect(px0, py0, plat.w, plat.h);
      ctx.fillStyle = '#FFC21A';
      const dir = Math.sign(plat.vx || 1);
      const shift = Math.floor(game.time * 24 * dir) % 8;
      for (let cx = px0 + 4; cx < px0 + plat.w - 4; cx += 8) {
        ctx.fillRect(cx + shift, py0 + 2, 3, 2);
      }
    } else if (plat.style === 'falling') {
      ctx.fillStyle = '#3D261E';
      ctx.fillRect(px0, py0, plat.w, plat.h);
      ctx.fillStyle = '#FF3B2F';
      ctx.fillRect(px0, py0, plat.w, 2);
    } else {
      // Mesas, cubículos, elevadores, letreiros
      ctx.fillStyle = '#163847';
      ctx.fillRect(px0, py0, plat.w, plat.h);
      ctx.fillStyle = '#1FD1B0';
      ctx.fillRect(px0, py0, plat.w, 2);
    }
  });

  // ---- ITENS COLETÁVEIS ----
  st.items.forEach(it => {
    if (it.collected) return;
    const ix = Math.round(it.x - camX);
    const iy = Math.round(it.y + Math.sin(game.time * 5 + it.x) * 2);
    if (ix < -12 || ix > W + 12) return;

    if (it.kind === 'coin') {
      ctx.fillStyle = '#FFC21A';
      ctx.fillRect(ix - 3, iy - 3, 6, 6);
      ctx.fillStyle = '#FFF8D6';
      ctx.fillRect(ix - 1, iy - 2, 2, 4);
    } else if (it.kind === 'heal_chip' || it.kind === 'medkit') {
      // Chip cibernético de cura (placa verde-neon com pinos dourados e cruz brilhante)
      ctx.fillStyle = '#FFC21A';
      ctx.fillRect(ix - 5, iy - 3, 1, 2);
      ctx.fillRect(ix - 5, iy + 1, 1, 2);
      ctx.fillRect(ix + 4, iy - 3, 1, 2);
      ctx.fillRect(ix + 4, iy + 1, 1, 2);
      ctx.fillStyle = '#081E26';
      ctx.fillRect(ix - 4, iy - 4, 8, 8);
      ctx.fillStyle = '#7CFF3A';
      ctx.fillRect(ix - 3, iy - 3, 6, 6);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(ix - 1, iy - 2, 2, 4);
      ctx.fillRect(ix - 2, iy - 1, 4, 2);
    } else if (it.kind === 'shield') {
      ctx.fillStyle = '#00F0FF';
      ctx.fillRect(ix - 4, iy - 4, 8, 8);
      ctx.fillStyle = '#0B1624';
      ctx.fillRect(ix - 2, iy - 2, 4, 4);
    } else if (it.kind === 'ammo') {
      ctx.fillStyle = '#FFC21A';
      ctx.fillRect(ix - 4, iy - 3, 8, 6);
      ctx.fillStyle = '#FF3B2F';
      ctx.fillRect(ix - 2, iy - 1, 4, 2);
    } else if (it.kind === 'overdrive') {
      ctx.fillStyle = '#FF6FB5';
      ctx.fillRect(ix - 4, iy - 4, 8, 8);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(ix - 1, iy - 3, 2, 6);
    }
  });

  // ---- INIMIGOS (Homens de Terno) ----
  st.enemies.forEach(en => {
    if (en.hp <= 0) return;
    const ex = Math.round(en.x - camX);
    const ey = Math.round(en.y);
    if (ex < -24 || ex > W + 24) return;

    // Mira a laser do Contador Sniper
    if (en.aimLaser) {
      ctx.strokeStyle = (Math.floor(game.time * 20) % 2 === 0) ? '#FF3B2F' : '#FFC21A';
      ctx.beginPath();
      ctx.moveTo(en.aimLaser.x1 - camX, en.aimLaser.y1);
      ctx.lineTo(en.aimLaser.x2 - camX, en.aimLaser.y2);
      ctx.stroke();
    }

    const animStep = Math.abs(en.vx) > 5 ? (Math.floor(game.time * 8) % 2 + 1) : 0;
    const spr = getEnemySprite(en.typeId, animStep);
    ctx.save();
    ctx.translate(ex + en.w / 2, ey + en.h / 2);
    if (en.facing < 0) ctx.scale(-1, 1);
    if (en.hitFlash > 0) ctx.filter = 'brightness(2.5)';
    ctx.drawImage(spr, -9, -9);
    ctx.restore();

    // Telegrafia visual antes do ataque (ícone "!" piscando)
    if (en.aiState === 'telegraph') {
      ctx.fillStyle = (Math.floor(game.time * 16) % 2 === 0) ? '#FF3B2F' : '#FFC21A';
      ctx.fillRect(ex + 5, ey - 9, 3, 5);
      ctx.fillRect(ex + 5, ey - 3, 3, 2);
    }

    // Mini barra de vida do inimigo
    if (en.hp < en.maxHp || en.cfg.isMiniBoss) {
      const bw = en.cfg.isMiniBoss ? 22 : 14;
      ctx.fillStyle = '#08101A';
      ctx.fillRect(ex - 1, ey - 5, bw, 3);
      ctx.fillStyle = en.cfg.isMiniBoss ? '#FFC21A' : '#FF3B2F';
      ctx.fillRect(ex - 1, ey - 5, Math.round((en.hp / en.maxHp) * bw), 3);
    }
  });

  // ---- BOSS: ROBÔ GIGANTE (Cabeça, Torso, Braços articulados e Núcleo brilhante) ----
  const b = st.boss;
  if (b.active && !b.defeated) {
    renderGiantRobotBoss(ctx, b, camX);
  }

  // ---- JOGADOR (Sprite do Perfil 16x16 + Efeito de Ataque da Arma) ----
  const pxPos = Math.round(p.x - camX);
  const pyPos = Math.round(p.y + (p.crouching ? 3 : 0));
  const pSpr = p.animFrame === 1 ? spriteCache.playerRun1 : p.animFrame === 2 ? spriteCache.playerRun2 : spriteCache.playerIdle;

  if (pSpr && (p.invulnTimer <= 0 || Math.floor(game.time * 20) % 2 === 0)) {
    ctx.save();
    ctx.translate(pxPos + p.w / 2, pyPos + p.h / 2);
    if (p.facing < 0) ctx.scale(-1, 1);
    if (p.crouching) ctx.scale(1.08, 0.78);
    ctx.drawImage(pSpr, -9, -10);

    // Arco de corte corpo a corpo / brilho da arma ao atacar
    if (p.atkVisualTimer > 0) {
      ctx.fillStyle = game.weaponPalette?.W || p.combat.color;
      ctx.fillRect(5, -6, 12, 3);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(8, -4, 10, 8);
    }
    ctx.restore();

    // Escudo holográfico se ativo
    if (p.shield > 0) {
      ctx.strokeStyle = '#00F0FF';
      ctx.strokeRect(pxPos - 2, pyPos - 2, p.w + 4, p.h + 3);
    }
  }

  // ---- JOGADORES REMOTOS (SALA MULTIPLAYER COOPERATIVA COM INTERPOLAÇÃO) ----
  if (game.isCoop && window.SB?.multiplayer) {
    const remotes = window.SB.multiplayer.obterJogadoresRemotos();
    Object.values(remotes).forEach(rp => {
      const rx = Math.round(rp.x - camX);
      const ry = Math.round(rp.y + (rp.crouching ? 3 : 0));
      if (rx < -32 || rx > W + 32) return;

      if (!rp.spriteIdle && typeof composeSprite === 'function') {
        const baseG = composeSprite(rp.character, { level: rp.level || 1 });
        rp.spriteIdle = makeSpriteCanvas(baseG);
        rp.spriteRun1 = makeSpriteCanvas(shiftLegsGrid(baseG, 1));
        rp.spriteRun2 = makeSpriteCanvas(shiftLegsGrid(baseG, 2));
      }

      const rSpr = rp.animFrame === 1 ? rp.spriteRun1 : rp.animFrame === 2 ? rp.spriteRun2 : rp.spriteIdle;
      if (rSpr) {
        ctx.save();
        ctx.translate(rx + 6, ry + 8);
        if (rp.facing < 0) ctx.scale(-1, 1);
        if (rp.crouching) ctx.scale(1.08, 0.78);
        ctx.drawImage(rSpr, -9, -10);
        if (rp.atkVisualTimer > 0) {
          ctx.fillStyle = '#00F0FF';
          ctx.fillRect(5, -6, 12, 3);
        }
        ctx.restore();
      }

      // Etiqueta neon acima do aliado cooperativo
      ctx.font = 'bold 6px monospace';
      ctx.fillStyle = '#08101A';
      ctx.fillText(rp.nome.slice(0, 10), rx - 2, ry - 6);
      ctx.fillStyle = '#00F0FF';
      ctx.fillText(rp.nome.slice(0, 10), rx - 3, ry - 7);

      // Mini barra de HP do aliado
      const hpRatio = Math.max(0, Math.min(1, (rp.hp || 100) / (rp.maxHp || 100)));
      ctx.fillStyle = '#08101A';
      ctx.fillRect(rx - 1, ry - 4, 14, 2);
      ctx.fillStyle = '#7CFF3A';
      ctx.fillRect(rx - 1, ry - 4, Math.round(14 * hpRatio), 2);
    });
  }

  // ---- PROJÉTEIS DO JOGADOR & MALETAS INIMIGAS ----
  game.projectiles.forEach(pr => {
    const x = Math.round(pr.x - camX), y = Math.round(pr.y);
    ctx.fillStyle = pr.color || '#7CFF3A';
    ctx.fillRect(x - pr.r, y - pr.r, pr.r * 2, pr.r * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x - 1, y - 1, 2, 2);
  });

  game.suitcases.forEach(sc => {
    const x = Math.round(sc.x - camX), y = Math.round(sc.y);
    const w = sc.mega ? 14 : 8, h = sc.mega ? 10 : 6;
    ctx.fillStyle = sc.kind === 'explosive' ? '#D0342C' : sc.kind === 'bouncy' ? '#00B8D4' : sc.kind === 'paper' ? '#E8F0F0' : '#6E4726';
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    ctx.fillStyle = '#FFC21A';
    ctx.fillRect(x - 2, y - h / 2 - 2, 4, 2);
  });

  // ---- ONDAS DE CHOQUE E LASERS DO BOSS ----
  game.shockwaves.forEach(sw => {
    const x = Math.round(sw.x - camX), y = Math.round(sw.y);
    ctx.fillStyle = sw.color;
    ctx.fillRect(x - sw.w / 2, y - sw.h, sw.w, sw.h);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x - sw.w / 4, y - sw.h + 2, sw.w / 2, sw.h - 4);
  });

  // ---- PARTÍCULAS E TEXTOS FLUTUANTES ----
  game.particles.forEach(pt => {
    ctx.fillStyle = pt.color;
    ctx.fillRect(Math.round(pt.x - camX), Math.round(pt.y), pt.size, pt.size);
  });

  ctx.font = 'bold 7px monospace';
  game.floatingTexts.forEach(ft => {
    ctx.fillStyle = '#08101A';
    ctx.fillText(ft.text, Math.round(ft.x - camX) + 1, Math.round(ft.y) + 1);
    ctx.fillStyle = ft.color;
    ctx.fillText(ft.text, Math.round(ft.x - camX), Math.round(ft.y));
  });

  ctx.restore(); // Fecha translação vertical (-camY) do mundo

  // ---- EFEITO DE CLIMA (Chuva Neon / Neblina Verde) ----
  if (st.weather.id === 'rain') {
    ctx.fillStyle = 'rgba(0, 240, 255, 0.55)';
    game.bgRain.forEach(r => {
      r.y = (r.y + r.spd * GAME_CONFIG.FIXED_DT) % H;
      r.x = (r.x - 25 * GAME_CONFIG.FIXED_DT + W) % W;
      ctx.fillRect(Math.round(r.x), Math.round(r.y), 1, r.len);
    });
  } else if (st.weather.id === 'fog') {
    ctx.fillStyle = 'rgba(124, 255, 58, 0.08)';
    ctx.fillRect(0, H - 55, W, 55);
  }

  ctx.restore();
}

/**
 * Renderiza o fundo FIXO (sem deslocamento de câmera) em estilo ART DECO ANIMADO,
 * inspirado nas referências: torre escalonada iluminada tipo Chrysler, lua cheia com halo,
 * holofotes varrendo o céu, edifícios monolíticos chanfrados, cúpula abobadada com caixa d'água
 * e baía/píer noturno com reflexos dourados e ciano na água.
 */
function renderArtDecoBackground(ctx, W, H, weather, t) {
  const waterY = 148;

  // 1. Céu dramático em degradê (petróleo profundo -> verde-azulado Art Deco)
  const sky = ctx.createLinearGradient(0, 0, 0, waterY);
  sky.addColorStop(0, '#040C14');
  sky.addColorStop(0.45, weather?.skyTop || '#081E2B');
  sky.addColorStop(0.85, weather?.skyBot || '#12464E');
  sky.addColorStop(1, '#1F6E58');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, waterY);

  // 2. Feixes de holofote Art Deco varrendo o céu lentamente
  ctx.save();
  const beamConfigs = [
    { x: 58,  y: 95, baseAng: -1.15, spd: 0.55, amp: 0.28, col: 'rgba(0, 240, 255, 0.08)' },
    { x: 132, y: 80, baseAng: -1.55, spd: 0.42, amp: 0.22, col: 'rgba(255, 210, 120, 0.09)' },
    { x: 256, y: 88, baseAng: -1.95, spd: 0.48, amp: 0.25, col: 'rgba(124, 255, 58, 0.07)' }
  ];
  beamConfigs.forEach(bm => {
    const ang = bm.baseAng + Math.sin(t * bm.spd) * bm.amp;
    const len = 150;
    const spread = 0.14;
    ctx.fillStyle = bm.col;
    ctx.beginPath();
    ctx.moveTo(bm.x, bm.y);
    ctx.lineTo(bm.x + Math.cos(ang - spread) * len, bm.y + Math.sin(ang - spread) * len);
    ctx.lineTo(bm.x + Math.cos(ang + spread) * len, bm.y + Math.sin(ang + spread) * len);
    ctx.closePath();
    ctx.fill();
  });
  ctx.restore();

  // 3. Lua cheia brilhante com halo suave (como na 2ª imagem de referência)
  const moonX = 232, moonY = 26;
  const pulse = Math.sin(t * 2.2) * 1.5;
  const moonGlow = ctx.createRadialGradient(moonX, moonY, 4, moonX, moonY, 26 + pulse);
  moonGlow.addColorStop(0, 'rgba(255, 252, 230, 0.95)');
  moonGlow.addColorStop(0.38, 'rgba(255, 230, 165, 0.38)');
  moonGlow.addColorStop(0.72, 'rgba(0, 240, 255, 0.12)');
  moonGlow.addColorStop(1, 'rgba(0, 240, 255, 0)');
  ctx.fillStyle = moonGlow;
  ctx.beginPath();
  ctx.arc(moonX, moonY, 28, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#FFFDF2';
  ctx.beginPath();
  ctx.arc(moonX, moonY, 10, 0, Math.PI * 2);
  ctx.fill();

  // Faixas sutis de nuvens noturnas estilizadas
  ctx.fillStyle = 'rgba(14, 42, 56, 0.45)';
  const cloudShift = Math.round(Math.sin(t * 0.25) * 6);
  ctx.fillRect(14 + cloudShift, 42, 76, 3);
  ctx.fillRect(150 - cloudShift, 34, 62, 2);

  // 4. Silhueta distante de horizonte Art Deco (camada de fundo fixa)
  const bgSilhouettes = [
    [0, 82, 22], [20, 72, 18], [36, 88, 16], [76, 68, 22],
    [96, 78, 18], [148, 70, 24], [170, 62, 18], [244, 74, 22], [264, 66, 20]
  ];
  ctx.fillStyle = '#05131D';
  bgSilhouettes.forEach(([bx, by, bw]) => {
    ctx.fillRect(bx, by, bw, waterY - by);
    // Topo escalonado (ziggurat Art Deco)
    ctx.fillRect(bx + 3, by - 5, bw - 6, 5);
    ctx.fillRect(bx + Math.floor(bw / 2) - 1, by - 11, 2, 6);
  });

  // 5. TORRE ART DECO ESQUERDA (estilo Batman TAS — degraus chanfrados com iluminação lateral)
  const drawSteppedSkyscraper = (cx, topY, baseW) => {
    // Pináculo / agulha
    ctx.fillStyle = '#5898A8';
    ctx.fillRect(cx - 1, topY - 16, 2, 16);
    // Degraus piramidais com face sombreada à esquerda e face iluminada à direita
    const tiers = [
      { y: topY,      w: 8,  h: 9 },
      { y: topY + 9,  w: 14, h: 11 },
      { y: topY + 20, w: 20, h: 14 },
      { y: topY + 34, w: baseW, h: waterY - (topY + 34) }
    ];
    tiers.forEach(tr => {
      const lx = cx - Math.floor(tr.w / 2);
      const half = Math.floor(tr.w / 2);
      // Face escura
      ctx.fillStyle = '#07141E';
      ctx.fillRect(lx, tr.y, half, tr.h);
      // Face iluminada pelo luar/neon
      ctx.fillStyle = '#183C4E';
      ctx.fillRect(lx + half, tr.y, tr.w - half, tr.h);
      // Friso horizontal Art Deco no topo de cada degrau
      ctx.fillStyle = '#2E6F85';
      ctx.fillRect(lx, tr.y, tr.w, 1);
    });
  };
  drawSteppedSkyscraper(54, 26, 28);

  // 6. TORRE CHRYSLER ILUMINADA (centro-esquerda — coroa Art Deco radiante com arcos dourados)
  const chX = 128, chTop = 20;
  // Agulha brilhante
  ctx.fillStyle = '#FFF4C2';
  ctx.fillRect(chX - 1, chTop - 13, 2, 13);
  // Coroa em arcos sobrepostos iluminados (pulsando suavemente)
  const crownGlow = 0.78 + Math.sin(t * 3.2) * 0.15;
  const crownSteps = [
    { dy: 0,  w: 6,  h: 5 },
    { dy: 5,  w: 10, h: 5 },
    { dy: 10, w: 14, h: 6 },
    { dy: 16, w: 18, h: 6 },
    { dy: 22, w: 22, h: 7 }
  ];
  crownSteps.forEach(cs => {
    const lx = chX - cs.w / 2;
    const ly = chTop + cs.dy;
    ctx.fillStyle = '#142634';
    ctx.fillRect(lx - 1, ly, cs.w + 2, cs.h);
    ctx.fillStyle = `rgba(255, 232, 160, ${crownGlow})`;
    ctx.fillRect(lx, ly + 1, cs.w, cs.h - 2);
    // Detalhes triangulares Art Deco dentro da coroa
    ctx.fillStyle = '#FFFFFF';
    for (let tx = lx + 2; tx < lx + cs.w - 2; tx += 4) {
      ctx.fillRect(tx, ly + 2, 2, 2);
    }
  });
  // Corpo vertical da torre Chrysler
  const chBodyY = chTop + 29;
  ctx.fillStyle = '#091824';
  ctx.fillRect(chX - 12, chBodyY, 24, waterY - chBodyY);
  ctx.fillStyle = '#244E63';
  ctx.fillRect(chX + 10, chBodyY, 2, waterY - chBodyY);
  // Colunas verticais de janelas douradas
  for (let wy = chBodyY + 4; wy < waterY - 8; wy += 4) {
    for (let col = -8; col <= 6; col += 4) {
      const flicker = ((wy * 7 + col * 3 + Math.floor(t * 1.5)) % 11) !== 0;
      if (flicker) {
        ctx.fillStyle = (col === 0) ? '#FFF2B2' : '#E8AC42';
        ctx.fillRect(chX + col, wy, 2, 2);
      }
    }
  }

  // 7. EDIFÍCIOS MÉDIOS ART DECO (com telhado abobadado, caixa d'água e telhados em perspectiva)
  // Prédio com abóbada Art Deco e caixa d'água (centro, referência 2)
  ctx.fillStyle = '#0B1D2B';
  ctx.fillRect(148, 72, 34, waterY - 72);
  ctx.fillStyle = '#1D4659';
  ctx.beginPath();
  ctx.arc(165, 72, 14, Math.PI, 0);
  ctx.fill();
  // Caixa d'água clássica no telhado ao lado
  ctx.fillStyle = '#08141E';
  ctx.fillRect(174, 62, 8, 7);
  ctx.fillRect(175, 69, 1, 4);
  ctx.fillRect(180, 69, 1, 4);
  ctx.fillStyle = '#27596E';
  ctx.fillRect(174, 61, 8, 2);

  // 8. GRANDE BLOCO CORPORATIVO MODERNISTA / ART DECO (direita — fachada de vidro em faixas)
  const unX = 186, unY = 34, unW = 64, unH = waterY - unY;
  ctx.fillStyle = '#071520';
  ctx.fillRect(unX, unY, unW, unH);
  // Moldura superior iluminada e cornija
  ctx.fillStyle = '#24586B';
  ctx.fillRect(unX, unY, unW, 3);
  ctx.fillRect(unX, unY, 2, unH);
  ctx.fillRect(unX + unW - 2, unY, 2, unH);
  // Grade densa de janelas horizontais (quentes e ciano, com cintilação viva)
  for (let ry = unY + 6; ry < waterY - 12; ry += 5) {
    let segX = unX + 4;
    while (segX < unX + unW - 6) {
      const wLen = 4 + ((ry * 3 + segX) % 7);
      const isLit = ((ry + segX + Math.floor(t * 0.8)) % 4) !== 0;
      if (isLit) {
        const cPick = (ry + segX) % 9;
        ctx.fillStyle = cPick === 0 ? '#00F0FF' : cPick < 4 ? '#FFF0B8' : '#D99B38';
        ctx.fillRect(segX, ry, Math.min(wLen, unX + unW - 4 - segX), 2);
      }
      segX += wLen + 3;
    }
  }

  // 9. TORRE MONOLÍTICA ANGULADA NA EXTREMA DIREITA (com perspectiva dramática tipo 2ª imagem)
  ctx.fillStyle = '#1E3D42'; // Parede lateral iluminada
  ctx.beginPath();
  ctx.moveTo(274, 16);
  ctx.lineTo(292, 6);
  ctx.lineTo(292, waterY);
  ctx.lineTo(274, waterY);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#060F17'; // Face frontal escura
  ctx.fillRect(292, 6, W - 292, waterY - 6);
  // Duas fileiras de janelas no topo da face lateral (idêntico à pintura Art Deco)
  ctx.fillStyle = '#FFF9D6';
  for (let i = 0; i < 5; i++) {
    const wx = 277 + i * 3;
    const wy = 22 - i * 1;
    ctx.fillRect(wx, wy, 2, 3);
    ctx.fillRect(wx, wy + 5, 2, 3);
  }

  // 10. PRÉDIOS EM PRIMEIRO PLANO ESQUERDO E TELHADOS CHANFRADOS (perspectiva dramática)
  ctx.fillStyle = '#091824';
  ctx.fillRect(6, 54, 34, waterY - 54);
  ctx.fillStyle = '#214E61';
  ctx.fillRect(6, 54, 34, 2);
  for (let wy = 60; wy < waterY - 14; wy += 6) {
    for (let wx = 10; wx < 36; wx += 6) {
      if ((wx + wy) % 3 !== 0) {
        ctx.fillStyle = '#F5B942';
        ctx.fillRect(wx, wy, 2, 3);
      }
    }
  }

  // 11. ORLA ILUMINADA, TERMINAL ART DECO E LUZES COSTEIRAS
  ctx.fillStyle = '#0D2230';
  ctx.fillRect(0, waterY - 7, W, 7);
  ctx.fillStyle = '#FFE49E';
  for (let lx = 8; lx < W; lx += 12) {
    ctx.fillRect(lx, waterY - 3, 6, 2);
  }
  ctx.fillStyle = '#FF9E2C';
  ctx.fillRect(0, waterY - 1, W, 1);

  // 12. ÁGUA NOTURNA E REFLEXOS CINTILANTES ANIMADOS (como na 1ª imagem)
  const waterGrad = ctx.createLinearGradient(0, waterY, 0, H);
  waterGrad.addColorStop(0, '#071722');
  waterGrad.addColorStop(1, '#030A10');
  ctx.fillStyle = waterGrad;
  ctx.fillRect(0, waterY, W, H - waterY);

  // Colunas de reflexo na água (Torre Chrysler, Lua e Orla)
  const reflections = [
    { x: chX,   w: 26, col: 'rgba(255, 205, 110, 0.38)' },
    { x: moonX, w: 32, col: 'rgba(255, 245, 200, 0.42)' },
    { x: 54,    w: 18, col: 'rgba(0, 240, 255, 0.22)' }
  ];
  reflections.forEach(rf => {
    for (let ry = waterY + 2; ry < H; ry += 2) {
      const progress = (ry - waterY) / (H - waterY);
      const wave = Math.sin(t * 4 + ry * 0.6) * (2 + progress * 4);
      const rw = Math.round(rf.w * (0.45 + progress * 0.75));
      ctx.fillStyle = rf.col;
      ctx.fillRect(Math.round(rf.x - rw / 2 + wave), ry, rw, 1);
    }
  });

  // Píer em silhueta à direita com postes de luz (como na 1ª imagem)
  const pierX = 172, pierY = waterY + 8;
  ctx.fillStyle = '#040B12';
  ctx.fillRect(pierX, pierY, W - pierX, 3);
  for (let px = pierX + 4; px < W; px += 12) {
    ctx.fillRect(px, pierY + 3, 2, 8);
  }
  // Postes do píer
  [215, 268].forEach(lampX => {
    ctx.fillStyle = '#1E3F4F';
    ctx.fillRect(lampX, pierY - 9, 1, 9);
    ctx.fillStyle = '#FFF9D2';
    ctx.fillRect(lampX - 2, pierY - 10, 5, 2);
  });
}

function renderGiantRobotBoss(ctx, b, camX) {
  const bx = Math.round(b.x - camX);
  const by = Math.round(b.y + Math.sin(b.animTime * 4) * 2);
  const v = b.variant;

  ctx.save();
  if (b.hitFlash > 0) ctx.filter = 'brightness(2.2)';

  // Pernas mecânicas
  ctx.fillStyle = '#0E1722';
  ctx.fillRect(bx + 10, b.y + 44, 12, 20);
  ctx.fillRect(bx + 36, b.y + 44, 12, 20);
  ctx.fillStyle = v.trim;
  ctx.fillRect(bx + 8, b.y + 58, 16, 6);
  ctx.fillRect(bx + 34, b.y + 58, 16, 6);

  // Torso blindado
  ctx.fillStyle = v.hull;
  ctx.fillRect(bx + 6, by + 16, 46, 30);
  ctx.strokeStyle = v.trim;
  ctx.strokeRect(bx + 6, by + 16, 46, 30);

  // Gravata corporativa holográfica no peito do Mecha
  ctx.fillStyle = v.eye;
  ctx.fillRect(bx + 27, by + 18, 4, 10);

  // Núcleo / Ponto Fraco no centro do Torso
  if (b.exposed) {
    const pulse = (Math.floor(game.time * 14) % 2 === 0);
    ctx.fillStyle = pulse ? '#FFFFFF' : v.core;
    ctx.fillRect(bx + 21, by + 24, 16, 14);
    ctx.strokeStyle = '#FF3B2F';
    ctx.strokeRect(bx + 19, by + 22, 20, 18);
  } else {
    ctx.fillStyle = '#263545';
    ctx.fillRect(bx + 21, by + 24, 16, 14);
    ctx.fillStyle = v.trim;
    ctx.fillRect(bx + 21, by + 30, 16, 2);
  }

  // Cabeça animada com visor cyber
  const headY = by + (b.exposed ? 2 : 0);
  ctx.fillStyle = v.hull;
  ctx.fillRect(bx + 14, headY, 30, 16);
  ctx.strokeStyle = v.trim;
  ctx.strokeRect(bx + 14, headY, 30, 16);
  // Olho/visor brilhante
  ctx.fillStyle = b.state === 'telegraph' ? '#FFFFFF' : v.eye;
  ctx.fillRect(bx + 18, headY + 5, 22, 5);

  // Braços articulados (sobem na telegrafia de ataque)
  const armOffsetY = Math.round(b.armAngle * 14);
  ctx.fillStyle = v.hull;
  ctx.fillRect(bx - 4, by + 18 + armOffsetY, 10, 24);
  ctx.fillRect(bx + 52, by + 18 + armOffsetY, 10, 24);
  ctx.fillStyle = v.trim;
  ctx.fillRect(bx - 5, by + 38 + armOffsetY, 12, 6);
  ctx.fillRect(bx + 51, by + 38 + armOffsetY, 12, 6);

  // Aviso de ataque do Boss
  if (b.state === 'telegraph') {
    ctx.fillStyle = (Math.floor(game.time * 18) % 2 === 0) ? '#FF3B2F' : '#FFC21A';
    ctx.fillRect(bx + 26, headY - 10, 6, 6);
  }

  ctx.restore();
}

/* =====================================================================
   16. PARTÍCULAS, TEXTOS FLUTUANTES, HUD, LOJA E CONTROLES
   ===================================================================== */
function rectsOverlap(x1, y1, w1, h1, x2, y2, w2, h2) {
  return x1 < x2 + w2 && x1 + w1 > x2 && y1 < y2 + h2 && y1 + h1 > y2;
}

function triggerScreenShake(dur = 0.2, mag = 3) {
  if (!game) return;
  game.shakeTime = Math.max(game.shakeTime, dur);
  game.shakeMag = Math.max(game.shakeMag, mag);
}

function spawnParticles(x, y, color = '#7CFF3A', count = 8) {
  if (!game) return;
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 25 + Math.random() * 85;
    game.particles.push({
      x, y,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd - 20,
      color,
      size: Math.random() < 0.5 ? 2 : 1,
      life: 0.25 + Math.random() * 0.3
    });
  }
}

function addFloatingText(x, y, text, color = '#7CFF3A') {
  if (!game) return;
  game.floatingTexts.push({ x, y, text, color, life: 0.85 });
}

function updateParticlesAndTexts(dt) {
  for (let i = game.particles.length - 1; i >= 0; i--) {
    const pt = game.particles[i];
    pt.x += pt.vx * dt;
    pt.y += pt.vy * dt;
    pt.vy += 180 * dt;
    pt.life -= dt;
    if (pt.life <= 0) game.particles.splice(i, 1);
  }
  for (let i = game.floatingTexts.length - 1; i >= 0; i--) {
    const ft = game.floatingTexts[i];
    ft.y -= 18 * dt;
    ft.life -= dt;
    if (ft.life <= 0) game.floatingTexts.splice(i, 1);
  }
}

function updateGameHUD() {
  if (!game) return;
  const p = game.player;
  const hpPct = Math.max(0, Math.round((p.hp / p.maxHp) * 100));
  const shPct = Math.max(0, Math.round((p.shield / p.maxHp) * 100));

  $('#ghHpText').textContent = `${p.hp}/${p.maxHp}${p.shield > 0 ? ` (+${p.shield})` : ''}`;
  const hpFill = $('#ghHpFill');
  hpFill.style.width = hpPct + '%';
  hpFill.classList.toggle('low', hpPct <= 30);
  $('#ghShieldFill').style.width = Math.min(100, shPct) + '%';

  const curSeg = game.stage.segments.find(s => p.x >= s.startX && p.x <= s.endX) || game.stage.segments[0];
  $('#ghDist').textContent = `${game.distance}m`;
  $('#ghSeg').textContent = `${curSeg ? curSeg.index : 1}/${game.stage.segments.length}`;
  $('#ghCoins').textContent = state.game.coins || 0;
  $('#ghXP').textContent = `+${game.rawXPEarned} XP`;
  const freePlay = areAllDailyTasksCompleted();
  $('#ghTickets').textContent = freePlay ? '∞' : (state.game.tickets || 0);

  const skillTxt = p.skillTimer <= 0 ? 'PRONTA' : `${p.skillTimer.toFixed(1)}s`;
  $('#ghSkillCd').textContent = skillTxt;

  // Buffs ativos
  const buffs = [];
  if (p.specialAmmo > 0) buffs.push(`<span class="gh-buff">🔥 MUNIÇÃO x${p.specialAmmo}</span>`);
  if (p.overdriveTimer > 0) buffs.push(`<span class="gh-buff">⚡ TURBO ${Math.ceil(p.overdriveTimer)}s</span>`);
  if (p.supportBuffTimer > 0) buffs.push(`<span class="gh-buff">🎵 BUFF ${Math.ceil(p.supportBuffTimer)}s</span>`);
  $('#ghBuffs').innerHTML = buffs.join('');
}

function renderCityBanner() {
  state.game = state.game || DEFAULT_GAME_STATE();
  const g = state.game;
  if (g.dailyXPDate !== todayKey()) {
    g.dailyXPDate = todayKey();
    g.dailyXP = 0;
  }
  const cap = getDailyXPCap();
  const freePlay = areAllDailyTasksCompleted();
  if ($('#cityTicketsCount')) $('#cityTicketsCount').textContent = freePlay ? '∞ LIVRE' : (g.tickets || 0);
  if ($('#cityCoinsCount')) $('#cityCoinsCount').textContent = g.coins || 0;
  if ($('#cityDailyXPText')) $('#cityDailyXPText').textContent = `${g.dailyXP || 0}/${cap}`;
  const playBtn = $('#startCityMissionBtn');
  if (playBtn) {
    const hasTkt = freePlay || (g.tickets || 0) >= GAME_CONFIG.TICKET_COST;
    playBtn.disabled = !hasTkt;
    playBtn.querySelector('.play-sub').textContent = freePlay
      ? 'TODAS AS TAREFAS CONCLUÍDAS • ACESSO LIVRE ILIMITADO (SEM GASTAR FICHAS)'
      : hasTkt
        ? 'CUSTO: 1 FICHA • RECOMPENSA: XP + MOEDAS'
        : 'SEM FICHAS — CONCLUA UMA TAREFA DIÁRIA PARA JOGAR';
  }
}

/* =====================================================================
   17. LOJA DA CIDADE (Upgrades de Vida/Dano/Velocidade, Skins de Arma e Trajes)
   ===================================================================== */
function openCityShop() {
  renderCityShop();
  openModal('shopModal');
}

function renderCityShop() {
  const g = state.game || DEFAULT_GAME_STATE();
  $('#shopCoinsVal').textContent = g.coins || 0;
  $('#shopTicketsVal').textContent = g.tickets || 0;

  // 1. Seção de Upgrades Permanentes
  const upgCards = Object.entries(GAME_CONFIG.SHOP_UPGRADES).map(([key, cfg]) => {
    const curLvl = g.upgrades?.[key] || 0;
    const isMax = curLvl >= cfg.max;
    const cost = Math.round(cfg.baseCost * Math.pow(cfg.costMult, curLvl));
    const canAfford = (g.coins || 0) >= cost && !isMax;
    const pips = Array.from({ length: cfg.max }, (_, i) => `<span class="${i < curLvl ? 'on' : ''}"></span>`).join('');
    return `
      <div class="shop-card">
        <div>
          <div class="shop-card-head">
            <div class="shop-card-ico">${cfg.icon}</div>
            <div>
              <b>${cfg.name}</b>
              <small>${cfg.desc}</small>
            </div>
          </div>
          <div class="shop-pips">${pips}</div>
        </div>
        <button type="button" class="shop-buy-btn" data-buy-upg="${key}" ${canAfford ? '' : 'disabled'}>
          ${isMax ? 'NÍVEL MÁXIMO' : `APRIMORAR • ${cost} 🪙`}
        </button>
      </div>`;
  }).join('');

  // 2. Seção de Cosméticos de Arma (Skins de energia)
  const skinCards = GAME_CONFIG.SHOP_SKINS.map(sk => {
    const owned = g.unlockedWeaponSkins?.includes(sk.id);
    const equipped = g.equippedWeaponSkin === sk.id;
    const canAfford = (g.coins || 0) >= sk.cost;
    return `
      <div class="shop-card">
        <div class="shop-card-head">
          <canvas class="sprite" data-skin-preview="${sk.id}"></canvas>
          <div>
            <b>${sk.name}</b>
            <small>${sk.desc}</small>
          </div>
        </div>
        <button type="button" class="shop-buy-btn ${equipped ? 'equipped' : ''}" data-buy-skin="${sk.id}" ${!owned && !canAfford ? 'disabled' : ''}>
          ${equipped ? '✓ SKIN EQUIPADA (DESEQUIPAR)' : owned ? 'EQUIPAR SKIN' : `COMPRAR • ${sk.cost} 🪙`}
        </button>
      </div>`;
  }).join('');

  // 3. Seção de Trajes Extras para o Personagem
  const outfitCards = GAME_CONFIG.SHOP_OUTFITS.map(ot => {
    const owned = g.unlockedOutfits?.includes(ot.id);
    const equipped = state.profile?.roupa === ot.id;
    const canAfford = (g.coins || 0) >= ot.cost;
    return `
      <div class="shop-card">
        <div class="shop-card-head">
          <canvas class="sprite" data-outfit-preview="${ot.id}"></canvas>
          <div>
            <b>${ot.name}</b>
            <small>${ot.desc}</small>
          </div>
        </div>
        <button type="button" class="shop-buy-btn ${equipped ? 'equipped' : ''}" data-buy-outfit="${ot.id}" ${!owned && !canAfford ? 'disabled' : ''}>
          ${equipped ? '✓ TRAJE EM USO' : owned ? 'EQUIPAR TRAJE' : `COMPRAR • ${ot.cost} 🪙`}
        </button>
      </div>`;
  }).join('');

  $('#shopContent').innerHTML = `
    <div>
      <div class="shop-sec-title">⚡ UPGRADES DE ATRIBUTOS DE COMBATE</div>
      <div class="shop-grid">${upgCards}</div>
    </div>
    <div>
      <div class="shop-sec-title">🔫 SKINS ENERGÉTICAS DE ARMA</div>
      <div class="shop-grid">${skinCards}</div>
    </div>
    <div>
      <div class="shop-sec-title">🧥 TRAJES ESPECIAIS DO AGENTE</div>
      <div class="shop-grid">${outfitCards}</div>
    </div>
  `;

  // Desenha prévias de armas e trajes nos cartões da loja
  const clsWeapon = getClass(state.profile?.classe || 'guerreiro').weapon;
  const tier = tierForLevel(state.level);
  document.querySelectorAll('[data-skin-preview]').forEach(cv => {
    drawWeapon(cv, clsWeapon, tier, cv.dataset.skinPreview);
  });
  document.querySelectorAll('[data-outfit-preview]').forEach(cv => {
    const baseProf = state.profile ? { ...state.profile, roupa: cv.dataset.outfitPreview } : { ...DEFAULT_PROFILE(), roupa: cv.dataset.outfitPreview };
    drawSprite(cv, baseProf, { noWeapon: true });
  });
}

async function handleShopClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (!navigator.onLine) {
    toast('VOCÊ ESTÁ OFFLINE. CONECTE-SE PARA USAR A LOJA.', true);
    return;
  }
  const g = state.game;

  const syncShopItemWithServer = async (itemKey, itemType) => {
    if (!window.currentUser || !window.SB?.jogo) return null;
    btn.disabled = true;
    try {
      if (typeof setSyncStatus === 'function') setSyncStatus('syncing', 'PROCESSANDO COMPRA...');
      const res = await window.SB.jogo.comprarOuEquiparItem(itemKey, itemType);
      if (res?.profile) {
        g.coins = res.profile.moedas;
        g.tickets = res.profile.fichas;
      }
      if (typeof setSyncStatus === 'function') setSyncStatus('online');
      return res;
    } catch (err) {
      if (typeof setSyncStatus === 'function') setSyncStatus('error');
      toast(err.message || 'ERRO NA LOJA.', true);
      btn.disabled = false;
      throw err;
    }
  };

  if (btn.dataset.buyUpg) {
    const key = btn.dataset.buyUpg;
    const cfg = GAME_CONFIG.SHOP_UPGRADES[key];
    const cur = g.upgrades[key] || 0;
    const cost = Math.round(cfg.baseCost * Math.pow(cfg.costMult, cur));
    if (cur < cfg.max && g.coins >= cost) {
      try {
        if (window.currentUser && window.SB?.jogo) {
          await syncShopItemWithServer(key, 'upgrade');
        } else {
          g.coins -= cost;
        }
        g.upgrades[key] = cur + 1;
        saveState();
        playGameSfx('item');
        toast(`UPGRADE ADQUIRIDO: ${cfg.name} (NV ${cur + 1})`);
        renderCityShop();
        renderCityBanner();
      } catch { /* erro já exibido */ }
    }
  } else if (btn.dataset.buySkin) {
    const skinId = btn.dataset.buySkin;
    const cfg = GAME_CONFIG.SHOP_SKINS.find(s => s.id === skinId);
    if (!cfg) return;
    try {
      if (window.currentUser && window.SB?.jogo) {
        await syncShopItemWithServer(skinId, 'weapon_skin');
      } else if (!g.unlockedWeaponSkins.includes(skinId)) {
        if (g.coins < cfg.cost) return;
        g.coins -= cfg.cost;
      }
      if (g.unlockedWeaponSkins.includes(skinId)) {
        g.equippedWeaponSkin = g.equippedWeaponSkin === skinId ? null : skinId;
        playGameSfx('coin');
      } else {
        g.unlockedWeaponSkins.push(skinId);
        g.equippedWeaponSkin = skinId;
        playGameSfx('item');
        toast(`SKIN DESBLOQUEADA E EQUIPADA: ${cfg.name.toUpperCase()}!`);
      }
      saveState();
      renderCityShop();
      renderAll();
    } catch { /* erro já exibido */ }
  } else if (btn.dataset.buyOutfit) {
    const outId = btn.dataset.buyOutfit;
    const cfg = GAME_CONFIG.SHOP_OUTFITS.find(o => o.id === outId);
    if (!cfg) return;
    try {
      if (window.currentUser && window.SB?.jogo) {
        await syncShopItemWithServer(outId, 'outfit');
      } else if (!g.unlockedOutfits.includes(outId)) {
        if (g.coins < cfg.cost) return;
        g.coins -= cfg.cost;
      }
      if (g.unlockedOutfits.includes(outId)) {
        if (state.profile) state.profile.roupa = outId;
        playGameSfx('coin');
      } else {
        g.unlockedOutfits.push(outId);
        if (state.profile) state.profile.roupa = outId;
        playGameSfx('item');
        toast(`TRAJE DESBLOQUEADO E EQUIPADO: ${cfg.name.toUpperCase()}!`);
      }
      saveState();
      renderCityShop();
      renderAll();
    } catch { /* erro já exibido */ }
  }
}

/* =====================================================================
   18. EVENTOS DE TECLADO, TOUCH E INICIALIZAÇÃO DO MÓDULO
   ===================================================================== */
function updateMuteButtonUI() {
  const btn = $('#gameMuteBtn');
  if (btn) btn.textContent = isGameMuted() ? '🔇' : '🔊';
}

function handleGameKey(e, isDown) {
  if (!$('#gameScreen')?.classList.contains('open')) return;
  const code = e.code;

  if (isDown && code === 'Escape') {
    e.preventDefault();
    togglePauseGame();
    return;
  }

  // Movimentação: WASD / ← ↑ → ↓ e Pulo também no Backspace
  if (['ArrowLeft', 'KeyA'].includes(code)) {
    keys.left = isDown; e.preventDefault();
  } else if (['ArrowRight', 'KeyD'].includes(code)) {
    keys.right = isDown; e.preventDefault();
  } else if (['ArrowDown', 'KeyS'].includes(code)) {
    keys.down = isDown; e.preventDefault();
  } else if (['ArrowUp', 'KeyW', 'Backspace'].includes(code)) {
    if (isDown && !keys.jump) keys.jumpJustPressed = true;
    keys.jump = isDown;
    e.preventDefault();
  } else if (code === 'KeyR') {
    // Especial: R
    if (isDown && !keys.skill) keys.skillJustPressed = true;
    keys.skill = isDown;
    e.preventDefault();
  }
}

function handleGameMouseDown(e) {
  if (!$('#gameScreen')?.classList.contains('open')) return;
  if (!game.running || game.paused || game.over) return;
  // Ignorar cliques nos botões de interface (HUD, pausa, som, controles touch, overlays)
  if (e.target.closest('button, .game-overlay, .touch-controls, .game-hud-top')) return;

  // Ataque simples: Botão esquerdo do mouse (button === 0)
  if (e.button === 0) {
    if (!keys.attack) keys.attackJustPressed = true;
    keys.attack = true;
    e.preventDefault();
  }
}

function handleGameMouseUp(e) {
  if (e.button === 0) {
    keys.attack = false;
  }
}

/** Dispositivo com toque (celular / tablet) */
function isTouchDevice() {
  return window.matchMedia?.('(pointer:coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

/** Entra em tela cheia e tenta travar em paisagem (precisa ser chamado a partir de um toque/clique) */
async function enterGameFullscreen() {
  const el = document.documentElement;
  try {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    }
  } catch { /* navegador bloqueou ou não suporta (ex: iPhone) — o layout CSS já ocupa a tela toda */ }
  try {
    if (screen.orientation?.lock) await screen.orientation.lock('landscape');
  } catch { /* nem todo navegador permite travar a orientação */ }
  setTimeout(() => window.scrollTo(0, 1), 50);
}

function exitGameFullscreen() {
  try { screen.orientation?.unlock?.(); } catch {}
  try {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else if (document.webkitFullscreenElement) document.webkitExitFullscreen?.();
  } catch {}
}

function toggleGameFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) exitGameFullscreen();
  else enterGameFullscreen();
}

// Dedo que está controlando o joystick agora (null = livre)
let tcJoyPointer = null;

function releaseAllTouchKeys() {
  keys.left = keys.right = keys.jump = keys.down = keys.attack = keys.skill = false;
  tcJoyPointer = null;
  document.querySelectorAll('#touchControls .pressed').forEach(b => b.classList.remove('pressed'));
  $('#tcJoystick')?.classList.remove('active');
  const stick = $('#tcStick');
  if (stick) stick.style.transform = 'translate(-50%, -50%)';
}

function bindTouchControls() {
  const tc = $('#touchControls');
  if (!tc) return;

  // ---- Botões de ação (multitoque: cada dedo é um pointer independente) ----
  const setTouchKey = (k, isDown, btn) => {
    btn.classList.toggle('pressed', isDown);
    if (k === 'jump' && isDown && !keys.jump) keys.jumpJustPressed = true;
    if (k === 'attack' && isDown && !keys.attack) keys.attackJustPressed = true;
    if (k === 'skill' && isDown && !keys.skill) keys.skillJustPressed = true;
    keys[k] = isDown;
  };
  // Qual dedo está segurando cada botão (para soltar certo mesmo se o evento vier de fora)
  const btnPointers = new Map();
  tc.querySelectorAll('[data-key]').forEach(btn => {
    const k = btn.dataset.key;
    btn.addEventListener('pointerdown', e => {
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch {}
      btnPointers.set(e.pointerId, btn);
      setTouchKey(k, true, btn);
      if (navigator.vibrate) navigator.vibrate(12);
    });
    const release = e => {
      e.preventDefault?.();
      btnPointers.delete(e.pointerId);
      setTouchKey(k, false, btn);
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', e => e.preventDefault());
  });

  // Botões START (pausa) e SELECT (tela cheia) do console
  tc.querySelector('[data-gb="start"]')?.addEventListener('click', e => { e.preventDefault(); togglePauseGame(); });
  tc.querySelector('[data-gb="select"]')?.addEventListener('click', e => { e.preventDefault(); toggleGameFullscreen(); });

  // ---- Joystick virtual ----
  const joy = $('#tcJoystick');
  const stick = $('#tcStick');
  if (!joy || !stick) return;

  const updateJoy = e => {
    const r = joy.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const max = r.width * 0.38;
    let dx = e.clientX - cx;
    let dy = e.clientY - cy;
    const dist = Math.hypot(dx, dy);
    if (dist > max) { dx = dx / dist * max; dy = dy / dist * max; }
    stick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    const nx = dx / max;
    const ny = dy / max;
    keys.left = nx < -0.35;
    keys.right = nx > 0.35;
    // Abaixar: empurrar o analógico para baixo (mais vertical do que horizontal)
    keys.down = ny > 0.55 && Math.abs(ny) > Math.abs(nx) * 0.7;
  };

  const resetJoy = () => {
    tcJoyPointer = null;
    joy.classList.remove('active');
    keys.left = keys.right = keys.down = false;
    stick.style.transform = 'translate(-50%, -50%)';
  };
  const endJoy = e => {
    if (tcJoyPointer !== e.pointerId) return;
    resetJoy();
  };

  joy.addEventListener('pointerdown', e => {
    e.preventDefault();
    // Um novo toque no joystick SEMPRE assume o controle. Antes, se o celular
    // perdesse o "soltou" do dedo anterior (notificação, gesto do sistema,
    // dedo escorregando para fora), o joystick ficava preso como "ocupado"
    // e ignorava todos os toques seguintes.
    tcJoyPointer = e.pointerId;
    try { joy.setPointerCapture(e.pointerId); } catch {}
    joy.classList.add('active');
    updateJoy(e);
  });
  // Movimento escutado na janela: continua funcionando mesmo se a captura do dedo falhar
  window.addEventListener('pointermove', e => {
    if (tcJoyPointer !== e.pointerId) return;
    if (e.cancelable) e.preventDefault();
    updateJoy(e);
  }, { passive: false });
  joy.addEventListener('lostpointercapture', endJoy);
  window.addEventListener('pointerup', endJoy);
  window.addEventListener('pointercancel', endJoy);
  joy.addEventListener('contextmenu', e => e.preventDefault());

  // Rede de segurança: quando nenhum dedo está mais na tela, solta tudo
  const allFingersUp = e => {
    if (e.touches && e.touches.length > 0) {
      // Solta só o joystick se o dedo dele não estiver mais na tela
      if (tcJoyPointer !== null) {
        const r = joy.getBoundingClientRect();
        const pad = r.width;  // tolerância: o dedo pode estar arrastando fora do círculo
        const stillOnJoy = [...e.touches].some(t =>
          t.clientX > r.left - pad && t.clientX < r.right + pad &&
          t.clientY > r.top - pad && t.clientY < r.bottom + pad);
        if (!stillOnJoy) resetJoy();
      }
      return;
    }
    btnPointers.clear();
    releaseAllTouchKeys();
  };
  window.addEventListener('touchend', allFingersUp, { passive: true });
  window.addEventListener('touchcancel', allFingersUp, { passive: true });
}

function initGame() {
  $('#startCityMissionBtn')?.addEventListener('click', startCityMission);
  $('#openCityShopBtn')?.addEventListener('click', openCityShop);
  $('#shopContent')?.addEventListener('click', handleShopClick);

  $('#gameMuteBtn')?.addEventListener('click', () => {
    state.game.muted = !state.game.muted;
    saveState();
    updateMuteButtonUI();
  });
  $('#gamePauseBtn')?.addEventListener('click', togglePauseGame);
  $('#gameFullscreenBtn')?.addEventListener('click', toggleGameFullscreen);

  window.addEventListener('keydown', e => handleGameKey(e, true));
  window.addEventListener('keyup', e => handleGameKey(e, false));
  window.addEventListener('mousedown', handleGameMouseDown);
  window.addEventListener('mouseup', handleGameMouseUp);
  window.addEventListener('blur', releaseAllTouchKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllTouchKeys(); });
  bindTouchControls();
  renderCityBanner();
}

/**
 * Handlers de sincronização do mundo para partidas cooperativas no canal `room:{room_id}`:
 * - Clientes não-host aplicam o estado autoritativo de inimigos, maletas e Boss vindo do Host.
 * - O Host processa acertos (`client_hit`) enviados pelos outros jogadores da sala.
 */
function applyCoopWorldStateFromHost(payload) {
  if (!game || !game.isCoop || !payload) return;
  const st = game.stage;

  // 1. Atualiza inimigos
  if (Array.isArray(payload.e)) {
    payload.e.forEach(([idx, x, y, hp, facing]) => {
      const en = st.enemies[idx];
      if (!en) return;
      en.x += (x - en.x) * 0.5;
      en.y += (y - en.y) * 0.5;
      en.hp = hp;
      en.facing = facing;
    });
  }

  // 2. Atualiza Boss
  if (payload.b && st.boss) {
    const b = st.boss;
    const pb = payload.b;
    if (pb.a && !b.active && !b.defeated) {
      b.active = true;
      $('#bossHud')?.classList.remove('hidden');
      $('#bossName').textContent = b.name;
    }
    b.x = pb.x;
    b.y = pb.y;
    b.hp = pb.hp;
    b.maxHp = pb.mhp || b.maxHp;
    b.phase = pb.ph || b.phase;
    b.state = pb.st || b.state;
    b.exposed = Boolean(pb.ex);
    if (pb.d && !b.defeated) {
      b.defeated = true;
      b.active = false;
      $('#bossHud')?.classList.add('hidden');
      finishCityMission(true);
    }
  }

  if (payload.over && payload.won && !game.over) {
    finishCityMission(true);
  }
}

function handleCoopClientHitOnHost(payload) {
  if (!game || !game.isCoop || !payload) return;
  if (payload.targetType === 'boss') {
    damageBoss(Number(payload.dmg || 10), true);
  } else if (payload.targetType === 'enemy' && typeof payload.enemyIndex === 'number') {
    const en = game.stage.enemies[payload.enemyIndex];
    if (en && en.hp > 0) {
      damageEnemy(en, Number(payload.dmg || 10), 0, true);
    }
  }
}

window.startCoopCityMission = startCityMission;
window.applyCoopWorldStateFromHost = applyCoopWorldStateFromHost;
window.handleCoopClientHitOnHost = handleCoopClientHitOnHost;
