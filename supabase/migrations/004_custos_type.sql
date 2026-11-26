-- =====================================================================
-- Atualização 004: custos mensais por Type e lucro líquido
-- Correr UMA vez no SQL Editor, depois da 003.
-- =====================================================================

-- ---------- Custos mensais por Type ----------
create table if not exists public.type_costs (
  type          text primary key,               -- valor do campo "Type" dos subscritores (ex.: C, P)
  monthly_cost  numeric(10,2) not null default 0 check (monthly_cost >= 0),
  updated_at    timestamptz not null default now()
);

insert into public.type_costs (type, monthly_cost) values ('C', 2.20), ('P', 1.50)
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

-- ---------- Vista com estado e lucro calculados ----------
-- security_invoker = true → a vista respeita o RLS de quem consulta
-- Lucro anual = Value anual − Commission anual − custo mensal do Type × 12
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
