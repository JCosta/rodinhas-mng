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
  type               text,                          -- "Type" (categoria livre)
  hw                 text,                          -- "HW" (lista fixa definida na app)
  periodicity        text not null default 'semestral' check (periodicity in ('semestral','anual')),
  active             boolean not null default true, -- false = cancelou
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

-- ---------- Vista com estado calculado ----------
-- security_invoker = true → a vista respeita o RLS de quem consulta
create or replace view public.subscribers_status
with (security_invoker = true) as
select
  s.*,
  (s.payment_due_date - current_date) as days_left,
  case
    when not s.active                             then 'cancelado'
    when s.payment_due_date is null
      or s.payment_due_date <  current_date       then 'desligado'
    when s.payment_due_date <= current_date + 30  then 'a_terminar'
    else 'ativo'
  end as status,
  case s.periodicity when 'semestral' then s.value * 2      else s.value      end as value_year,
  case s.periodicity when 'semestral' then s.commission * 2 else s.commission end as commission_year
from public.subscribers s;

revoke all on public.subscribers_status from anon;
grant select on public.subscribers_status to authenticated, service_role;

-- ---------- Renovar: regista o pagamento e avança o PaymentDueDate ----------
-- Por defeito o novo período começa no PaymentDueDate atual (mantém o ciclo);
-- se não houver data, começa na data do pagamento. p_start permite escolher outro início.
-- p_months permite reforços curtos (ex.: 1 ou 3 meses); null = período normal (6 ou 12).
drop function if exists public.renew_subscriber(uuid, numeric, numeric, boolean, text, date);
drop function if exists public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date);
create or replace function public.renew_subscriber(
  p_id            uuid,
  p_value         numeric default null,   -- null = Value atual
  p_commission    numeric default null,   -- null = Commission atual
  p_paid          boolean default true,
  p_notes         text default null,
  p_payment_date  date default null,      -- null = hoje
  p_start         date default null,      -- início do novo período (null = automático)
  p_months        integer default null    -- duração em meses (null = 6 semestral / 12 anual)
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
  insert into public.renewals (subscriber_id, payment_date, period_start, period_end, value, commission, paid, notes)
  values (s.id, v_dt, v_ini, v_fim, coalesce(p_value, s.value), coalesce(p_commission, s.commission), p_paid, p_notes);

  update public.subscribers
     set payment_due_date  = v_fim,
         last_payment_date = case when p_paid then v_dt else last_payment_date end,
         value             = case when p_months is null then coalesce(p_value, value) else value end,
         commission        = case when p_months is null then coalesce(p_commission, commission) else commission end,
         active            = true
   where id = s.id
  returning * into s;

  return s;
end $$;

revoke all on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer) from public, anon;
grant execute on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer) to authenticated;

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
