// =============================================================================
// EDGE FUNCTION: `notificar` (Deno / TypeScript)
// -----------------------------------------------------------------------------
// Cria notificações em tempo real (pedido de amizade, convite de grupo,
// subida de nível de um amigo, conclusão de meta) e mensagens de sistema no
// chat do grupo (nível, boss derrotado, metas).
// Nenhuma `service_role` key fica exposta no front-end: a função lê
// `SUPABASE_SERVICE_ROLE_KEY` dos secrets do ambiente Deno e valida o JWT
// do agente chamador (ou segredo de webhook).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
};

interface NotifyRequest {
  event_type:
    | 'friend_request'
    | 'group_invite'
    | 'friend_levelup'
    | 'group_boss_defeated'
    | 'group_goal_completed'
    | 'coop_invite';
  target_user_id?: string;
  group_id?: string;
  titulo?: string;
  mensagem?: string;
  payload?: Record<string, unknown>;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    if (!supabaseUrl || !serviceRoleKey) {
      return new Response(
        JSON.stringify({ error: 'Configuração de secrets incompleta na Edge Function.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Valida usuário autenticado via cabeçalho Authorization
    const authHeader = req.headers.get('Authorization') ?? '';
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false }
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response(
        JSON.stringify({ error: 'NAO_AUTENTICADO: Token JWT inválido ou ausente.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const caller = userData.user;
    const body: NotifyRequest = await req.json();

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const { data: callerProf } = await adminClient
      .from('profiles')
      .select('id, username, level')
      .eq('id', caller.id)
      .maybeSingle();

    const callerName = callerProf?.username || 'agente';
    let notificationsCreated = 0;
    let systemMessageCreated = false;

    // 1. Notificação direta para um usuário específico (pedido de amizade, convite de grupo, convite coop)
    if (body.target_user_id && ['friend_request', 'group_invite', 'coop_invite'].includes(body.event_type)) {
      const { error: notifErr } = await adminClient.from('notifications').insert({
        user_id: body.target_user_id,
        tipo: body.event_type,
        titulo: body.titulo || 'NOVA NOTIFICAÇÃO DO SISTEMA',
        mensagem: body.mensagem || `O agente @${callerName} enviou um alerta para você.`,
        payload: { ...(body.payload || {}), from_user_id: caller.id, from_username: callerName }
      });
      if (!notifErr) notificationsCreated++;
    }

    // 2. Subida de nível: notifica todos os amigos aceitos + mensagem no chat do grupo
    if (body.event_type === 'friend_levelup') {
      const newLevel = Number(body.payload?.level || callerProf?.level || 2);
      const { data: friendships } = await adminClient
        .from('friendships')
        .select('requester_id, addressee_id')
        .eq('status', 'accepted')
        .or(`requester_id.eq.${caller.id},addressee_id.eq.${caller.id}`);

      if (friendships && friendships.length > 0) {
        const rows = friendships.map((f) => {
          const friendId = f.requester_id === caller.id ? f.addressee_id : f.requester_id;
          return {
            user_id: friendId,
            tipo: 'friend_levelup',
            titulo: 'ALIADO SUBIU DE NÍVEL!',
            mensagem: `Seu aliado @${callerName} alcançou o NÍVEL ${newLevel}!`,
            payload: { friend_id: caller.id, username: callerName, new_level: newLevel }
          };
        });
        const { error: batchErr } = await adminClient.from('notifications').insert(rows);
        if (!batchErr) notificationsCreated += rows.length;
      }

      // Mensagem de sistema no grupo do agente
      const { data: gm } = await adminClient
        .from('group_members')
        .select('group_id')
        .eq('user_id', caller.id)
        .maybeSingle();

      if (gm?.group_id) {
        const { data: conv } = await adminClient
          .from('conversations')
          .select('id')
          .eq('group_id', gm.group_id)
          .maybeSingle();

        if (conv?.id) {
          await adminClient.from('messages').insert({
            conversation_id: conv.id,
            sender_id: caller.id,
            content: `⚡ LEVEL UP! O agente @${callerName} subiu para o NÍVEL ${newLevel}!`,
            is_system: true
          });
          systemMessageCreated = true;
        }
      }
    }

    // 3. Eventos de grupo (boss derrotado ou meta atingida)
    if (body.group_id && ['group_boss_defeated', 'group_goal_completed'].includes(body.event_type)) {
      const { data: conv } = await adminClient
        .from('conversations')
        .select('id')
        .eq('group_id', body.group_id)
        .maybeSingle();

      if (conv?.id) {
        const sysText =
          body.mensagem ||
          (body.event_type === 'group_boss_defeated'
            ? `🤖 O agente @${callerName} derrotou um Mecha-Boss na Cidade pelo esquadrão!`
            : `🏆 Meta semanal do esquadrão concluída com participação de @${callerName}!`);

        await adminClient.from('messages').insert({
          conversation_id: conv.id,
          sender_id: caller.id,
          content: sysText.slice(0, 500),
          is_system: true
        });
        systemMessageCreated = true;
      }
    }

    return new Response(
      JSON.stringify({
        status: 'ok',
        notificationsCreated,
        systemMessageCreated
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message || 'Erro ao processar notificação.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
