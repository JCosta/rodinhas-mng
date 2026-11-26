-- =====================================================================
-- Atualização 005: arquivados e mensagem de aviso (WhatsApp)
-- Correr UMA vez no SQL Editor, depois da 004.
-- =====================================================================

alter table public.subscribers add column if not exists last_notified_at date;

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
-- Estados: cancelado (manual) · arquivado (sem PaymentDueDate) · desligado (data passada)
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
