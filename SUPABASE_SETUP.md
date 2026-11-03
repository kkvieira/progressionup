# Guia de Configuração do Supabase e Roteiro de Testes Manuais

Este guia detalha o passo a passo para configurar o projeto no painel do **Supabase** (PostgreSQL, Auth OAuth 2.0 com PKCE, Storage privado e Realtime) e o roteiro de testes manuais para validar todas as regras de negócio e segurança.

---

## Parte 1 — Passo a Passo no Painel do Supabase

### 1. Criar o Projeto e Executar o Script SQL (`migrations`)
1. Acesse [https://supabase.com/dashboard](https://supabase.com/dashboard) e clique em **New Project**.
2. Defina o nome (`sistema-de-missoes`), uma senha forte para o banco PostgreSQL e a região (ex.: *South America - São Paulo*).
3. Com o projeto criado, abra o menu lateral **SQL Editor** → **New query**.
4. Copie todo o conteúdo do arquivo [`supabase/migrations/001_initial_schema.sql`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/supabase/migrations/001_initial_schema.sql) e clique em **Run**.
   - Isso criará automaticamente:
     - Todas as tabelas (`profiles`, `characters`, `tasks`, `task_logs`, `achievements`, `user_achievements`, `game_runs`, `inventory`).
     - Triggers (`on_auth_user_created`, `trg_enforce_max_active_tasks`, `trg_protect_profile_progression`, `updated_at`).
     - Funções RPC anti-cheat (`concluir_tarefa`, `iniciar_partida`, `finalizar_partida`, `comprar_ou_equipar_item`, `importar_dados_locais`, `excluir_minha_conta`, `registrar_acesso_diario`).
     - Policies de **Row Level Security (RLS)** em todas as tabelas.
     - O bucket privado `registros` no **Supabase Storage** com limite de **5 MB** e tipos `image/png`, `image/jpeg`, `image/webp`.

---

### 2. Configurar URLs de Redirecionamento e Vinculação de Identidades (Auth)
1. No menu lateral do Supabase, acesse **Authentication** → **URL Configuration**.
2. Em **Site URL**, coloque a URL onde seu front-end roda (ex.: `http://localhost:5500` ou `http://127.0.0.1:5500` no Live Server, ou seu domínio em produção).
3. Em **Redirect URLs**, adicione:
   - `http://localhost:5500/**`
   - `http://127.0.0.1:5500/**`
   - `http://localhost:3000/**`
4. Em **Authentication** → **Providers** → **Email**:
   - Mantenha **Enable Email provider** ativado.
   - Ative **Confirm email** (para exigir confirmação por e-mail) e defina **Minimum password length** para `8`.
5. Em **Authentication** → **Settings** (ou **User Signups**):
   - Certifique-se de que **Allow manual linking** esteja **ativado** (permite vincular/desvincular contas Google/Discord/GitHub na tela de Configurações da Conta) e que a união automática por e-mail verificado esteja habilitada.

---

### 3. Ativar Provedores OAuth 2.0 / OpenID Connect (Google, Discord e GitHub)
Em todos os provedores abaixo, você usará a **Callback URL** do seu projeto Supabase (`pbqgfsgouqvubofphevk`), encontrada em **Authentication** → **Providers**:
`https://pbqgfsgouqvubofphevk.supabase.co/auth/v1/callback`

#### A. Google (OAuth 2.0 + OIDC)
1. Acesse o [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**.
2. Clique em **Create Credentials** → **OAuth client ID** (tipo *Web application*).
3. Em **Authorized redirect URIs**, adicione:
   `https://pbqgfsgouqvubofphevk.supabase.co/auth/v1/callback`
4. Copie o **Client ID** e o **Client Secret** e cole em **Authentication** → **Providers** → **Google** no painel do Supabase. Salve.

#### B. Discord (OAuth 2.0)
1. Acesse o [Discord Developer Portal](https://discord.com/developers/applications) e clique em **New Application**.
2. No menu **OAuth2**, adicione em **Redirects**:
   `https://pbqgfsgouqvubofphevk.supabase.co/auth/v1/callback`
3. Copie o **Client ID** e o **Client Secret** e cole em **Authentication** → **Providers** → **Discord** no Supabase. Salve.

#### C. GitHub (OAuth 2.0)
1. Acesse o GitHub → **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**.
2. Em **Authorization callback URL**, preencha:
   `https://pbqgfsgouqvubofphevk.supabase.co/auth/v1/callback`
3. Copie o **Client ID** e gere um **Client Secret**, colando ambos em **Authentication** → **Providers** → **GitHub** no Supabase. Salve.

---

### 4. Verificar o Bucket Privado `registros` no Storage
1. No menu lateral **Storage**, verifique se o bucket **`registros`** aparece com a tag **Private** (criado pelo script SQL).
2. Caso queira revisar na interface gráfica:
   - Limite de arquivo: `5 MB`.
   - MIME types permitidos: `image/png, image/jpeg, image/webp`.
   - Estrutura de pastas usada automaticamente pelo app: `/{user_id}/{YYYY-MM-DD}/{timestamp_hash.ext}`.

---

### 5. Configurar as Variáveis de Ambiente no Front-End
1. No painel do Supabase, acesse **Project Settings** → **API**.
2. Copie a **Project URL** e a chave pública **`anon` `public`** (**NUNCA** copie nem exponha a chave `service_role` no front-end!).
3. Configure no projeto de uma das seguintes formas:
   - **Opção A (Arquivo [`js/env.js`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/js/env.js))**: substitua `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
   - **Opção B (Arquivo `.env`)**: copie [`.env.example`](file:///c:/Users/kaiky/OneDrive/%C3%81rea%20de%20Trabalho/progression%20up/.env.example) para `.env`.
   - **Opção C (Direto na tela de Login HUD)**: clique em **⚙ CONFIGURAR CHAVES SUPABASE (.ENV)** na parte inferior da tela de login e cole a URL e a Anon Key.

---

## Parte 2 — Roteiro de Testes Manuais

### Teste 1: Cadastro, Senha Forte, Login e Proteção de Rotas
1. Abra o sistema não autenticado: verifique que **apenas a tela de Login HUD** é exibida (`#mainApp` permanece oculto).
2. Alterne para a aba **CRIAR CONTA** e digite uma senha com menos de 8 caracteres (ex.: `123456`):
   - **Resultado esperado**: o indicador exibe `⚠ SENHA FRACA` e bloqueia o envio com mensagem clara em português.
3. Cadastre-se com e-mail válido e senha de 8+ caracteres:
   - **Resultado esperado**: o sistema exibe aviso para confirmar o e-mail (ou autentica e abre imediatamente a **Criação de Personagem**, pois a conta ainda não possui registro em `characters`).
4. Tente entrar com senha errada:
   - **Resultado esperado**: exibe `CREDENCIAIS INVÁLIDAS: E-MAIL OU SENHA INCORRETOS.`

### Teste 2: Migração do `localStorage` no Primeiro Login
1. Antes de criar o personagem de uma conta nova, se houver dados salvos na chave `sistemaMissoes.v1` do `localStorage`, o modal **DADOS LOCAIS DETECTADOS!** será aberto automaticamente.
2. Clique em **⬆ IMPORTAR PARA MINHA CONTA**:
   - **Resultado esperado**: a RPC `importar_dados_locais` transfere nível, XP, personagem, missões e itens da loja para o banco e limpa a chave antiga do `localStorage`.

### Teste 3: Limite de 15 Tarefas Ativas (Front-End + Trigger no Banco)
1. No painel principal, clique em **⚙ EDITAR MISSÕES** e adicione novas missões até atingir `15/15`.
2. Verifique que o botão **ADICIONAR MAIS ATIVIDADES** é desabilitado no HUD.
3. Para testar a proteção no banco (mesmo burlando o HTML pelo console), abra o DevTools (`F12`) e execute:
   ```javascript
   await window.SB.tarefas.criar(window.currentUser.id, { name: 'Missão 16', difficulty: 'facil', category: 'rotina' });
   ```
   - **Resultado esperado**: o PostgreSQL rejeita a inserção no trigger `trg_enforce_max_active_tasks` e retorna `LIMITE DE 15 MISSÕES ATIVAS ATINGIDO!`.

### Teste 4: Uma Conclusão por Dia + Exigência de Texto ou Foto + Storage Privado
1. Clique no botão `+` de uma missão diária:
   - Verifique que o botão **CONCLUIR MISSÃO** fica desabilitado enquanto texto e foto estiverem vazios.
2. Tente anexar um arquivo `.gif`, `.pdf` ou maior que 5 MB:
   - **Resultado esperado**: bloqueado imediatamente com mensagem de erro em português.
3. Anexe uma foto `.png`/`.jpg`/`.webp` válida (até 5 MB) ou digite uma descrição e conclua:
   - **Resultado esperado**: a foto é enviada para `registros/{user_id}/{data}/{arquivo}`, a RPC `concluir_tarefa` calcula o XP e fichas no servidor, a barra de XP do topo sobe em tempo real e a foto aparece no **Diário de Missões** via URL assinada temporária (`createSignedUrls`).
4. Tente concluir a mesma tarefa novamente no mesmo dia via console:
   ```javascript
   await window.SB.registros.concluirTarefa('<TASK_ID_JA_CONCLUIDA>', 'Tentativa duplicada', null);
   ```
   - **Resultado esperado**: bloqueado pela constraint única `(task_id, data)` e pela RPC com a mensagem `ESTA MISSÃO JÁ FOI CONCLUÍDA HOJE (LIMITE DE 1 POR DIA).`

### Teste 5: Segurança RLS e Proteção Anti-Cheat contra Manipulação pelo Console
1. Abra o console do navegador (`F12`) e tente alterar diretamente seu nível, XP ou moedas na tabela `profiles`:
   ```javascript
   const sb = window.SB.init();
   await sb.from('profiles').update({ level: 99, xp_total: 999999, moedas: 50000 }).eq('id', window.currentUser.id);
   ```
   - **Resultado esperado**: o trigger `trg_protect_profile_progression` ignora a alteração direta vinda do cliente e mantém `level`, `xp_total`, `moedas` e `fichas` intactos no banco.
2. Tente ler dados de outro `user_id` em `profiles`, `tasks`, `task_logs` ou `storage.objects`:
   - **Resultado esperado**: as policies de **Row Level Security (`auth.uid() = user_id`)** retornam lista vazia (`[]`).
