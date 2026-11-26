-- =====================================================================
-- Atualização 002: estado "desligado"
-- Sem PaymentDueDate, ou com PaymentDueDate já passado → desligado.
-- Correr UMA vez no SQL Editor (para quem já correu o schema.sql antes).
-- =====================================================================

alter table public.subscribers alter column payment_due_date drop not null;

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
drop function if exists public.renew_subscriber(uuid, numeric, numeric, boolean, text, date);
create or replace function public.renew_subscriber(
  p_id            uuid,
  p_value         numeric default null,   -- null = Value atual
  p_commission    numeric default null,   -- null = Commission atual
  p_paid          boolean default true,
  p_notes         text default null,
  p_payment_date  date default null,      -- null = hoje
  p_start         date default null       -- início do novo período (null = automático)
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
begin
  select * into s from public.subscribers where id = p_id for update;
  if not found then
    raise exception 'Subscritor não encontrado ou sem permissão';
  end if;

  v_ini := coalesce(p_start, s.payment_due_date, v_dt);
  v_fim := (v_ini + case s.periodicity when 'anual' then interval '1 year' else interval '6 months' end)::date;

  insert into public.renewals (subscriber_id, payment_date, period_start, period_end, value, commission, paid, notes)
  values (s.id, v_dt, v_ini, v_fim, coalesce(p_value, s.value), coalesce(p_commission, s.commission), p_paid, p_notes);

  update public.subscribers
     set payment_due_date  = v_fim,
         last_payment_date = case when p_paid then v_dt else last_payment_date end,
         value             = coalesce(p_value, value),
         commission        = coalesce(p_commission, commission),
         active            = true
   where id = s.id
  returning * into s;

  return s;
end $$;

revoke all on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date) from public, anon;
grant execute on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date) to authenticated;

