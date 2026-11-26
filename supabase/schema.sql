-- =====================================================================
-- Gestão de Avenças — schema Supabase
-- Correr uma vez no Supabase: SQL Editor → New query → colar → Run
-- (é seguro voltar a correr: usa IF NOT EXISTS / OR REPLACE)
-- =====================================================================

-- ---------- Subscritores ----------
create table if not exists public.subscribers (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid default auth.uid() references auth.users(id) on delete set null,  -- quem criou
  code               text not null,                 -- "ID" do subscritor (o teu identificador)
  payment_due_date   date,                          -- "PaymentDueDate": próximo pagamento (vazio ou passado = desligado)
  last_payment_date  date,                          -- "LastPaymentDate"
  value              numeric(10,2) not null default 0,  -- "Value": valor por período de avença
  commission         numeric(10,2) not null default 0,  -- "Commission": comissão por período
  owner              text,                          -- "Owner"
  last_notified_at   date,                          -- última vez que a mensagem de aviso foi copiada
  type               text,                          -- "Type" (categoria livre)
  hw                 text,                          -- "HW" (lista fixa definida na app)
  periodicity        text not null default 'semestral' check (periodicity in ('semestral','anual')),
  active             boolean not null default true, -- false = cancelou
  keep_active        boolean not null default false, -- true = continua ligado apesar do pagamento em atraso
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (code)
);

create index if not exists subscribers_due_idx on public.subscribers (payment_due_date);

-- ---------- Histórico de renovações / pagamentos ----------
create table if not exists public.renewals (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid default auth.uid() references auth.users(id) on delete set null,  -- quem registou
  subscriber_id   uuid not null references public.subscribers(id) on delete cascade,
  payment_date    date not null default current_date,
  period_start    date not null,
  period_end      date not null,
  value           numeric(10,2) not null default 0,
  commission      numeric(10,2) not null default 0,
  paid            boolean not null default true,
  payment_method  text,                       -- método de pagamento (ver tabela payment_methods)
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists renewals_sub_idx on public.renewals (subscriber_id, period_end desc);

-- ---------- updated_at automático ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists subscribers_updated_at on public.subscribers;
create trigger subscribers_updated_at before update on public.subscribers
  for each row execute function public.set_updated_at();

-- ---------- Administradores ----------
-- Só os utilizadores do Supabase Auth que estejam nesta tabela acedem aos dados.
-- As credenciais (email + password) ficam no Supabase Auth; aqui só se guarda quem é admin.
create table if not exists public.admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------- Row Level Security: só admins ----------
alter table public.subscribers enable row level security;
alter table public.renewals    enable row level security;

drop policy if exists "subscribers: owner" on public.subscribers;
drop policy if exists "subscribers: admins" on public.subscribers;
create policy "subscribers: admins" on public.subscribers
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

drop policy if exists "renewals: owner" on public.renewals;
drop policy if exists "renewals: admins" on public.renewals;
create policy "renewals: admins" on public.renewals
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

revoke all on public.subscribers, public.renewals from anon;

-- Permissões explícitas (projetos Supabase recentes não as dão por defeito).
-- O acesso efetivo continua limitado aos admins pelas políticas RLS acima.
grant select, insert, update, delete on public.subscribers, public.renewals to authenticated;
grant select on public.subscribers, public.renewals to service_role;

-- ---------- Custos mensais por Type ----------
create table if not exists public.type_costs (
  type          text primary key,               -- valor do campo "Type" dos subscritores (ex.: C, P)
  monthly_cost  numeric(10,2) not null default 0 check (monthly_cost >= 0),
  color         text,                           -- cor do Type na app (ex.: #2563eb)
  updated_at    timestamptz not null default now()
);

insert into public.type_costs (type, monthly_cost, color) values ('C', 2.20, '#2563eb'), ('P', 1.50, '#ea580c')
on conflict (type) do nothing;

alter table public.type_costs enable row level security;
drop policy if exists "type_costs: admins" on public.type_costs;
create policy "type_costs: admins" on public.type_costs
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.type_costs from anon;
grant select, insert, update, delete on public.type_costs to authenticated;
grant select on public.type_costs to service_role;

-- ---------- Métodos de pagamento ----------
create table if not exists public.payment_methods (
  name        text primary key,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

insert into public.payment_methods (name, sort_order) values
  ('PP', 1), ('Skrill', 2), ('Di', 3), ('MG', 4), ('MBW/AB', 5), ('PREGO', 6), ('1x', 7), ('RV', 8)
on conflict (name) do nothing;

alter table public.payment_methods enable row level security;
drop policy if exists "payment_methods: admins" on public.payment_methods;
create policy "payment_methods: admins" on public.payment_methods
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.payment_methods from anon;
grant select, insert, update, delete on public.payment_methods to authenticated;
grant select on public.payment_methods to service_role;

-- ---------- Definições da aplicação (ex.: mensagem de aviso para WhatsApp) ----------
create table if not exists public.app_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  ('whatsapp_template', 'Olá {owner}! A sua subscrição {id} vence a {data} (daqui a {dias} dias). Valor da renovação: {valor}. Obrigado!')
on conflict (key) do nothing;

alter table public.app_settings enable row level security;
drop policy if exists "app_settings: admins" on public.app_settings;
create policy "app_settings: admins" on public.app_settings
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.app_settings from anon;
grant select, insert, update, delete on public.app_settings to authenticated;
grant select on public.app_settings to service_role;

-- ---------- Vista com estado e lucro calculados ----------
-- security_invoker = true → a vista respeita o RLS de quem consulta
-- Estados: cancelado (manual) · arquivado (sem PaymentDueDate)
--          · em_atraso (data passada mas mantido ligado) · desligado (data passada)
--          · a_terminar (≤ 30 dias) · ativo
-- Lucro anual = Value anual − Commission anual − custo mensal do Type × 12
drop view if exists public.subscribers_status;
create view public.subscribers_status
with (security_invoker = true) as
select
  s.*,
  (s.payment_due_date - current_date) as days_left,
  case
    when not s.active                             then 'cancelado'
    when s.payment_due_date is null               then 'arquivado'
    when s.payment_due_date <  current_date
     and s.keep_active                            then 'em_atraso'
    when s.payment_due_date <  current_date       then 'desligado'
    when s.payment_due_date <= current_date + 30  then 'a_terminar'
    else 'ativo'
  end as status,
  case s.periodicity when 'semestral' then s.value * 2      else s.value      end as value_year,
  case s.periodicity when 'semestral' then s.commission * 2 else s.commission end as commission_year,
  coalesce(tc.monthly_cost, 0)                                                  as monthly_cost,
  coalesce(tc.monthly_cost, 0) * 12                                             as cost_year,
  (case s.periodicity when 'semestral' then (s.value - s.commission) * 2 else s.value - s.commission end)
    - coalesce(tc.monthly_cost, 0) * 12                                         as net_year,
  (tc.type is null)                                                             as type_sem_custo
from public.subscribers s
left join public.type_costs tc on tc.type = s.type;

revoke all on public.subscribers_status from anon;
grant select on public.subscribers_status to authenticated, service_role;

-- ---------- Renovar: regista o pagamento e avança o PaymentDueDate ----------
-- Por defeito o novo período começa no PaymentDueDate atual (mantém o ciclo);
-- se não houver data, começa na data do pagamento. p_start permite escolher outro início.
-- p_months permite reforços curtos (ex.: 1 ou 3 meses); null = período normal (6 ou 12).
drop function if exists public.renew_subscriber(uuid, numeric, numeric, boolean, text, date);
drop function if exists public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date);
drop function if exists public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer);
create or replace function public.renew_subscriber(
  p_id            uuid,
  p_value         numeric default null,   -- null = Value atual
  p_commission    numeric default null,   -- null = Commission atual
  p_paid          boolean default true,
  p_notes         text default null,
  p_payment_date  date default null,      -- null = hoje
  p_start         date default null,      -- início do novo período (null = automático)
  p_months        integer default null,   -- duração em meses (null = 6 semestral / 12 anual)
  p_method        text default null       -- método de pagamento
)
returns public.subscribers
language plpgsql
security invoker
set search_path = public
as $$
declare
  s      public.subscribers;
  v_ini  date;
  v_fim  date;
  v_dt   date := coalesce(p_payment_date, current_date);
  v_mes  integer;
begin
  select * into s from public.subscribers where id = p_id for update;
  if not found then
    raise exception 'Subscritor não encontrado ou sem permissão';
  end if;

  v_mes := coalesce(p_months, case s.periodicity when 'anual' then 12 else 6 end);
  if v_mes < 1 or v_mes > 24 then
    raise exception 'Duração inválida: % meses', v_mes;
  end if;

  v_ini := coalesce(p_start, s.payment_due_date, v_dt);
  v_fim := (v_ini + make_interval(months => v_mes))::date;

  -- value/commission do período normal mantêm-se; num reforço curto não alteram os valores de referência
  insert into public.renewals (subscriber_id, payment_date, period_start, period_end, value, commission, paid, payment_method, notes)
  values (s.id, v_dt, v_ini, v_fim, coalesce(p_value, s.value), coalesce(p_commission, s.commission), p_paid, nullif(trim(p_method), ''), p_notes);

  perform set_config('app.in_renew', '1', true);   -- o log de auditoria regista só a renovação
  update public.subscribers
     set payment_due_date  = v_fim,
         last_payment_date = case when p_paid then v_dt else last_payment_date end,
         value             = case when p_months is null then coalesce(p_value, value) else value end,
         commission        = case when p_months is null then coalesce(p_commission, commission) else commission end,
         keep_active       = false,
         active            = true
   where id = s.id
  returning * into s;
  perform set_config('app.in_renew', '', true);

  return s;
end $$;

revoke all on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer, text) from public, anon;
grant execute on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer, text) to authenticated;

-- ---------- Log de auditoria ----------
-- Registado por triggers na base de dados: não depende da app e não pode ser alterado
-- nem apagado pelos utilizadores (só leitura para admins).
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  user_id     uuid,
  user_email  text,
  action      text not null,     -- criar · editar · apagar · renovar · aviso · ligar · desligar · config
  entity      text not null,     -- subscriber · renewal · type_cost · setting
  record_id   text,
  code        text,              -- ID do subscritor (quando aplicável)
  details     jsonb              -- alterações / dados relevantes
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_code_idx on public.audit_log (code);

alter table public.audit_log enable row level security;
drop policy if exists "audit_log: admins leem" on public.audit_log;
create policy "audit_log: admins leem" on public.audit_log
  for select to authenticated
  using ((select public.is_admin()));
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated, service_role;

-- Quem fez a ação (a partir do token do Supabase)
create or replace function public.audit_actor(out uid uuid, out email text)
language sql stable
set search_path = public
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
$$;

-- Diferenças entre duas linhas: {campo: [antes, depois]}
create or replace function public.audit_diff(o jsonb, n jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, jsonb_build_array(o -> k, n -> k)), '{}'::jsonb)
  from jsonb_object_keys(n) k
  where k not in ('updated_at', 'created_at') and (o -> k) is distinct from (n -> k)
$$;

create or replace function public.audit_write(p_action text, p_entity text, p_record text, p_code text, p_details jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare a record;
begin
  select * into a from public.audit_actor();
  insert into public.audit_log (user_id, user_email, action, entity, record_id, code, details)
  values (a.uid, a.email, p_action, p_entity, p_record, p_code, p_details);
end $$;
revoke all on function public.audit_write(text, text, text, text, jsonb) from public, anon, authenticated;

-- Subscritores
create or replace function public.audit_subscribers()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare d jsonb; act text;
begin
  if tg_op = 'INSERT' then
    perform public.audit_write('criar', 'subscriber', new.id::text, new.code,
      to_jsonb(new) - 'user_id' - 'created_at' - 'updated_at' - 'id');
  elsif tg_op = 'DELETE' then
    perform public.audit_write('apagar', 'subscriber', old.id::text, old.code,
      to_jsonb(old) - 'user_id' - 'created_at' - 'updated_at' - 'id');
  else
    -- a renovação já fica registada pela tabela renewals
    if current_setting('app.in_renew', true) = '1' then return new; end if;
    d := public.audit_diff(to_jsonb(old), to_jsonb(new));
    if d = '{}'::jsonb then return new; end if;
    act := case
      when d ?& array['last_notified_at'] and (select count(*) from jsonb_object_keys(d)) = 1 then 'aviso'
      when d ? 'keep_active' and (select count(*) from jsonb_object_keys(d)) = 1 then
        case when new.keep_active then 'ligar' else 'desligar' end
      else 'editar' end;
    perform public.audit_write(act, 'subscriber', new.id::text, new.code, d);
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists audit_subscribers on public.subscribers;
create trigger audit_subscribers after insert or update or delete on public.subscribers
  for each row execute function public.audit_subscribers();

-- Renovações (registo de pagamento)
create or replace function public.audit_renewals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare c text;
begin
  select code into c from public.subscribers where id = new.subscriber_id;
  perform public.audit_write('renovar', 'renewal', new.id::text, c,
    jsonb_build_object('payment_date', new.payment_date, 'period_start', new.period_start, 'period_end', new.period_end,
                       'value', new.value, 'commission', new.commission, 'paid', new.paid,
                       'payment_method', new.payment_method, 'notes', new.notes));
  return new;
end $$;

drop trigger if exists audit_renewals on public.renewals;
create trigger audit_renewals after insert on public.renewals
  for each row execute function public.audit_renewals();

-- Configuração: custos por Type e definições
create or replace function public.audit_config()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare ent text := case tg_table_name when 'type_costs' then 'type_cost' when 'payment_methods' then 'payment_method' else 'setting' end;
        rid text;
begin
  rid := coalesce(to_jsonb(new), to_jsonb(old)) ->> case tg_table_name when 'type_costs' then 'type' when 'payment_methods' then 'name' else 'key' end;
  if tg_op = 'UPDATE' and public.audit_diff(to_jsonb(old), to_jsonb(new)) = '{}'::jsonb then return new; end if;
  perform public.audit_write('config', ent, rid, null,
    case tg_op
      when 'INSERT' then jsonb_build_object('op', 'criar', 'novo', to_jsonb(new) - 'updated_at')
      when 'DELETE' then jsonb_build_object('op', 'apagar', 'antigo', to_jsonb(old) - 'updated_at')
      else jsonb_build_object('op', 'editar', 'alterações', public.audit_diff(to_jsonb(old), to_jsonb(new))) end);
  return coalesce(new, old);
end $$;

drop trigger if exists audit_type_costs on public.type_costs;
create trigger audit_type_costs after insert or update or delete on public.type_costs
  for each row execute function public.audit_config();
drop trigger if exists audit_payment_methods on public.payment_methods;
create trigger audit_payment_methods after insert or update or delete on public.payment_methods
  for each row execute function public.audit_config();
drop trigger if exists audit_app_settings on public.app_settings;
create trigger audit_app_settings after insert or update or delete on public.app_settings
  for each row execute function public.audit_config();

-- =====================================================================
-- DEPOIS de correr o script acima:
-- 1) Supabase → Authentication → Users → Add user → Create new user
--    (email + password, marcar "Auto Confirm User")
-- 2) Correr isto, com o email do admin:
--
--    insert into public.admins (user_id)
--    select id from auth.users where email = 'o-teu-email@exemplo.pt';
--
-- 3) Supabase → Authentication → Sign In / Providers → desligar "Allow new users to sign up"
-- =====================================================================
