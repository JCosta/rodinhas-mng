# Gestão de Avenças

Plataforma para gerir subscritores com avença semestral ou anual: quem está a vencer, quem está desligado, lucro, renovações e histórico de pagamentos.

- **Frontend:** página estática (HTML + JS), alojada no GitHub Pages
- **Dados e login:** Supabase (Postgres + Auth), protegido por Row Level Security. Só os utilizadores na tabela `admins` têm acesso.
- **Avisos:** GitHub Action que envia um email semanal com os pagamentos a vencer e os desligados

> **Estado: preparado, mas não ativo.** O repositório está privado, o GitHub Pages está desligado e a Action dos avisos não está agendada. Segue os passos abaixo quando quiseres pôr a plataforma a funcionar.

## Campos

| Campo (folha) | Coluna na BD | Notas |
|---|---|---|
| ID | `code` | Identificador único do subscritor |
| PaymentDueDate | `payment_due_date` | Data do próximo pagamento (vazio = arquivado; passado = desligado) |
| LastPaymentDate | `last_payment_date` | Atualizado automaticamente ao renovar como pago |
| Value | `value` | Valor por período de avença |
| Commission | `commission` | Comissão por período |
| Owner | `owner` | |
| Type | `type` | Categoria (ex.: C, P). O custo mensal de cada Type está na tabela `type_costs` |
| HW | `hw` | Lista fixa: editar `HW_OPCOES` em `config.js` |
| — | `periodicity` | `semestral` (por defeito) ou `anual`. Define quanto avança a data ao renovar |

**Lucro:** lucro anual = Value anual − Commission anual − custo mensal do Type × 12. Os custos por Type editam-se no separador **Configuração** da app ou na tabela `type_costs` do Supabase.

**Estados:** *Ativo*, *A vencer* (≤ 30 dias), *Em atraso* (PaymentDueDate já passou mas mantido ligado — botão **Manter ligado**), *Desligado* (PaymentDueDate já passou), *Arquivado* (sem PaymentDueDate; pode ser reativado) ou *Cancelado* (manual).

**Fecho do mês:** no penúltimo e no último dia de cada mês, o cabeçalho do Painel mostra um aviso para apurar as contas (recebido no mês, comissões do mês, comissões por pagar e pagamentos por receber), com atalhos para o Financeiro e os Revendedores.

**Painel — caixa 📌 Hoje:** as ações mais urgentes (prazo de tolerância a acabar, a vencer em ≤ 7 dias sem aviso, avisados há > 7 dias que não renovaram, em atraso há > 30 dias, pagamentos por receber). Os "A vencer" têm cor de urgência (vermelho ≤ 7 dias, laranja ≤ 15, amarelo ≤ 30) e a secção 💸 **Por receber** lista os pagamentos não pagos com botão **Marcar como pago**.

**Manter ligado com prazo:** ao manter ligado um cliente em atraso escolhe-se até quando (7/15/30 dias, data ou sem prazo). Passado o prazo volta sozinho aos Desligados.

**Revendedores:** cada subscritor pode ter um revendedor, que recebe a comissão. Cada pagamento guarda o revendedor que o subscritor tinha nesse momento. A comissão só fica "por pagar" depois de o cliente pagar. No separador **Revendedores** vês os totais por revendedor e marcas as comissões como pagas (uma a uma ou várias de uma vez, com a data); também se pode desfazer. Na importação, a coluna `Reseller` associa pelo nome (e cria os revendedores que faltarem).

**Visual:** instalável no telemóvel (PWA: no Chrome/Android "Instalar app"; no iPhone, Safari → Partilhar → "Adicionar ao ecrã principal"); modo escuro automático ou escolhido no botão ◐; barra de progresso do período em cada subscritor; linha temporal do histórico no Editar (buracos a vermelho); separador **Calendário** de vencimentos; gráficos no Financeiro; "Desfazer" durante 8 s depois de apagar.

**Segurança:** 2FA obrigatória (exigida pela base de dados), sessão com limite de inatividade (30 min) e duração máxima (8 h), CSP e bibliotecas alojadas no site. Ver **[SEGURANCA.md](SEGURANCA.md)** — inclui a checklist das definições a ativar no Supabase e no GitHub.

**Separadores:** *Painel* (só operacional: a vencer, em atraso, desligados, arquivados) · *Subscritores* · *Financeiro* (receita, comissões, custos por Type, lucro líquido mensal, previsão de 12 meses e pagamentos registados) · *Importar* · *Configuração* · *Auditoria*.

**Auditoria:** todas as ações (criar, editar, renovar, apagar, avisos, manter ligado/desligar, configuração) ficam registadas na tabela `audit_log` por triggers da base de dados, com utilizador e data/hora. O registo é só de leitura: não pode ser alterado nem apagado a partir da app.

**Cor por Type:** cada Type tem uma cor (tabela `type_costs`, editável em Configuração), usada nas listas para os distinguir.

**Histórico de pagamentos:** no Editar de cada subscritor é possível adicionar, editar e apagar pagamentos antigos sem alterar o PaymentDueDate (com opção para o atualizar). Tudo fica na Auditoria. O LastPaymentDate é atualizado automaticamente (pela base de dados) com o pagamento pago mais recente.

**Métodos de pagamento:** escolhidos ao renovar (lista editável em Configuração, tabela `payment_methods`); o Financeiro mostra os totais por método.

**Agradecimento:** depois de renovar ou de marcar um pagamento como pago, a app propõe uma mensagem de agradecimento pronta a copiar (modelo editável em Configuração; botão **Agradecer** no histórico).

**Aviso por WhatsApp:** nos subscritores a vencer, o botão **Copiar mensagem** copia um texto pronto a colar no WhatsApp do contacto e regista a data do aviso. O texto edita-se em **Configuração** (guardado na tabela `app_settings`).

Os valores são mostrados sem símbolo de moeda.
**Renovar:** regista o pagamento no histórico (`renewals`) e avança o PaymentDueDate em 6 ou 12 meses. Num desligado, o novo período começa na data do pagamento (editável). Também é possível um **reforço de 1 ou 3 meses**, com valores proporcionais.

**Atualizações de base de dados:** quem já correu o `schema.sql` antes deve correr os ficheiros em `supabase/migrations/` por ordem. O `schema.sql` já inclui tudo para instalações novas.

## Ativar (passo a passo)

### 1. Supabase: base de dados
1. Abrir o projeto → **SQL Editor** → **New query**
2. Colar o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) e clicar **Run**

### 2. Supabase: criar o admin
1. **Authentication → Users → Add user → Create new user**: email + password, com **Auto Confirm User** marcado
2. No SQL Editor:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'o-teu-email@exemplo.pt';
   ```
3. **Authentication → Sign In / Providers**: desligar **Allow new users to sign up**
4. **Authentication → URL Configuration**: em *Site URL*, pôr o endereço do GitHub Pages (passo 3)

### 3. GitHub Pages
O GitHub Pages grátis exige um repositório **público**. Não há segredos no código: a publishable key é pública por natureza, e os dados estão protegidos pelo login e pelo RLS.
1. **Settings → General → Danger Zone → Change visibility → Public** (ou ter GitHub Pro e manter privado)
2. **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save**
3. Endereço: `https://jcosta.github.io/rodinhas-mng/`

### 4. Importar a folha atual
Entrar na app → **Importar** → escolher o `.xlsx` ou `.csv`. As colunas são reconhecidas pelos nomes (ID, PaymentDueDate, …) e podes corrigir a correspondência antes de importar. Se um ID já existir, os dados desse subscritor são atualizados.

### 5. Backup semanal (encriptado)
A Action **Backup semanal (encriptado)** corre aos domingos e exporta todas as tabelas para um ficheiro encriptado com AES-256, guardado 90 dias em **Actions → (execução) → Artifacts**. Como o repositório é público, o ficheiro **nunca** é guardado sem encriptação.
1. **Settings → Secrets and variables → Actions**: criar `SUPABASE_SECRET_KEY` (Supabase → Project Settings → API Keys → *secret key*) e `BACKUP_PASSPHRASE` (uma palavra-passe longa — guarda-a num gestor de passwords; sem ela o backup não se abre).
2. Testar: **Actions → Backup semanal (encriptado) → Run workflow**.
3. Abrir um backup: descarregar o artifact, extrair o `.zip` e
   ```bash
   gpg -d rodinhas-AAAA-MM-DD.json.gz.gpg | gunzip > backup.json
   ```

### 6. (Opcional) Avisos semanais por email
1. **Settings → Secrets and variables → Actions → New repository secret**:
   - `SUPABASE_SECRET_KEY`: Supabase → Project Settings → API Keys → *secret key* (`sb_secret_…`). **Nunca a pôr no código.**
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`: por exemplo, Gmail: `smtp.gmail.com`, `465`, o teu email e uma [App Password](https://myaccount.google.com/apppasswords)
   - `EMAIL_TO`: para onde enviar
2. Testar: **Actions → Avisos semanais de avenças → Run workflow**
3. Ativar o agendamento: em `.github/workflows/avisos.yml`, tirar o `#` das linhas `schedule` e `cron`

Nota: no plano gratuito, o Supabase pausa projetos sem atividade durante cerca de uma semana. A Action semanal mantém o projeto acordado.

## Estrutura
```
index.html, styles.css, app.js   → aplicação
config.js                        → URL/publishable key do Supabase, dias de aviso, opções de HW
supabase/schema.sql              → tabelas, RLS, vista e função de renovação
scripts/avisos.mjs               → script do email semanal
.github/workflows/avisos.yml     → Action (agendamento desligado)
```

## Publicar alterações
Depois de alterar `app.js`, `styles.css` ou `config.js`, atualiza o número `?v=` em `index.html` (e o import do `config.js` em `app.js`). Assim os browsers vão buscar os ficheiros novos em vez de usarem a cópia em cache.
