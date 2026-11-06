/* =====================================================================
   Sistema de Missões — PERSONAGEM (pixel art 16x16 em camadas)
   ---------------------------------------------------------------------
   Este arquivo é carregado ANTES de script.js e usa, em tempo de
   execução, globais definidas lá: state, saveState, toast, $, escapeHTML,
   openModal, closeModal, effectiveStreak.

   Ordem das camadas no canvas:
     cabelo (trás) → corpo → roupa (base) → cabelo (frente)
     → roupa (sobreposição: capuz/elmo/chapéu) → arma → mãos → contorno
   ===================================================================== */

/* ---------------------------------------------------------------------
   0. UTILITÁRIOS DE MATRIZ
   px({linha: 'string de 16 chars'}) → matriz 16x16 ('.' = transparente)
   rep(a, b, str) → repete a mesma linha da linha a até b
   --------------------------------------------------------------------- */
function px(rows = {}) {
  const m = [];
  for (let y = 0; y < 16; y++) m.push((rows[y] || '').padEnd(16, '.').slice(0, 16));
  return m;
}
function rep(from, to, str) {
  const o = {};
  for (let y = from; y <= to; y++) o[y] = str;
  return o;
}
/** Escurece (amt>0) ou clareia (amt<0) uma cor hex */
function shadeHex(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = c => Math.max(0, Math.min(255, Math.round(amt > 0 ? c * (1 - amt) : c + (255 - c) * -amt)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/* =====================================================================
   1. CATEGORIAS DE TAREFA (usadas pelos bônus de classe)
   ===================================================================== */
const CATEGORIES = {
  '':       { label: 'SEM CATEGORIA', icon: '◇' },
  fisico:   { label: 'FÍSICO',   icon: '💪' },
  mental:   { label: 'MENTAL',   icon: '🧠' },
  criativo: { label: 'CRIATIVO', icon: '🎨' },
  social:   { label: 'SOCIAL',   icon: '🤝' },
  rotina:   { label: 'ROTINA',   icon: '🔁' }
};

/* =====================================================================
   2. PALETAS (pele, cabelo, roupa)
   ===================================================================== */
const GENDERS = [
  { id: 'f', label: 'FEMININO' },
  { id: 'm', label: 'MASCULINO' }
];
const SKIN_TONES = ['#FFE3CC', '#F7CDA6', '#EBB688', '#D9A06F', '#BE8053', '#9C6440', '#78472A', '#4E2D1A'];
const HAIR_COLORS = [
  { name: 'PRETO',      hex: '#1C1C24' },
  { name: 'CASTANHO',   hex: '#4A2E1B' },
  { name: 'MARROM',     hex: '#7A4A25' },
  { name: 'LOIRO',      hex: '#E8C35A' },
  { name: 'RUIVO',      hex: '#C8551F' },
  { name: 'PRATEADO',   hex: '#E3ECF0' },
  { name: 'ROSA',       hex: '#FF6FB5' },
  { name: 'AZUL',       hex: '#3AA0FF' },
  { name: 'VERDE NEON', hex: '#7CFF3A' },
  { name: 'ROXO',       hex: '#9B5CFF' }
];
const CLOTH_COLORS = [
  { name: 'TURQUESA', hex: '#1FD1B0' },
  { name: 'CIANO',    hex: '#00B8D4' },
  { name: 'AZUL',     hex: '#2F5FD0' },
  { name: 'VERMELHO', hex: '#D0342C' },
  { name: 'VERDE',    hex: '#3C9A3C' },
  { name: 'ROXO',     hex: '#7A3CC8' },
  { name: 'DOURADO',  hex: '#D9A520' },
  { name: 'MARROM',   hex: '#8A5A32' },
  { name: 'CINZA',    hex: '#8A96A3' },
  { name: 'PRETO',    hex: '#2A2F3A' }
];
const OUTLINE_COLOR = '#08101A';

/* =====================================================================
   3. CORPOS BASE (16x16)
   S pele | s sombra da pele | E olhos | L lábios | O linha interna | D sapato
   `hands` = coordenadas [x,y] das mãos (para a arma ser "segurada")
   ===================================================================== */
const BODIES = {
  m: {
    hands: [[3, 12], [12, 12]],
    matrix: px({
      2:  '....SSSSSSSS....',
      3:  '....SSSSSSSS....',
      4:  '....SSSSSSSS....',
      5:  '....SSESSESS....',
      6:  '....SSESSESS....',
      7:  '....sSSssSSs....',
      8:  '.....sSSSSs.....',
      9:  '...SSSSSSSSSS...',
      10: '...SOSSSSSSOS...',
      11: '...SOSSSSSSOS...',
      12: '...sOSSSSSSOs...',
      13: '.....SSSSSS.....',
      14: '.....SS..SS.....',
      15: '.....DD..DD.....'
    })
  },
  f: {
    hands: [[3, 12], [12, 12]],
    matrix: px({
      2:  '....SSSSSSSS....',
      3:  '....SSSSSSSS....',
      4:  '....SSSSSSSS....',
      5:  '....SEESSEES....',
      6:  '....SSESSESS....',
      7:  '....sSSLLSSs....',
      8:  '.....sSSSSs.....',
      9:  '....SSSSSSSS....',
      10: '...SOSSSSSSOS...',
      11: '...SOOSSSSOOS...',
      12: '...sOSSSSSSOs...',
      13: '....SSSSSSSS....',
      14: '.....SS..SS.....',
      15: '.....DD..DD.....'
    })
  }
};

/* =====================================================================
   4. CABELOS (12 estilos)
   H cor | h sombra | R fita (vermelha)
   front = desenhado sobre o rosto | back = atrás do corpo (opcional)
   ===================================================================== */
const HAIR_STYLES = [
  { id: 'curto', name: 'CURTO', front: px({
      1: '.....HHHHHH.....', 2: '....HHHHHHHH....', 3: '....HHHHhHHH....', 4: '....H......H....' }) },
  { id: 'longo', name: 'LONGO',
    back: px({ 3: '...HHHHHHHHHH...', ...rep(4, 11, '..HHHHHHHHHHHH..'), 12: '..hHHHHHHHHHHh..', 13: '...hhhhhhhhhh...' }),
    front: px({
      1: '.....HHHHHH.....', 2: '....HHHHHHHH....', 3: '...HHHHhhHHHH...', 4: '...HH......HH...',
      5: '...H........H...', 6: '...H........H...', 7: '...H........H...', 8: '...hH......Hh...' }) },
  { id: 'rabo', name: 'RABO DE CAVALO', front: px({
      1: '.....HHHHHH.....', 2: '....HHHHHHHHR...', 3: '....HHHHHHHHHH..', 4: '....H......HHH..',
      5: '............HH..', 6: '............HH..', 7: '.............H..', 8: '.............h..', 9: '.............h..' }) },
  { id: 'tranca', name: 'TRANÇA', front: px({
      1: '.....HHHHHH.....', 2: '....HHHHHHHH....', 3: '...HHHHhHHHH....', 4: '...HH......H....',
      5: '...H............', 6: '...Hh...........', 7: '...hH...........', 8: '...Hh...........',
      9: '....Hh..........', 10: '....hH..........', 11: '....Hh..........', 12: '....RR..........' }) },
  { id: 'moicano', name: 'MOICANO', front: px({
      0: '.......HH.......', 1: '......HHHH......', 2: '....h.HHHH.h....', 3: '.......hh.......' }) },
  { id: 'careca', name: 'CARECA', front: px({}) },
  { id: 'topete', name: 'TOPETE', front: px({
      0: '...HHHHHH.......', 1: '..HHHHHHHHH.....', 2: '...HHhHHHHHH....', 3: '....H.....HH....', 4: '....H......H....' }) },
  { id: 'coque', name: 'COQUE', front: px({
      0: '......HHHH......', 1: '......hRRh......', 2: '....HHHHHHHH....', 3: '....HH....HH....', 4: '....H......H....' }) },
  { id: 'franja', name: 'FRANJA', front: px({
      1: '.....HHHHHH.....', 2: '....HHHHHHHH....', 3: '...HHHHHHHHHH...', 4: '...HHHHHHHHHH...',
      5: '...HH......HH...', 6: '...HH......HH...', 7: '...h........h...' }) },
  { id: 'cacheado', name: 'CACHEADO', front: px({
      0: '.....HHhHHH.....', 1: '...HHhHHHhHHH...', 2: '..HhHHHhHHHhHH..', 3: '..HHHhHHHhHHHh..',
      4: '..HhH......HhH..', 5: '..HH........HH..', 6: '...H........H...' }) },
  { id: 'rebelde', name: 'REBELDE', front: px({
      0: '...H..H...H.....', 1: '...HH.HH.HH.H...', 2: '..HHHHHHHHHHH...', 3: '...HHhHHHhHHH...', 4: '....H.H....H....' }) },
  { id: 'chanel', name: 'CHANEL', front: px({
      1: '.....HHHHHH.....', 2: '....HHHHHHHH....', 3: '...HHHHHHHHHH...', 4: '...HHh.....HH...',
      5: '...HH......HH...', 6: '...HH......HH...', 7: '...HH......HH...', 8: '...hHh....hHh...' }) }
];

/* =====================================================================
   5. ROUPAS (15 estilos)
   LETRAS (recortadas pelo corpo — só pintam sobre a pele):
     C primária | c sombra | A detalhe | B couro | b couro escuro
     M metal | m metal escuro | W branco | Y ouro | D escuro | K preto
   DÍGITOS (pintam livremente, fora do corpo — capas, capuzes, chapéus):
     1=C 2=c 3=A 4=M 5=D 6=B 7=W 8=Y
   base = sob o cabelo | over = sobre o cabelo | hairClip = esconde linhas
   do cabelo acima desse índice (para capuz/elmo/chapéu)
   ===================================================================== */
const OUTFITS = [
  { id: 'campones', name: 'CAMPONÊS', base: px({
      ...rep(9, 11, '..CCCCCCCCCCCC..'), 12: '....BBBBBBBB....', 13: '....bbbbbbbb....', 14: '....bbbbbbbb....' }) },
  { id: 'viajante', name: 'VIAJANTE', accent: '#C8A46A', base: px({
      9: '..AAAAAAAAAAAA..', 10: '..CCBBCCCCBBCC..', 11: '..CCBBCCCCBBCC..', 12: '....bbbbbbbb....',
      13: '....cccccccc....', 14: '....cccccccc....', 15: '....BBBBBBBB....' }) },
  { id: 'nobre', name: 'NOBRE', base: px({
      9: '..YCCCCWWCCCCY..', 10: '..CCCYCWWCYCCC..', 11: '..CCCYCCCCYCCC..', 12: '....YYYYYYYY....',
      13: '....cccccccc....', 14: '....WWWWWWWW....' }) },
  { id: 'couro', name: 'COURO', base: px({
      9: '..CCBBBBBBBBCC..', 10: '..CCBBBbbBBBCC..', 11: '..CCBBBBBBBBCC..', 12: '....bbbYYbbb....',
      13: '....BBBBBBBB....', 14: '....bbbbbbbb....', 15: '....BBBBBBBB....' }) },
  { id: 'armadura_leve', name: 'ARMADURA LEVE', base: px({
      9: '..44MMMMMMMM44..', 10: '...CMMMMMMMMC...', 11: '...CMmMMMMmMC...', 12: '....BBBBBBBB....',
      13: '....CCCCCCCC....', 14: '....mmmmmmmm....', 15: '....MMMMMMMM....' }) },
  { id: 'manto', name: 'MANTO', hairClip: 2,
    over: px({
      1: '.....111111.....', 2: '....11111111....', 3: '...112....211...', 4: '...12......21...',
      5: '...1........1...', 6: '...1........1...', 7: '...12......21...', 8: '...112....211...' }),
    base: px({
      9: '..111111111111..', 10: '..2CCCCCCCCCC2..', 11: '..2CCCCCCCCCC2..', 12: '..2.CCCCCCCC.2..',
      13: '..22cccccccc22..', 14: '...2222222222...' }) },
  { id: 'tunica', name: 'TÚNICA', accent: '#E8B923', base: px({
      9: '..CCCCCCCCCCCC..', 10: '..CCCCCWWCCCCC..', 11: '..CCCCCCCCCCCC..', 12: '....AAAAAAAA....',
      13: '...1111111111...', 14: '....bbbbbbbb....' }) },
  { id: 'inverno', name: 'CASACO DE INVERNO', base: px({
      9: '..WWWWWWWWWWWW..', 10: '..1CCCCYCCCCC1..', 11: '..1CCCCYCCCCC1..', 12: '..1.CCCYCCCC.1..',
      13: '...CCCCYCCCC....', 14: '....cccccccc....', 15: '....BBBBBBBB....' }) },
  { id: 'guarda', name: 'UNIFORME DE GUARDA', hairClip: 2,
    over: px({ 1: '.....444444.....', 2: '....MMMMMMMM....', 3: '....mMMMMMMm....', 4: '....m......m....' }),
    base: px({
      9: '..MMCCCCCCCCMM..', 10: '..mMCCCYYCCCMm..', 11: '...MCCCCCCCCM...', 12: '....bbbYbbbb....',
      13: '....cccccccc....', 14: '....cccccccc....', 15: '....DDDDDDDD....' }) },
  { id: 'mago', name: 'TRAJE DE MAGO', hairClip: 2,
    over: px({ 0: '.........11.....', 1: '......1881......', 2: '..111111111111..' }),
    base: px({
      9: '..CCCCCCCCCCCC..', 10: '..CCCCCYCCCCCC..', 11: '..2CCCCCCCCCC2..', 12: '..2.YYYYYYYY.2..',
      13: '...1111111111...', 14: '...1111111111...', 15: '...2222222222...' }) },
  { id: 'ninja', name: 'TRAJE NINJA', hairClip: 2,
    over: px({ 2: '....55555555....', 3: '....CCCCCCCC11..', 7: '....55555555....', 8: '.....555555.....' }),
    base: px({
      ...rep(9, 11, '..DDDDDDDDDDDD..'), 12: '....CCCCCCCC....', 13: '....DDDDDDDD....',
      14: '....DDDDDDDD....', 15: '....KKKKKKKK....' }) },
  { id: 'ferreiro', name: 'ROUPA DE FERREIRO', base: px({
      9: '..CCCCCCCCCCCC..', 10: '....BBBBBBBB....', 11: '....BBBBBBBB....', 12: '...bBBBYYBBBb...',
      13: '....BBBBBBBB....', 14: '....bbbbbbbb....', 15: '....DDDDDDDD....' }) },
  { id: 'gala', name: 'TRAJE DE GALA', base: px({
      9: '..KKKKKCCKKKKK..', 10: '..KKKKWWWWKKKK..', 11: '..KKKKWCCWKKKK..', 12: '....KKKCCKKK....',
      13: '....KKKKKKKK....', 14: '....KKKKKKKK....', 15: '....DDDDDDDD....' }) },
  { id: 'cacador', name: 'ROUPA DE CAÇADOR', hairClip: 2,
    over: px({
      1: '.....222222.....', 2: '....22222222....', 3: '...222....222...',
      4: '...2........2...', 5: '...2........2...', 6: '...2........2...' }),
    base: px({
      9: '..222222222222..', 10: '..2CCBCCCCCCC2..', 11: '..2CCCBCCCCCC2..', 12: '..2.CCCBCCCC.2..',
      13: '....bbbbbbbb....', 14: '....BBBBBBBB....', 15: '....bbbbbbbb....' }) },
  { id: 'armadura_pesada', name: 'ARMADURA PESADA', hairClip: 2,
    over: px({
      1: '.....444444.....', 2: '....MMMMMMMM....', 3: '....MMMMMMMM....', 4: '....Mm....mM....',
      5: '....M......M....', 6: '....M......M....', 7: '....m......m....' }),
    base: px({
      9: '..4MMMMMMMMMM4..', 10: '..44MCCCCCCM44..', 11: '...MmCCCCCCmM...', 12: '...MMMMYYMMMM...',
      13: '....mmmmmmmm....', 14: '....MMMMMMMM....', 15: '....mmmmmmmm....' }) },
  { id: 'cyber_agente', name: 'AGENTE CYBER (LOJA)', shopOnly: true, accent: '#00F0FF',
    over: px({ 5: '....33333333....', 6: '....33333333....' }),
    base: px({
      9: '..553CCCCCC355..', 10: '..55CCCCCCCC55..', 11: '..5.CCC33CCC.5..', 12: '....55588555....',
      13: '....55555555....', 14: '....555..555....', 15: '....333..333....' }) },
  { id: 'executivo_neon', name: 'EXECUTIVO NEON (LOJA)', shopOnly: true, accent: '#7CFF3A',
    over: px({ 5: '....KKKKKKKK....' }),
    base: px({
      9: '..KKKKK33KKKKK..', 10: '..KKKKWWWWKKKK..', 11: '..KKKKW33WKKKK..', 12: '....KKK88KKK....',
      13: '....KKKKKKKK....', 14: '....KKKKKKKK....', 15: '....33333333....' }) },
  { id: 'armadura_omega', name: 'EXOTRAJE ÔMEGA (LOJA)', shopOnly: true, hairClip: 2, accent: '#00F0FF',
    over: px({
      1: '.....443344.....', 2: '....MMMMMMMM....', 3: '....M333333M....', 4: '....M333333M....',
      5: '....mMMMMMMm....' }),
    base: px({
      9: '..33MMMMMMMM33..', 10: '..44M3CCCC3M44..', 11: '...MmCCCCCCmM...', 12: '...MMMM33MMMM...',
      13: '....mmmmmmmm....', 14: '....MM3333MM....', 15: '....33mmmm33....' }) }
];
const OUTFIT_FIXED = { B: '#7A4A25', b: '#4A2C15', M: '#B8C4CF', m: '#6B7885', W: '#F2F2EA', Y: '#E8B923', D: '#1D2433', K: '#0E1118' };
const OUTFIT_FREE  = { 1: 'C', 2: 'c', 3: 'A', 4: 'M', 5: 'D', 6: 'B', 7: 'W', 8: 'Y' };

/* =====================================================================
   6. ARMAS (matrizes 16x16 — desenhadas sobre o personagem)
   W cor do nível da arma | w sombra | G brilho  (mudam com a evolução)
   B madeira | b madeira escura | M metal | m metal escuro | Y ouro
   D sombrio | L corda | U azul | P roxo | g folha
   ===================================================================== */
const W_SWORD = px({
  1: '...W............', 2: '..WW............', ...rep(3, 9, '..Ww............'),
  10: '.YYYY...........', 11: '...B............', 12: '...B............', 13: '...Y............' });
const W_SHIELD = px({
  9: '...........WWWWW', 10: '...........WUYUW', 11: '...........WYYYW', 12: '...........WUYUW',
  13: '............WUW.', 14: '.............W..' });

const WEAPONS = {
  espada_longa:   { name: 'Espada Longa', g: 'f', layers: [W_SWORD] },
  cajado_arcano:  { name: 'Cajado Arcano', g: 'm', layers: [px({
      0: '.WW.............', 1: 'WGGW............', 2: 'WGGW............', 3: '.WW.............',
      ...rep(4, 14, '..B.............'), 7: '..W.............', 15: '..b.............' })] },
  arco_curto:     { name: 'Arco Curto', g: 'm', layers: [px({
      7: 'LW..............', 8: 'L.W.............', 9: 'L.W.............', 10: 'L..W............',
      11: 'L..B............', 12: 'L..B............', 13: 'L..W............', 14: 'L.W.............', 15: 'LW..............' })] },
  adagas_gemeas:  { name: 'Adagas Gêmeas', g: 'f', pl: true, layers: [px({
      ...rep(7, 9, '..W..........W..'), 10: '..w..........w..', 11: '.YYY........YYY.',
      12: '..B..........B..', 13: '..b..........b..' })] },
  maca_sagrada:   { name: 'Maça Sagrada', g: 'f', layers: [px({
      3: '..W.............', 4: '.WWW............', 5: 'WWGWW...........', 6: '.WWW............',
      7: '..Y.............', ...rep(8, 12, '..B.............'), 13: '..b.............' })] },
  espada_escudo:  { name: 'Espada e Escudo', g: 'm', pl: true, layers: [W_SWORD, W_SHIELD] },
  machado_duplo:  { name: 'Machado de Duas Mãos', g: 'm', layers: [px({
      0: '...b............', 1: '.WWB............', 2: 'GWWB............', 3: 'GWWB............',
      4: 'GWWB............', 5: '.WWB............', ...rep(6, 14, '...B............'), 15: '...b............' })] },
  alaude:         { name: 'Alaúde', g: 'm', layers: [px({
      4: '.............WW.', ...rep(5, 8, '.............b..'), 9: '............BBB.',
      10: '...........BBLBB', 11: '...........BBDBB', 12: '...........BBLBB', 13: '............BBB.' })] },
  manoplas:       { name: 'Manoplas', g: 'f', pl: true, layers: [px({
      11: '..WW........WW..', 12: '..WG........GW..', 13: '..ww........ww..' })] },
  cajado_madeira: { name: 'Cajado de Madeira', g: 'm', layers: [px({
      0: '.bBb............', 1: '.BGBg...........', 2: 'gbBb............', 3: '..W.............',
      4: '..Bg............', ...rep(5, 14, '..B.............'), 10: '..W.............', 15: '..b.............' })] },
  foice_sombria:  { name: 'Foice Sombria', g: 'f', layers: [px({
      0: '..DWWWWW........', 1: '..DwwWWWG.......', ...rep(2, 15, '..D.............'),
      3: '..P.............', 8: '..m.............', 13: '..m.............' })] },
  besta:          { name: 'Besta', g: 'f', layers: [px({
      9: '..............W.', 10: '..............W.', 11: '.............LW.', 12: '...........BBBMG',
      13: '.............LW.', 14: '..............W.', 15: '..............W.' })] }
};
const WEAPON_FIXED = { B: '#8A5A2B', b: '#5A3818', M: '#B8C4CF', m: '#56616D', Y: '#E8B923', D: '#232838',
                       L: '#E8F0F0', U: '#2F5FD0', P: '#9B5CFF', g: '#3C9A3C' };
const GRIP_CHARS = 'Bb'; // se a mão estiver sobre esses pixels, ela é redesenhada "segurando" a arma

/* Evolução da arma: a cada WEAPON_LEVEL_STEP níveis sobe um tier */
const WEAPON_LEVEL_STEP = 5;
const WEAPON_TIERS = [
  { id: 'comum',    name: 'COMUM',    W: '#C9D3DC', w: '#7D8A96', G: '#E9F4FF', suffix: { f: 'Comum', m: 'Comum', fp: 'Comuns', mp: 'Comuns' } },
  { id: 'bronze',   name: 'BRONZE',   W: '#D08A45', w: '#8A5426', G: '#FFC48A', suffix: 'de Bronze' },
  { id: 'prata',    name: 'PRATA',    W: '#F0F6FF', w: '#9FB0C8', G: '#FFFFFF', suffix: 'de Prata' },
  { id: 'ouro',     name: 'OURO',     W: '#FFD23A', w: '#B8860B', G: '#FFF3A0', suffix: 'de Ouro' },
  { id: 'lendaria', name: 'LENDÁRIA', W: '#7CFF3A', w: '#1FD1B0', G: '#00F0FF', suffix: { f: 'Lendária', m: 'Lendário', fp: 'Lendárias', mp: 'Lendários' } }
];

/* =====================================================================
   7. CLASSES (12) — arma inicial + bônus passivo de XP por categoria
   ===================================================================== */
const CLASSES = [
  { id: 'guerreiro',  name: 'GUERREIRO',  icon: '⚔️', weapon: 'espada_longa',   bonus: { category: 'fisico',   pct: 0.10 }, desc: 'Mestre do combate corpo a corpo. Força e disciplina acima de tudo.' },
  { id: 'mago',       name: 'MAGO',       icon: '🔮', weapon: 'cajado_arcano',  bonus: { category: 'mental',   pct: 0.10 }, desc: 'Estudioso das artes arcanas. Conhecimento é poder.' },
  { id: 'arqueiro',   name: 'ARQUEIRO',   icon: '🏹', weapon: 'arco_curto',     bonus: { category: 'rotina',   pct: 0.10 }, desc: 'Precisão e paciência. Acerta o alvo todos os dias.' },
  { id: 'ladino',     name: 'LADINO',     icon: '🗡️', weapon: 'adagas_gemeas',  bonus: { category: 'social',   pct: 0.10 }, desc: 'Ágil e astuto. Abre portas com lábia e esperteza.' },
  { id: 'clerigo',    name: 'CLÉRIGO',    icon: '✨', weapon: 'maca_sagrada',   bonus: { category: 'social',   pct: 0.10 }, desc: 'Guia e protege os aliados com fé e cuidado.' },
  { id: 'paladino',   name: 'PALADINO',   icon: '🛡️', weapon: 'espada_escudo',  bonus: { category: 'rotina',   pct: 0.10 }, desc: 'Guerreiro sagrado de honra e constância inabaláveis.' },
  { id: 'barbaro',    name: 'BÁRBARO',    icon: '🪓', weapon: 'machado_duplo',  bonus: { category: 'fisico',   pct: 0.10 }, desc: 'Fúria indomável. Supera seus limites físicos.' },
  { id: 'bardo',      name: 'BARDO',      icon: '🎵', weapon: 'alaude',         bonus: { category: 'criativo', pct: 0.10 }, desc: 'Artista viajante. Inspira com música e histórias.' },
  { id: 'monge',      name: 'MONGE',      icon: '👊', weapon: 'manoplas',       bonus: { category: 'mental',   pct: 0.10 }, desc: 'Corpo e mente em equilíbrio através da meditação.' },
  { id: 'druida',     name: 'DRUIDA',     icon: '🌿', weapon: 'cajado_madeira', bonus: { category: 'criativo', pct: 0.10 }, desc: 'Guardião da natureza. Cria e transforma.' },
  { id: 'necromante', name: 'NECROMANTE', icon: '💀', weapon: 'foice_sombria',  bonus: { category: 'mental',   pct: 0.10 }, desc: 'Desvenda segredos proibidos com estudo profundo.' },
  { id: 'cacador',    name: 'CAÇADOR',    icon: '🎯', weapon: 'besta',          bonus: { category: 'fisico',   pct: 0.10 }, desc: 'Rastreador incansável, forjado na resistência.' }
];

/* Perfil padrão — estrutura salva em state.profile */
const DEFAULT_PROFILE = () => ({
  nome: '', genero: 'f', pele: 1, cabelo: 'longo', corCabelo: 1,
  roupa: 'viajante', corRoupa: 0, classe: 'guerreiro', arma: 'espada_longa'
});

/* =====================================================================
   8. CONSULTAS
   ===================================================================== */
const findIdx = (list, id) => Math.max(0, list.findIndex(x => x.id === id));
const getClass = id => CLASSES.find(c => c.id === id) || CLASSES[0];
const tierForLevel = lvl => Math.min(WEAPON_TIERS.length - 1, Math.floor(lvl / WEAPON_LEVEL_STEP));

const WEAPON_SKINS = {
  neon_cyan: { name: 'Ciano Cyber',   W: '#00F0FF', w: '#0088AA', G: '#E0FFFF' },
  plasma:    { name: 'Plasma Roxo',   W: '#B84DFF', w: '#6A1BB8', G: '#F2D9FF' },
  carmesim:  { name: 'Laser Rubro',   W: '#FF3B2F', w: '#9E140C', G: '#FFD2CC' },
  solar:     { name: 'Fóton Dourado', W: '#FFC21A', w: '#B87400', G: '#FFF8D6' }
};

function getWeaponColors(opts = {}) {
  const skinId = opts.weaponSkin !== undefined ? opts.weaponSkin : (typeof state !== 'undefined' && state?.game?.equippedWeaponSkin);
  if (skinId && WEAPON_SKINS[skinId]) return WEAPON_SKINS[skinId];
  return WEAPON_TIERS[opts.tier ?? tierForLevel(opts.level ?? (typeof state !== 'undefined' && state ? state.level : 1))];
}
function weaponName(weaponId, tierIdx) {
  const w = WEAPONS[weaponId], t = WEAPON_TIERS[tierIdx];
  const suf = typeof t.suffix === 'string' ? t.suffix : t.suffix[w.g + (w.pl ? 'p' : '')];
  return `${w.name} ${suf}`;
}

/** Bônus de classe (0.10 = +10%) para a tarefa */
function classBonusFor(task) {
  if (!state.profile || !task || !task.category) return 0;
  const cls = getClass(state.profile.classe);
  return cls.bonus.category === task.category ? cls.bonus.pct : 0;
}

/** HTML do selo de categoria usado na lista de missões */
function categoryBadge(task) {
  if (!task.category || !CATEGORIES[task.category]) return '';
  const c = CATEGORIES[task.category], b = classBonusFor(task);
  return `<span class="cat-badge">${c.icon} ${c.label}</span>` +
         (b ? `<span class="class-bonus" title="Bônus de classe">${getClass(state.profile.classe).icon} +${Math.round(b * 100)}%</span>` : '');
}

/* =====================================================================
   9. RENDERIZAÇÃO DO SPRITE
   ===================================================================== */
/** Compõe as camadas e devolve uma grade 16x16 de cores (ou null) */
function composeSprite(p, opts = {}) {
  const body   = BODIES[p.genero] || BODIES.m;
  const hair   = HAIR_STYLES[findIdx(HAIR_STYLES, p.cabelo)];
  const outfit = OUTFITS[findIdx(OUTFITS, p.roupa)];
  const cls    = getClass(p.classe);
  const tier   = getWeaponColors(opts);

  const skin = SKIN_TONES[p.pele] || SKIN_TONES[0];
  const hairHex = (HAIR_COLORS[p.corCabelo] || HAIR_COLORS[0]).hex;
  const cloth = (CLOTH_COLORS[p.corRoupa] || CLOTH_COLORS[0]).hex;

  const bodyPal = { S: skin, s: shadeHex(skin, .18), E: '#141A2A', L: '#C4505A', O: shadeHex(skin, .55), D: '#3A2A20' };
  const hairPal = { H: hairHex, h: shadeHex(hairHex, .3), R: '#FF3B2F' };
  const outPal  = { ...OUTFIT_FIXED, C: cloth, c: shadeHex(cloth, .32), A: outfit.accent || shadeHex(cloth, -.35) };
  const wpnPal  = { ...WEAPON_FIXED, W: tier.W, w: tier.w, G: tier.G };

  const grid = Array.from({ length: 16 }, () => Array(16).fill(null));
  const isSkin = (x, y) => !'.OEL'.includes(body.matrix[y][x]);

  // Pinta uma matriz simples (cabelo, corpo, arma)
  const paint = (m, pal, minRow = 0) => {
    for (let y = minRow; y < 16; y++) for (let x = 0; x < 16; x++) {
      const ch = m[y][x];
      if (ch !== '.' && pal[ch]) grid[y][x] = pal[ch];
    }
  };
  // Pinta roupa: letras só sobre a pele; dígitos livremente
  const paintOutfit = m => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const ch = m[y][x];
      if (ch === '.') continue;
      if (OUTFIT_FREE[ch]) grid[y][x] = outPal[OUTFIT_FREE[ch]];
      else if (outPal[ch] && isSkin(x, y)) grid[y][x] = outPal[ch];
    }
  };

  const clip = outfit.hairClip || 0;
  if (hair.back) paint(hair.back, hairPal, clip);
  paint(body.matrix, bodyPal);
  if (outfit.base) paintOutfit(outfit.base);
  paint(hair.front, hairPal, clip);
  if (outfit.over) paintOutfit(outfit.over);

  if (!opts.noWeapon) {
    const handColors = body.hands.map(([x, y]) => grid[y][x]);
    const wpn = WEAPONS[cls.weapon];
    const layers = wpn.layers;
    layers.forEach(m => paint(m, wpnPal));
    // Mãos por cima do cabo (efeito de "segurar")
    body.hands.forEach(([x, y], i) => {
      const onGrip = layers.some(m => GRIP_CHARS.includes(m[y][x]));
      const empty = layers.every(m => m[y][x] === '.');
      if (onGrip || empty) grid[y][x] = handColors[i];
    });
  }
  return grid;
}

/** Grade apenas da arma (para miniaturas) */
function composeWeapon(weaponId, tierIdx, skinOverride) {
  const t = getWeaponColors({ tier: tierIdx, weaponSkin: skinOverride }), pal = { ...WEAPON_FIXED, W: t.W, w: t.w, G: t.G };
  const grid = Array.from({ length: 16 }, () => Array(16).fill(null));
  WEAPONS[weaponId].layers.forEach(m => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (m[y][x] !== '.' && pal[m[y][x]]) grid[y][x] = pal[m[y][x]];
  });
  return grid;
}

/** Desenha a grade num canvas 18x18 (1px de margem p/ o contorno), sem suavização */
function drawGrid(canvas, grid) {
  const S = 18;
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const img = ctx.createImageData(S, S);
  const filled = (x, y) => x >= 1 && y >= 1 && x <= 16 && y <= 16 && grid[y - 1][x - 1];

  // Contorno externo automático: flood fill a partir das bordas
  const outside = Array.from({ length: S }, () => Array(S).fill(false));
  const stack = [];
  for (let i = 0; i < S; i++) stack.push([i, 0], [i, S - 1], [0, i], [S - 1, i]);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= S || y >= S || outside[y][x] || filled(x, y)) continue;
    outside[y][x] = true;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const set = (x, y, hex) => {
    const n = parseInt(hex.slice(1), 16), i = (y * S + x) * 4;
    img.data[i] = n >> 16; img.data[i + 1] = (n >> 8) & 255; img.data[i + 2] = n & 255; img.data[i + 3] = 255;
  };
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const c = filled(x, y);
    if (c) set(x, y, c);
    else if (outside[y][x] && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1))) set(x, y, OUTLINE_COLOR);
  }
  ctx.putImageData(img, 0, 0);
}

/** Desenha o personagem num canvas. opts: { noWeapon, level, tier } */
function drawSprite(canvas, profile, opts = {}) {
  if (!canvas || !profile) return;
  drawGrid(canvas, composeSprite(profile, opts));
  canvas.dataset.tier = opts.noWeapon ? '' : (opts.tier ?? tierForLevel(opts.level ?? state.level));
}
function drawWeapon(canvas, weaponId, tierIdx, skinOverride) {
  drawGrid(canvas, composeWeapon(weaponId, tierIdx, skinOverride));
  canvas.dataset.tier = tierIdx;
}

/* =====================================================================
   10. EDITOR DE PERSONAGEM (criação e edição)
   ===================================================================== */
let charDraft = null;
let charMode = 'create'; // 'create' | 'edit'

/** Definição genérica das linhas do editor (fácil de expandir) */
const EDITOR_OPTIONS = [
  { key: 'genero', label: 'GÊNERO', thumb: 'sprite', items: GENDERS,
    name: it => it.label, get: d => findIdx(GENDERS, d.genero), set: (d, i) => { d.genero = GENDERS[i].id; } },
  { key: 'pele', label: 'COR DE PELE', thumb: 'swatch', items: SKIN_TONES,
    name: (it, i) => `TOM ${i + 1}`, color: it => it, get: d => d.pele, set: (d, i) => { d.pele = i; } },
  { key: 'cabelo', label: 'CABELO', thumb: 'sprite', noWeapon: true, items: HAIR_STYLES,
    name: it => it.name, get: d => findIdx(HAIR_STYLES, d.cabelo), set: (d, i) => { d.cabelo = HAIR_STYLES[i].id; } },
  { key: 'corCabelo', label: 'COR DO CABELO', thumb: 'swatch', items: HAIR_COLORS,
    name: it => it.name, color: it => it.hex, get: d => d.corCabelo, set: (d, i) => { d.corCabelo = i; } },
  { key: 'roupa', label: 'ROUPA', thumb: 'sprite', noWeapon: true, items: OUTFITS,
    name: it => it.name, get: d => findIdx(OUTFITS, d.roupa), set: (d, i) => { d.roupa = OUTFITS[i].id; } },
  { key: 'corRoupa', label: 'COR DA ROUPA', thumb: 'swatch', items: CLOTH_COLORS,
    name: it => it.name, color: it => it.hex, get: d => d.corRoupa, set: (d, i) => { d.corRoupa = i; } },
  { key: 'classe', label: 'CLASSE', thumb: 'icon', items: CLASSES,
    name: it => it.name, icon: it => it.icon, get: d => findIdx(CLASSES, d.classe),
    set: (d, i) => { d.classe = CLASSES[i].id; d.arma = CLASSES[i].weapon; } }
];

/* ---------- Armário (wardrobe): categorias + carrossel giratório ---------- */
const WARDROBE_ICONS = { genero: '⚥', pele: '✋', cabelo: '💇', corCabelo: '🧪', roupa: '👕', corRoupa: '🎨', classe: '⚔️' };
let wardrobeCat = EDITOR_OPTIONS[0].key;

/** Espaçamento horizontal entre os itens do carrossel, proporcional à largura */
function wardrobeSpacing(car) {
  return Math.max(54, Math.min(112, (car?.clientWidth || 320) * 0.2));
}

/** Monta a estrutura do armário uma vez */
function buildEditor() {
  $('#charOptions').innerHTML = `
    <div class="wr-cats" role="tablist" aria-label="Categorias do armário">
      ${EDITOR_OPTIONS.map(o => `
        <button type="button" class="wr-cat" role="tab" data-cat="${o.key}">
          <span class="wr-cat-ico">${WARDROBE_ICONS[o.key] || '•'}</span>
          <span class="wr-cat-txt">${o.label}</span>
        </button>`).join('')}
    </div>
    <div class="wr-closet">
      <div class="wr-closet-head">
        <span class="wr-closet-label" id="wrLabel"></span>
        <span class="wr-count" id="wrCount"></span>
      </div>
      <div class="wr-carousel" id="wrCarousel">
        <div class="wr-rail"></div>
        <div class="wr-track" id="wrTrack"></div>
      </div>
      <div class="wr-ctrl">
        <button type="button" class="arrow wr-arrow" data-dir="-1" aria-label="Anterior">◀</button>
        <div class="wr-name" id="wrName"></div>
        <button type="button" class="arrow wr-arrow" data-dir="1" aria-label="Próximo">▶</button>
      </div>
      <div class="wr-hint">ARRASTE PARA GIRAR • TOQUE PARA VESTIR</div>
    </div>`;
  renderWardrobeTrack();
}

/** (Re)cria os itens do carrossel da categoria ativa */
function renderWardrobeTrack() {
  const o = EDITOR_OPTIONS.find(x => x.key === wardrobeCat);
  const track = $('#wrTrack');
  if (!o || !track) return;
  track.className = `wr-track type-${o.thumb}`;
  track.innerHTML = o.items.map((it, i) => {
    const title = escapeHTML(o.name(it, i));
    const inner = o.thumb === 'sprite'
      ? '<span class="wr-hanger"></span><canvas class="sprite"></canvas>'
      : o.thumb === 'swatch'
      ? `<span class="wr-hanger"></span><span class="wr-sw" style="background:${o.color(it)}"></span>`
      : `<span class="wr-ico">${o.icon(it)}</span><small>${title}</small>`;
    return `<button type="button" class="wr-item" data-i="${i}" title="${title}" aria-label="${title}">${inner}<span class="wr-lock">🔒</span></button>`;
  }).join('');
}

/** Distância circular mais curta entre o item i e o selecionado */
function wardrobeOffset(i, cur, n) {
  let off = i - cur;
  if (off > n / 2) off -= n;
  if (off < -n / 2) off += n;
  return off;
}

/** Posiciona os itens em arco 3D (estilo vitrine/armário giratório) */
function layoutWardrobe() {
  const o = EDITOR_OPTIONS.find(x => x.key === wardrobeCat);
  const car = $('#wrCarousel');
  if (!o || !car || !charDraft) return;
  const n = o.items.length;
  const cur = o.get(charDraft);
  const sp = wardrobeSpacing(car);
  car.querySelectorAll('.wr-item').forEach(el => {
    const i = +el.dataset.i;
    const off = wardrobeOffset(i, cur, n);
    const abs = Math.abs(off);
    const visible = abs <= 3;
    el.style.transform = `translate(-50%, -50%) translateX(${off * sp}px) translateZ(${-abs * 70}px) rotateY(${off * -34}deg) scale(${Math.max(0.5, 1 - abs * 0.17)})`;
    el.style.opacity = visible ? String(1 - abs * 0.24) : '0';
    el.style.zIndex = String(10 - abs);
    el.style.pointerEvents = visible ? 'auto' : 'none';
    el.classList.toggle('sel', off === 0);
    el.classList.toggle('locked', o.key === 'roupa' && !isOutfitUnlocked(o.items[i].id));
    el.tabIndex = off === 0 ? 0 : -1;
  });
}

function isOutfitUnlocked(id) {
  const o = OUTFITS.find(x => x.id === id);
  if (!o || !o.shopOnly) return true;
  return !!(typeof state !== 'undefined' && state?.game?.unlockedOutfits?.includes(id));
}

/** Gira o personagem no pedestal quando uma peça é trocada */
function spinPreview(dir = 1) {
  const sp = $('#charSpin');
  if (!sp) return;
  sp.classList.remove('spin-l', 'spin-r');
  void sp.offsetWidth;
  sp.classList.add(dir < 0 ? 'spin-l' : 'spin-r');
}

/** Atualiza prévia, categoria ativa, carrossel e cartão da classe */
function refreshEditor() {
  const d = charDraft;
  drawSprite($('#charPreview'), d, { level: state.level });

  const o = EDITOR_OPTIONS.find(x => x.key === wardrobeCat);
  document.querySelectorAll('.wr-cat').forEach(b => {
    const on = b.dataset.cat === wardrobeCat;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const i = o.get(d), it = o.items[i];
  $('#wrLabel').textContent = o.label;
  $('#wrCount').textContent = `${i + 1}/${o.items.length}`;
  $('#wrName').textContent = o.name(it, i);

  if (o.thumb === 'sprite') {
    document.querySelectorAll('#wrTrack .wr-item').forEach(el => {
      const v = { ...d }; o.set(v, +el.dataset.i);
      drawSprite(el.querySelector('canvas'), v, { noWeapon: o.noWeapon });
    });
  }
  layoutWardrobe();
  renderClassCard($('#classCard'), d.classe, tierForLevel(state.level));
}

function selectWardrobeCat(key) {
  if (!EDITOR_OPTIONS.some(o => o.key === key)) return;
  wardrobeCat = key;
  renderWardrobeTrack();
  refreshEditor();
  const btn = document.querySelector(`.wr-cat[data-cat="${key}"]`);
  const bar = btn?.parentElement;
  if (btn && bar && bar.scrollWidth > bar.clientWidth) {
    bar.scrollTo({ left: btn.offsetLeft - (bar.clientWidth - btn.offsetWidth) / 2, behavior: 'smooth' });
  }
}

/** Eventos do armário: categorias, setas, toque nos itens, arrastar, roda do mouse e teclado */
function bindWardrobe() {
  const root = $('#charOptions');
  const step = dir => {
    const o = EDITOR_OPTIONS.find(x => x.key === wardrobeCat);
    changeOption(o.key, o.get(charDraft) + dir, dir);
  };

  let drag = null;
  let suppressClick = false;

  root.addEventListener('click', e => {
    const cat = e.target.closest('[data-cat]');
    if (cat) { selectWardrobeCat(cat.dataset.cat); return; }
    const arr = e.target.closest('.wr-arrow');
    if (arr) { step(+arr.dataset.dir); return; }
    const item = e.target.closest('.wr-item');
    if (item) {
      if (suppressClick) { suppressClick = false; return; }
      const o = EDITOR_OPTIONS.find(x => x.key === wardrobeCat);
      const cur = o.get(charDraft);
      const target = +item.dataset.i;
      if (target === cur) return;
      const dir = Math.sign(wardrobeOffset(target, cur, o.items.length)) || 1;
      changeOption(o.key, target, 0);
      if (o.get(charDraft) === target) spinPreview(dir);
    }
  });

  const car = $('#wrCarousel');
  car.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, id: e.pointerId, moved: false };
  });
  car.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (Math.abs(e.clientX - drag.x) > 8) drag.moved = true;
  });
  const endDrag = e => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const moved = drag.moved;
    drag = null;
    if (!moved || Math.abs(dx) < 28) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 60);
    const steps = Math.max(1, Math.min(3, Math.round(Math.abs(dx) / wardrobeSpacing(car))));
    step(dx < 0 ? steps : -steps);
  };
  car.addEventListener('pointerup', endDrag);
  car.addEventListener('pointercancel', () => { drag = null; });

  // Roda do mouse / trackpad gira o carrossel no computador
  let wheelLock = 0;
  car.addEventListener('wheel', e => {
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 4) return;
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLock < 180) return;
    wheelLock = now;
    step(d > 0 ? 1 : -1);
  }, { passive: false });

  // Teclado: ← → trocam a peça, ↑ ↓ trocam a categoria
  document.addEventListener('keydown', e => {
    if (!$('#charScreen').classList.contains('open')) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = EDITOR_OPTIONS.findIndex(o => o.key === wardrobeCat);
      const n = EDITOR_OPTIONS.length;
      selectWardrobeCat(EDITOR_OPTIONS[(idx + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].key);
    }
  });

  window.addEventListener('resize', () => {
    if ($('#charScreen').classList.contains('open')) layoutWardrobe();
  });
}

/** Cartão com ícone, descrição, arma e bônus da classe */
function renderClassCard(el, classId, tierIdx) {
  const c = getClass(classId), cat = CATEGORIES[c.bonus.category];
  el.innerHTML = `
    <div class="cc-head"><span class="cc-icon">${c.icon}</span><div><b>${c.name}</b><small>${escapeHTML(c.desc)}</small></div></div>
    <div class="cc-weapon"><canvas class="sprite"></canvas>
      <div><small>ARMA</small><b>${escapeHTML(weaponName(c.weapon, tierIdx)).toUpperCase()}</b>
      <span class="cc-bonus">+${Math.round(c.bonus.pct * 100)}% XP EM TAREFAS ${cat.icon} ${cat.label}</span></div>
    </div>`;
  drawWeapon(el.querySelector('canvas'), c.weapon, tierIdx);
}

function openCharEditor(mode) {
  charMode = mode;
  charDraft = mode === 'edit' && state.profile ? { ...state.profile } : DEFAULT_PROFILE();
  $('#charName').value = charDraft.nome || '';
  $('#charTitle').textContent = mode === 'edit' ? 'EDITAR PERSONAGEM' : 'CRIAÇÃO DE PERSONAGEM';
  $('#charSub').textContent = mode === 'edit'
    ? 'AJUSTE A APARÊNCIA. TROCAR DE CLASSE EXIGE CONFIRMAÇÃO.'
    : 'BEM-VINDO AO SISTEMA. CRIE SEU AVATAR PARA INICIAR.';
  $('#charConfirm').textContent = mode === 'edit' ? 'SALVAR ALTERAÇÕES' : 'INICIAR JORNADA';
  $('#charCancel').classList.toggle('hidden', mode !== 'edit');
  $('#charScreen').classList.add('open');
  document.body.classList.add('no-scroll');
  wardrobeCat = EDITOR_OPTIONS[0].key;
  renderWardrobeTrack();
  refreshEditor();
  // Recalcula o arco depois que o layout da tela aberta estiver pronto
  requestAnimationFrame(layoutWardrobe);
}
function closeCharEditor() {
  $('#charScreen').classList.remove('open');
  document.body.classList.remove('no-scroll');
}

function changeOption(key, i, dir = 1) {
  const o = EDITOR_OPTIONS.find(x => x.key === key);
  const n = o.items.length;
  let idx = ((i % n) + n) % n;
  if (key === 'roupa' && !isOutfitUnlocked(o.items[idx].id)) {
    if (dir !== 0) {
      for (let step = 0; step < n; step++) {
        if (isOutfitUnlocked(o.items[idx].id)) break;
        idx = ((idx + dir) % n + n) % n;
      }
    } else {
      toast('TRAJE BLOQUEADO! COMPRE NA LOJA DA CIDADE OU DERROTE O BOSS.', true);
      return;
    }
  }
  const before = o.get(charDraft);
  o.set(charDraft, idx);
  if (dir !== 0 && idx !== before) spinPreview(dir);
  refreshEditor();
}

function randomizeChar() {
  EDITOR_OPTIONS.forEach(o => {
    if (o.key === 'roupa') {
      const avail = o.items.map((it, idx) => idx).filter(idx => isOutfitUnlocked(o.items[idx].id));
      o.set(charDraft, avail[Math.floor(Math.random() * avail.length)] || 0);
    } else {
      o.set(charDraft, Math.floor(Math.random() * o.items.length));
    }
  });
  spinPreview(1);
  refreshEditor();
}
function resetChar() {
  const nome = $('#charName').value;
  const keepClass = charMode === 'edit' ? { classe: state.profile.classe, arma: state.profile.arma } : {};
  charDraft = { ...DEFAULT_PROFILE(), ...keepClass, nome };
  spinPreview(-1);
  refreshEditor();
}

async function confirmChar() {
  if (!navigator.onLine) { toast('VOCÊ ESTÁ OFFLINE. CONECTE-SE PARA SALVAR O PERSONAGEM NO BANCO.', true); return; }
  const nome = $('#charName').value.trim().slice(0, 16);
  if (!nome) { toast('DIGITE O NOME DO PERSONAGEM.', true); $('#charName').focus(); return; }
  const cls = getClass(charDraft.classe);

  if (charMode === 'edit' && state.profile.classe !== charDraft.classe) {
    const old = getClass(state.profile.classe);
    if (!confirm(`Trocar de classe?\n\n${old.name} → ${cls.name}\nSua arma passará a ser: ${WEAPONS[cls.weapon].name}.\nO bônus de XP também muda.`)) return;
  }

  const btn = $('#charConfirm');
  const origTxt = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'SINCRONIZANDO...';

  try {
    const isNew = !state.profile;
    const newProfile = { ...charDraft, nome, arma: cls.weapon, criadoEm: state.profile?.criadoEm || todayKey() };
    if (window.currentUser && window.SB?.perfil) {
      await window.SB.perfil.salvarPersonagem(window.currentUser.id, newProfile, state.level);
    }
    state.profile = newProfile;
    saveState();
    closeCharEditor();
    renderAll();
    if ($('#profileModal').classList.contains('open')) renderProfile();
    toast(isNew ? `BEM-VINDO(A), ${nome.toUpperCase()}! A JORNADA COMEÇOU.` : 'PERSONAGEM ATUALIZADO NO SERVIDOR.');
    if (isNew) playSound('levelup');
  } catch (err) {
    toast(err.message || 'ERRO AO SALVAR PERSONAGEM NO BANCO.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = origTxt;
  }
}

/* =====================================================================
   11. AVATAR NO PAINEL + TELA DE PERFIL
   ===================================================================== */
function renderAvatar() {
  const btn = $('#avatarBtn');
  if (!btn) return;
  btn.classList.toggle('hidden', !state.profile);
  if (!state.profile) return;
  drawSprite($('#avatarCanvas'), state.profile);
  $('#avatarName').textContent = state.profile.nome;
}

function renderProfile() {
  const p = state.profile;
  if (!p) return;
  const c = getClass(p.classe), tier = tierForLevel(state.level), cat = CATEGORIES[c.bonus.category];
  const nextLvl = tier < WEAPON_TIERS.length - 1 ? (tier + 1) * WEAPON_LEVEL_STEP : null;
  const g = state.game || {};
  const skinInfo = g.equippedWeaponSkin && WEAPON_SKINS[g.equippedWeaponSkin] ? ` • SKIN ${WEAPON_SKINS[g.equippedWeaponSkin].name.toUpperCase()}` : '';
  drawSprite($('#profileSprite'), p);
  $('#profileName').textContent = p.nome;
  $('#profileInfo').innerHTML = `
    <div class="pf-class"><span class="cc-icon">${c.icon}</span>
      <div><small>CLASSE</small><b>${c.name}</b><p>${escapeHTML(c.desc)}</p>
      <span class="cc-bonus">+${Math.round(c.bonus.pct * 100)}% XP EM TAREFAS ${cat.icon} ${cat.label}</span></div></div>
    <div class="pf-weapon"><canvas class="sprite" id="profileWeapon"></canvas>
      <div><small>ARMA • TIER ${WEAPON_TIERS[tier].name}${skinInfo}</small><b class="tier-txt t${tier}">${escapeHTML(weaponName(c.weapon, tier)).toUpperCase()}</b>
        <div class="tier-track">${WEAPON_TIERS.map((t, i) => `<span class="${i <= tier ? 'on t' + i : ''}" title="${t.name} (NÍVEL ${i * WEAPON_LEVEL_STEP || 1})"></span>`).join('')}</div>
        <small>${nextLvl ? `PRÓXIMA EVOLUÇÃO NO NÍVEL ${nextLvl}` : 'EVOLUÇÃO MÁXIMA ALCANÇADA!'}</small></div></div>
    <div class="pf-stats">
      <div><small>NÍVEL</small><b>${state.level}</b></div>
      <div><small>XP TOTAL</small><b>${state.totalXP}</b></div>
      <div><small>SEQUÊNCIA</small><b>${effectiveStreak()} 🔥</b></div>
      <div><small>MISSÕES CONCLUÍDAS</small><b>${state.records.length}</b></div>
      <div><small>PARTIDAS JOGADAS</small><b>${g.matchesPlayed || 0} 🎮</b></div>
      <div><small>INIMIGOS DERROTADOS</small><b>${g.enemiesDefeated || 0} 💼</b></div>
      <div><small>BOSSES VENCIDOS</small><b>${g.bossesDefeated || 0} 🤖</b></div>
      <div><small>RECORDE DISTÂNCIA</small><b>${g.bestDistance || 0}m</b></div>
    </div>`;
  drawWeapon($('#profileWeapon'), c.weapon, tier);
}
function openProfile() {
  renderProfile();
  openModal('profileModal');
}

/* =====================================================================
   12. LEVEL UP — personagem comemorando
   ===================================================================== */
function celebrateCharacter(prevLevel) {
  const cv = $('#levelUpSprite'), info = $('#weaponUp');
  if (!state.profile) { cv.classList.add('hidden'); info.classList.add('hidden'); return; }
  cv.classList.remove('hidden');
  drawSprite(cv, state.profile);
  cv.classList.remove('celebrate'); void cv.offsetWidth; cv.classList.add('celebrate');
  const before = tierForLevel(prevLevel), after = tierForLevel(state.level);
  info.classList.toggle('hidden', after <= before);
  if (after > before) info.textContent = `⚡ ARMA EVOLUIU: ${weaponName(getClass(state.profile.classe).weapon, after).toUpperCase()}`;
}

/* =====================================================================
   13. INICIALIZAÇÃO DO MÓDULO
   ===================================================================== */
function initCharacter() {
  // Opções de categoria no modal de tarefas
  const sel = $('#taskCategory');
  if (sel) sel.innerHTML = Object.entries(CATEGORIES).map(([k, c]) => `<option value="${k}">${c.icon} ${c.label}</option>`).join('');

  buildEditor();

  bindWardrobe();
  $('#charName').addEventListener('input', e => { charDraft.nome = e.target.value; });
  $('#charRandom').addEventListener('click', randomizeChar);
  $('#charReset').addEventListener('click', resetChar);
  $('#charConfirm').addEventListener('click', confirmChar);
  $('#charCancel').addEventListener('click', closeCharEditor);
  $('#avatarBtn').addEventListener('click', openProfile);
  $('#editCharBtn').addEventListener('click', () => { closeModal('profileModal'); openCharEditor('edit'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && charMode === 'edit' && $('#charScreen').classList.contains('open')) closeCharEditor();
  });

  renderAvatar();
  // A abertura automática da criação de personagem é controlada após o login no Supabase (script.js)
}
