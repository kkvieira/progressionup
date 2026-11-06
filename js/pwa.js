/* =====================================================================
   PWA — registro do Service Worker e botão "Instalar App"
   ===================================================================== */
(function () {
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  const ua = navigator.userAgent || '';
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  let deferredPrompt = null;

  function installButtons() {
    return document.querySelectorAll('[data-pwa-install]');
  }

  function showButtons(show) {
    installButtons().forEach(btn => btn.classList.toggle('hidden', !show));
  }

  function openIOSHelp() {
    const modal = document.getElementById('pwaIosModal');
    if (modal) modal.classList.add('open');
  }

  function closeIOSHelp() {
    const modal = document.getElementById('pwaIosModal');
    if (modal) modal.classList.remove('open');
  }

  async function handleInstallClick() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (_) { /* ignorado */ }
      deferredPrompt = null;
      showButtons(false);
      return;
    }
    if (isIOS) openIOSHelp();
  }

  // Chrome / Edge / Android: o navegador avisa que o app pode ser instalado
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    if (!isStandalone()) showButtons(true);
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    showButtons(false);
    if (typeof window.toast === 'function') window.toast('APP INSTALADO! PROCURE O ÍCONE NA SUA TELA INICIAL.');
  });

  document.addEventListener('DOMContentLoaded', () => {
    if (isStandalone()) document.documentElement.classList.add('pwa-standalone');

    installButtons().forEach(btn => btn.addEventListener('click', handleInstallClick));
    document.querySelectorAll('[data-pwa-ios-close]').forEach(btn => btn.addEventListener('click', closeIOSHelp));

    // iPhone/iPad não tem prompt automático: mostra o botão com instruções
    if (isIOS && !isStandalone()) showButtons(true);
  });

  // Registro do Service Worker (só funciona em HTTPS ou localhost)
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('[PWA] Falha ao registrar service worker:', err));
    });
  }
})();
