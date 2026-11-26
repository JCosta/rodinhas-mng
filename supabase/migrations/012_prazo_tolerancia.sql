-- =====================================================================
-- Atualização 012: prazo para o atraso tolerado ("Manter ligado até…") + permissão para o backup
-- Correr UMA vez no SQL Editor, depois da 011.
-- =====================================================================

alter table public.subscribers add column if not exists keep_active_until date;

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
     and s.keep_active
     and (s.keep_active_until is null
          or s.keep_active_until >= current_date) then 'em_atraso'
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
  perform set_config('app.in_renew', '1', true);   -- marca: renovação feita pela função (auditoria)
  insert into public.renewals (subscriber_id, payment_date, period_start, period_end, value, commission, paid, payment_method, notes)
  values (s.id, v_dt, v_ini, v_fim, coalesce(p_value, s.value), coalesce(p_commission, s.commission), p_paid, nullif(trim(p_method), ''), p_notes);

  update public.subscribers
     set payment_due_date  = v_fim,
         last_payment_date = case when p_paid then v_dt else last_payment_date end,
         value             = case when p_months is null then coalesce(p_value, value) else value end,
         commission        = case when p_months is null then coalesce(p_commission, commission) else commission end,
         keep_active       = false,
         keep_active_until = null,
         active            = true
   where id = s.id
  returning * into s;
  perform set_config('app.in_renew', '', true);

  return s;
end $$;

revoke all on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer, text) from public, anon;
grant execute on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer, text) to authenticated;

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
    -- atualização automática do LastPaymentDate (já registada como pagamento)
    if current_setting('app.in_sync', true) = '1' then return new; end if;
    d := public.audit_diff(to_jsonb(old), to_jsonb(new));
    if d = '{}'::jsonb then return new; end if;
    act := case
      when d ?& array['last_notified_at'] and (select count(*) from jsonb_object_keys(d)) = 1 then 'aviso'
      when (d ? 'keep_active' or d ? 'keep_active_until')
       and not exists (select 1 from jsonb_object_keys(d) k where k not in ('keep_active', 'keep_active_until')) then
        case when new.keep_active then 'ligar' else 'desligar' end
      else 'editar' end;
    perform public.audit_write(act, 'subscriber', new.id::text, new.code, d);
  end if;
  return coalesce(new, old);
end $$;

-- Backup semanal: a secret key (service_role) precisa de ler a lista de admins
grant select on public.admins to service_role;
