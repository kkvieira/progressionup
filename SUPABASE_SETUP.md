# Guia Completo do Supabase (Social, Chat, Esquadrões, Rankings & Multiplayer Co-op)

Este documento reúne os comandos da **Supabase CLI**, o passo a passo no **Painel do Supabase** (PostgreSQL, Auth, Realtime Authorization, Storage, Edge Functions e `pg_cron`) e o roteiro de testes manuais e automatizados de RLS.

---

## 1. Estrutura da Pasta `supabase/`

- [`supabase/migrations/001_initial_schema.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/migrations/001_initial_schema.sql) — Tabelas base (`profiles`, `characters`, `tasks`, `task_logs`, `achievements`, `user_achievements`, `game_runs`, `inventory`) e bucket privado `registros`.
- [`supabase/migrations/002_social_multiplayer_schema.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/migrations/002_social_multiplayer_schema.sql) — Tabelas sociais e multiplayer (`friendships`, `blocks`, `user_roles`, `conversations`, `conversation_members`, `messages`, `message_reads`, `groups`, `group_members`, `group_invites`, `group_goals`, `seasons`, `season_results`, `game_rooms`, `game_room_players`, `reports`, `notifications`), view segura `public_profiles` e as 6 views de ranking (`v_rank_xp`, `v_rank_streak`, `v_rank_missions_week`, `v_rank_distance`, `v_rank_bosses`, `v_rank_groups`).
- [`supabase/migrations/003_social_rls_policies.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/migrations/003_social_rls_policies.sql) — Funções auxiliares `SECURITY DEFINER` com `search_path = public` (`is_member`, `has_group_role`, `is_blocked_between`, `are_friends`, `is_moderator`, `is_room_member`) e todas as policies explícitas de **Row Level Security (RLS)**.
- [`supabase/migrations/004_social_rpcs_and_triggers.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/migrations/004_social_rpcs_and_triggers.sql) — Todas as funções RPC `SECURITY DEFINER` (`enviar_pedido_amizade`, `responder_pedido`, `bloquear`, `enviar_mensagem`, `abrir_ou_criar_dm`, `criar_grupo`, `entrar_grupo`, `promover`, `expulsar`, `sair_grupo`, `contribuir_meta_grupo`, `criar_sala`, `entrar_sala`, `iniciar_sala`, `finalizar_partida_coop`, `obter_ranking`, `minha_posicao`) e triggers automáticos em `task_logs` e `game_runs`.
- [`supabase/migrations/005_realtime_storage_cron.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/migrations/005_realtime_storage_cron.sql) — Publicação `supabase_realtime` estrita (`messages`, `notifications`, `friendships`), Realtime Authorization (`realtime.messages`), buckets `emblemas` (público) e `anexos-chat` (privado até 2 MB), e agendamentos `pg_cron`.
- [`supabase/functions/moderar-mensagem/index.ts`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/functions/moderar-mensagem/index.ts) — Edge Function (Deno/TypeScript) acionada por Database Webhook em `messages` para filtrar palavrões e links suspeitos e marcar `flagged_for_review = true`.
- [`supabase/functions/notificar/index.ts`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/functions/notificar/index.ts) — Edge Function (Deno/TypeScript) para criar notificações e mensagens de sistema no chat do esquadrão.
- [`supabase/seed.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/seed.sql) — Dados de teste (4 agentes, amizades, `ESQUADRÃO ÔMEGA`, metas semanais, partidas e chat).
- [`supabase/tests/rls.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/tests/rls.sql) — Script de testes automatizados simulando múltiplos usuários autenticados via `SET LOCAL request.jwt.claims`.

---

## 2. Comandos da Supabase CLI

No terminal, na raiz do projeto:

```bash
# 1. Autenticar na Supabase CLI e vincular ao seu projeto remoto
supabase login
supabase link --project-ref SEU_PROJECT_REF

# 2. Aplicar todas as migrations numeradas (001 a 005) no banco PostgreSQL
supabase db push

# 3. (Opcional) Popular dados de teste do arquivo supabase/seed.sql
psql "$SUPABASE_DB_URL" -f supabase/seed.sql

# 4. Configurar Secrets das Edge Functions (NUNCA exponha service_role no front-end!)
supabase secrets set MODERATION_WEBHOOK_SECRET="um-segredo-forte-aqui"

# 5. Fazer deploy das Edge Functions (Deno/TypeScript)
supabase functions deploy moderar-mensagem --no-verify-jwt
supabase functions deploy notificar

# 6. Executar a suíte de testes de Row Level Security (RLS)
psql "$SUPABASE_DB_URL" -f supabase/tests/rls.sql
```

---

## 3. Passo a Passo no Painel do Supabase (Dashboard)

### A. Habilitar a extensão `pg_cron`
1. No menu lateral do painel Supabase, acesse **Database** → **Extensions**.
2. Busque por **`pg_cron`** e ative a chave (schema `extensions` ou `pg_catalog`).
3. A migration [`005_realtime_storage_cron.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/migrations/005_realtime_storage_cron.sql) agenda automaticamente os 3 jobs:
   - `cleanup-abandoned-coop-rooms` (`*/30 * * * *`): encerra salas `waiting`/`playing` com mais de 2 horas.
   - `weekly-season-and-group-goals-reset` (`0 0 * * 1`): fecha a temporada semanal, grava `season_results`, premia o Top 3 com moedas (`+500`/`+300`/`+150`) e moldura exclusiva (`moldura_semanal_ouro`), e reinicia as metas semanais dos esquadrões.
   - `monthly-season-reset` (`5 0 1 * *`): fecha a temporada mensal e premia o Top 3 com moedas e `moldura_mensal_campeao`.

### B. Ativar Realtime e Realtime Authorization
1. Acesse **Database** → **Publications** → **`supabase_realtime`**:
   - Confirme que **somente** as tabelas `messages`, `notifications` e `friendships` estão marcadas (a migration `005` já configura isso automaticamente).
2. Acesse **Project Settings** → **API** (ou **Realtime Settings**):
   - Habilite **Enable Realtime Authorization** (permite canais privados `private: true` validados pelas policies criadas na tabela `realtime.messages` para `presence:global`, `chat:{conversation_id}` e `room:{room_id}`).

### C. Configurar o Database Webhook para `moderar-mensagem`
1. Acesse **Database** → **Webhooks** → **Create a new hook**.
2. Configure:
   - **Name**: `webhook_moderar_mensagem`
   - **Table**: `public.messages`
   - **Events**: marque **Insert**
   - **Type**: `Supabase Edge Functions`
   - **Edge Function**: selecione `moderar-mensagem` (`POST`)
   - **HTTP Headers**: adicione `x-webhook-secret: um-segredo-forte-aqui` (mesmo valor definido no `supabase secrets set`).

### D. Ajustar URLs e Provedores de Autenticação (E-mail, Apple, Google, GitHub, Discord)
1. Acesse **Authentication** → **URL Configuration**:
   - **Site URL**: `http://localhost:5500` (ou seu domínio de produção).
   - **Redirect URLs**: adicione `http://localhost:5500/**`, `http://127.0.0.1:5500/**` e sua URL de produção.
2. Em **Authentication** → **Providers**, mantenha habilitados **Email**, **Google**, **Apple**, **GitHub** e **Discord** usando a Callback URL do seu projeto (`https://<PROJECT_REF>.supabase.co/auth/v1/callback`).

---

## 4. Lista de Testes Manuais (Passo a Passo)

### Teste 1: Dois Usuários (Amizade, Presence Online/Jogando e Chat DM em Tempo Real)
1. Abra uma janela normal (Usuário A: `@vance_cyber`) e uma janela anônima (Usuário B: `@nyx_shadow`).
2. Na aba **REDE & CO-OP** → **👥 AMIGOS**, envie um pedido de amizade de A para B digitando `nyx_shadow`.
3. Na tela de B, verifique que a solicitação chega em tempo real. Clique em **✓ ACEITAR**.
4. Verifique que o indicador **Presence** fica verde (`● ONLINE AGORA`) para ambos. Quando um deles entra na Cidade, muda para ciano (`🎮 EM MISSÃO NA CIDADE`).
5. Clique em **💬 DM** ao lado do amigo:
   - Comece a digitar na janela de A sem enviar: verifique que aparece `⌨ @vance_cyber está digitando...` na janela de B (via Broadcast, sem gravar no banco).
   - Envie uma mensagem e tente enviar outra em menos de 2 segundos: verifique a mensagem de rate limit (`AGUARDE 2 SEGUNDOS ENTRE CADA MENSAGEM (RATE LIMIT).`).

### Teste 2: Bloqueio Bidirecional
1. Na aba **👥 AMIGOS**, clique no botão **🚫 (Bloquear)** ao lado do Usuário B.
2. Verifique que a amizade é desfeita imediatamente.
3. Tente enviar mensagem na DM antiga ou enviar novo pedido de amizade de B para A (ou de A para B):
   - **Resultado esperado**: bloqueado pelas policies de RLS e pela RPC com a mensagem `AÇÃO IMPEDIDA: EXISTE UM BLOQUEIO ENTRE OS USUÁRIOS.`

### Teste 3: Row Level Security (RLS) e Privacidade de Perfis (`public_profiles`)
1. Nas **⚙ CONTA**, altere a **Privacidade do Perfil Público** de `@nyx_shadow` para `PRIVADO` (ou `APENAS AMIGOS`).
2. No console do navegador (`F12`) de outro usuário que não seja amigo, execute:
   ```javascript
   const sb = window.SB.init();
   // 1. Tentar ler a tabela bruta profiles de terceiros (bloqueado por RLS)
   const { data: rawProfiles } = await sb.from('profiles').select('*');
   console.log('Profiles brutos visíveis (apenas o próprio):', rawProfiles);

   // 2. Consultar public_profiles (respeita privacidade e nunca expõe e-mail nem diário)
   const { data: pubProfiles } = await sb.from('public_profiles').select('*');
   console.log('Public profiles:', pubProfiles);
   ```
3. Para validar todas as regras no banco de uma só vez, execute `psql "$SUPABASE_DB_URL" -f supabase/tests/rls.sql` e verifique `ALL RLS TESTS PASSED SUCCESSFULLY`.

### Teste 4: Esquadrão (Grupo), Cargos, Transferência de Liderança e Metas Semanais
1. Na sub-aba **🛡️ ESQUADRÃO**, crie um esquadrão (ex.: `ESQUADRÃO NEON`, tipo `ABERTO`).
2. Com o Usuário B, entre no esquadrão clicando em **ENTRAR** ou informando o código de convite.
3. Conclua uma missão diária na aba **MISSÕES**:
   - Volte para **🛡️ ESQUADRÃO** e veja que a barra **METAS SEMANAIS COLETIVAS** avançou automaticamente via trigger `trg_task_logs_group_goal`.
4. Com o líder (Usuário A), clique em **🚪 SAIR**:
   - Verifique que a liderança é transferida automaticamente para o Usuário B (oficial/membro mais antigo).

### Teste 5: Ranking Semanal, Mensal e Geral
1. Abra a aba **RANKINGS**.
2. Alterne entre os períodos **SEMANAL**, **MENSAL** e **GERAL**, e entre as 6 categorias (**⚡ XP TOTAL**, **🎯 MISSÕES (SEMANA)**, **🔥 SEQUÊNCIA**, **🏙️ DISTÂNCIA**, **🤖 BOSSES**, **🛡️ ESQUADRÕES**).
3. Verifique o destaque da sua posição (`SUA POSIÇÃO ATUAL: #...`) e as medalhas de Top 1, 2 e 3.

### Teste 6: Sala Cooperativa com 2 Jogadores (Seed Determinística + Broadcast 15–20 Hz)
1. Na aba **REDE & CO-OP** → **🎮 SALA CO-OP**, clique em **⚡ CRIAR SALA CO-OP** com o Usuário A (Host).
2. Copie o código de 6 caracteres exibido no Lobby e digite-o na tela do Usuário B clicando em **ENTRAR NA SALA**.
3. No Host (Usuário A), clique em **▶ INICIAR MISSÃO CO-OP**:
   - Ambos os jogadores entram automaticamente na Cidade gerada com a **mesma `seed`**.
   - Movimente ambos os personagens (`A`/`D`, `W`, `Espaço` ou `J`): observe a interpolação suave em tempo real (Broadcast a 15–20 msgs/s com `self: false`), a sincronização de inimigos/boss pelo Host e a validação anti-trapaça na RPC `finalizar_partida_coop` ao concluir a fase.
