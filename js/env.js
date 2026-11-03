/* =====================================================================
   Sistema de Missões — CONFIGURAÇÃO DE AMBIENTE (.env para Navegador)
   ---------------------------------------------------------------------
   Conectado ao projeto Supabase: pbqgfsgouqvubofphevk
   NUNCA coloque a `service_role` key no front-end!
   Usa exclusivamente a chave pública (`anon` / publishable key).
   ===================================================================== */
window.__ENV__ = {
  SUPABASE_URL: 'https://pbqgfsgouqvubofphevk.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBicWdmc2dvdXF2dWJvZnBoZXZrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM3MTE2NTIsImV4cCI6MjEwOTI4NzY1Mn0.-gsocO60D5h5xldXvNG9PAvk4fRGLTYpn7hbVLzMR10'
};

// Limpa eventuais chaves incorretas salvas manualmente no localStorage
try {
  localStorage.removeItem('sistemaMissoes.supabaseUrl');
  localStorage.removeItem('sistemaMissoes.supabaseAnonKey');
} catch (_) {}
