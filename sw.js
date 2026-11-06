/* =====================================================================
   SERVICE WORKER — Sistema de Missões (PWA)
   - Arquivos do próprio site: rede primeiro (sempre pega a versão nova
     publicada na Vercel) e usa o cache só quando estiver sem internet.
   - Fontes e biblioteca do Supabase (CDN): cache rápido + atualização em segundo plano.
   - Chamadas ao Supabase (login, banco, realtime) NUNCA passam pelo cache.
   Ao mudar a lista de arquivos, aumente a versão abaixo.
   ===================================================================== */
const VERSION = 'v1';
const CACHE = `missoes-${VERSION}`;

const APP_SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'css/character.css',
  'css/game.css',
  'js/env.js',
  'js/supabase.js',
  'js/services/amigos.js',
  'js/services/chat.js',
  'js/services/ranking.js',
  'js/services/grupos.js',
  'js/services/multiplayer.js',
  'js/character.js',
  'js/game.js',
  'js/script.js',
  'js/pwa.js',
  'img/favicon.png',
  'img/fundo.jpg',
  'img/icons/icon-192.png',
  'img/icons/icon-512.png',
  'img/icons/apple-touch-icon.png'
];

const CDN_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdn.jsdelivr.net'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' evita pegar uma cópia velha do cache HTTP do navegador
      .then(cache => Promise.allSettled(APP_SHELL.map(url => cache.add(new Request(url, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('missoes-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Mesmo domínio: rede primeiro, cache como reserva offline
  if (url.origin === self.location.origin) {
    // Navegação (inclui retorno do login social com ?code=...): sempre rede,
    // e se estiver offline devolve a página principal salva.
    if (req.mode === 'navigate') {
      event.respondWith(
        fetch(req).catch(() => caches.match('index.html').then(r => r || caches.match('./')))
      );
      return;
    }
    event.respondWith(networkFirst(req));
    return;
  }

  // Fontes e supabase-js da CDN
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
  // Todo o resto (Supabase API, Auth, Storage, Realtime) segue direto para a rede.
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req);
  const network = fetch(req)
    .then(res => {
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || network;
}
