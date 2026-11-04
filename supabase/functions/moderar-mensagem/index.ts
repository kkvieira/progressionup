// =============================================================================
// EDGE FUNCTION: `moderar-mensagem` (Deno / TypeScript)
// -----------------------------------------------------------------------------
// Acionada por Database Webhook (INSERT em `public.messages`) ou chamada via
// `supabase.functions.invoke('moderar-mensagem')`.
// - Filtra palavrões (PT/EN) e links suspeitos/encurtadores/phishing.
// - Mascaramento automático de termos ofensivos (`***`) e marcação de
//   `flagged_for_review = true` + `moderation_reason` usando a chave de
//   serviço injetada exclusivamente nos secrets da Edge Function
//   (`SUPABASE_SERVICE_ROLE_KEY`).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
};

const BANNED_WORDS = [
  'caralho', 'porra', 'puta', 'fdp', 'arrombado', 'desgracado', 'babaca',
  'otario', 'imbecil', 'retardado', 'scam', 'keylogger', 'trojan'
];

const SUSPICIOUS_URL_REGEX = /(https?:\/\/[^\s]*(bit\.ly|tinyurl\.com|cutt\.ly|grabify|iplogger|free-nitro|steamcommunnity)|discord\.gg\/[^\s]+)/i;

interface WebhookPayload {
  type?: 'INSERT' | 'UPDATE';
  table?: string;
  schema?: string;
  record?: {
    id: string;
    conversation_id: string;
    sender_id: string | null;
    content: string;
    is_system?: boolean;
    flagged_for_review?: boolean;
  };
  message_id?: string;
  content?: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const webhookSecret = Deno.env.get('MODERATION_WEBHOOK_SECRET') ?? '';

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'Variáveis SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY ausentes no ambiente.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Se houver segredo configurado para o Database Webhook, valida o cabeçalho
    if (webhookSecret) {
      const incomingSecret = req.headers.get('x-webhook-secret') ?? '';
      if (incomingSecret && incomingSecret !== webhookSecret) {
        return new Response(JSON.stringify({ error: 'Webhook secret inválido.' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    const body: WebhookPayload = await req.json();
    const record = body.record ?? (body.message_id ? {
      id: body.message_id,
      conversation_id: '',
      sender_id: null,
      content: body.content ?? ''
    } : null);

    if (!record || !record.id || !record.content || record.is_system) {
      return new Response(
        JSON.stringify({ status: 'skipped', reason: 'Sem registro de usuário para moderar.' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    let sanitizedContent = record.content;
    const reasons: string[] = [];

    // 1. Verifica links suspeitos / phishing
    if (SUSPICIOUS_URL_REGEX.test(sanitizedContent)) {
      reasons.push('LINK_SUSPEITO');
      sanitizedContent = sanitizedContent.replace(SUSPICIOUS_URL_REGEX, '[LINK BLOQUEADO PELA MODERAÇÃO]');
    }

    // 2. Verifica lista de palavrões e aplica máscara
    for (const word of BANNED_WORDS) {
      const rx = new RegExp(`\\b${word}\\b`, 'gi');
      if (rx.test(sanitizedContent)) {
        if (!reasons.includes('LINGUAGEM_IMPROPRIA')) {
          reasons.push('LINGUAGEM_IMPROPRIA');
        }
        sanitizedContent = sanitizedContent.replace(rx, '***');
      }
    }

    if (reasons.length === 0) {
      return new Response(
        JSON.stringify({ status: 'clean', message_id: record.id }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const reasonText = reasons.join(', ');

    const { error: updateErr } = await adminClient
      .from('messages')
      .update({
        content: sanitizedContent,
        flagged_for_review: true,
        moderation_reason: reasonText
      })
      .eq('id', record.id);

    if (updateErr) {
      throw updateErr;
    }

    // Registra automaticamente em `reports` para fila de moderadores se houver sender_id
    if (record.sender_id) {
      await adminClient.from('reports').insert({
        reporter_id: record.sender_id,
        reported_user_id: record.sender_id,
        message_id: record.id,
        reason: `Auto-Moderação Edge Function: ${reasonText}`,
        status: 'pending'
      });
    }

    return new Response(
      JSON.stringify({
        status: 'flagged',
        message_id: record.id,
        reasons,
        sanitizedContent
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message || 'Erro interno na moderação.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
