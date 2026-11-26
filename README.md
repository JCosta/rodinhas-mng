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

**Separadores:** *Painel* (só operacional: a vencer, em atraso, desligados, arquivados) · *Subscritores* · *Financeiro* (receita, comissões, custos por Type, lucro líquido mensal, previsão de 12 meses e pagamentos registados) · *Importar* · *Configuração* · *Auditoria*.

**Auditoria:** todas as ações (criar, editar, renovar, apagar, avisos, manter ligado/desligar, configuração) ficam registadas na tabela `audit_log` por triggers da base de dados, com utilizador e data/hora. O registo é só de leitura: não pode ser alterado nem apagado a partir da app.

**Cor por Type:** cada Type tem uma cor (tabela `type_costs`, editável em Configuração), usada nas listas para os distinguir.

**Histórico de pagamentos:** no Editar de cada subscritor é possível adicionar, editar e apagar pagamentos antigos sem alterar o PaymentDueDate (com opção para o atualizar). Tudo fica na Auditoria. O LastPaymentDate é atualizado automaticamente (pela base de dados) com o pagamento pago mais recente.

**Métodos de pagamento:** escolhidos ao renovar (lista editável em Configuração, tabela `payment_methods`); o Financeiro mostra os totais por método.

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

### 5. (Opcional) Avisos semanais por email
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
