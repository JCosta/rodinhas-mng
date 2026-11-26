# Segurança — Gestão de Avenças

## O que a plataforma já faz

| Camada | Proteção |
|---|---|
| **Acesso aos dados** | Row Level Security em todas as tabelas: só utilizadores na tabela `admins` **e** com sessão verificada por **2FA** (`aal2`) leem ou alteram dados. Uma password roubada, sozinha, não dá acesso a nada. |
| **2FA obrigatória** | Código TOTP de 6 dígitos (Google/Microsoft Authenticator, 1Password…), pedido em cada login. Exigido pela base de dados, não só pelo ecrã. |
| **Sessão** | Termina após **30 min** sem atividade e, em qualquer caso, ao fim de **8 horas** (`SESSAO_MINUTOS` / `SESSAO_MAX_HORAS` em `config.js`). |
| **Registo de novas contas** | Desligado no Supabase (ver checklist). Mesmo que alguém crie conta, não está em `admins` → não vê nada. |
| **Chaves** | No código só existe a *publishable key* (pública por natureza). A *secret key* vive apenas nos GitHub Secrets. |
| **Navegador** | Content-Security-Policy (só carrega código deste site e só comunica com o Supabase deste projeto), proteção contra *clickjacking*, `no-referrer`, `noindex`. A biblioteca do Supabase está alojada no próprio site (sem CDN de terceiros). Todo o texto é escapado antes de ser mostrado (proteção XSS). |
| **Auditoria** | Todas as ações ficam em `audit_log` (por triggers, só de leitura, não apagável pela app). |
| **Backups** | Semanais, **encriptados com AES-256** antes de saírem do GitHub Actions; guardados 90 dias. |

## Checklist — o que tens de fazer (uma vez)

### Supabase (painel do projeto)
- [ ] **Correr `supabase/migrations/014_2fa.sql`** — no login seguinte a app pede para ativares o 2FA.
- [ ] Ao ativar o 2FA, **guarda a "chave manual"** (o texto por baixo do QR) no teu gestor de passwords: serve de cópia de segurança se perderes o telemóvel.
- [ ] **Authentication → Sign In / Providers → "Allow new users to sign up": desligado.**
- [ ] **Authentication → Sign In / Providers → Email:** *Minimum password length* = **12** ou mais e *Password requirements* = letras, números e símbolos.
- [ ] **Mudar a password do admin** para uma longa e única (gerada pelo gestor de passwords).
- [ ] **Authentication → Sessions** *(se o plano o permitir)*: *Time-box user sessions* = 8 h e *Inactivity timeout* = 30 min — o mesmo que a app faz, mas imposto pelo servidor.
- [ ] **Access token (JWT) expiry**: 900 segundos (15 min) — reduz a janela de uso de um token roubado.
- [ ] **Database → Settings → Network restrictions**: bloquear ligações diretas à base de dados (a app usa a API, não é afetada) ou permitir só o teu IP. **SSL enforcement**: ligado.
- [ ] **Advisors → Security Advisor**: confirmar que não há avisos.
- [ ] **A tua conta supabase.com → Account → Security: ativar 2FA.** Quem entra no painel do Supabase vê todos os dados — esta é das proteções mais importantes.
- [ ] Se alguma chave ou password foi partilhada por chat/email, **rodá-la** (API Keys → criar nova secret key, atualizar o GitHub Secret, revogar a antiga; Database → reset password).

### GitHub
- [ ] **Ativar 2FA na conta GitHub** (Settings → Password and authentication). Quem consegue alterar o código do site pode alterar o que corre no teu navegador.
- [ ] `BACKUP_PASSPHRASE`: frase longa e única, guardada no gestor de passwords.
- [ ] **Settings → Code security**: ativar *Dependabot alerts* e *Secret scanning* (gratuitos).
- [ ] Opcional: repositório **privado** (exige GitHub Pro para manter o GitHub Pages).

### Dispositivos
- [ ] Usar a app só em dispositivos teus, com bloqueio de ecrã. Em computadores partilhados, carregar sempre em **Sair**.

## Recuperar o acesso se perderes o telemóvel do 2FA
1. Se guardaste a chave manual: adiciona-a numa nova app autenticadora e entra normalmente.
2. Caso contrário, no **SQL Editor** do Supabase (protegido pela tua conta supabase.com):
   ```sql
   -- remove o 2FA antigo do admin; no próximo login a app pede para ativar de novo
   delete from auth.mfa_factors
   where user_id = (select id from auth.users where email = 'mangas@rodinhas.com');
   ```

## Riscos residuais (conhecidos)
- O leitor de Excel (SheetJS) é carregado do site oficial `cdn.sheetjs.com` só quando importas uma folha; está limitado pela CSP.
- O token de sessão fica guardado no navegador (necessário para a app instalável). A CSP e os limites de sessão reduzem o risco.
- Os limites de sessão da app são aplicados no navegador; para os impor também no servidor, ativa as opções de *Sessions* do Supabase (acima).
