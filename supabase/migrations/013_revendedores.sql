-- =====================================================================
-- Atualização 013: revendedores e estado das comissões
-- Correr UMA vez no SQL Editor, depois da 012.
-- =====================================================================

-- ---------- Revendedores (recebem as comissões) ----------
create table if not exists public.resellers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  contact     text,
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.resellers enable row level security;
drop policy if exists "resellers: admins" on public.resellers;
create policy "resellers: admins" on public.resellers
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));
revoke all on public.resellers from anon;
grant select, insert, update, delete on public.resellers to authenticated;
grant select on public.resellers to service_role;

alter table public.subscribers add column if not exists reseller_id uuid references public.resellers(id) on delete set null;
alter table public.renewals    add column if not exists reseller_id uuid references public.resellers(id) on delete set null;
alter table public.renewals    add column if not exists commission_paid boolean not null default false;
alter table public.renewals    add column if not exists commission_paid_at date;
create index if not exists renewals_reseller_idx on public.renewals (reseller_id, commission_paid);

-- O pagamento fica com o revendedor que o subscritor tinha nesse momento
create or replace function public.renewal_set_reseller()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.reseller_id is null then
    select reseller_id into new.reseller_id from public.subscribers where id = new.subscriber_id;
  end if;
  if not new.commission_paid then new.commission_paid_at := null;
  elsif new.commission_paid_at is null then new.commission_paid_at := current_date;
  end if;
  return new;
end $$;
drop trigger if exists renewal_set_reseller on public.renewals;
create trigger renewal_set_reseller before insert or update on public.renewals
  for each row execute function public.renewal_set_reseller();

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
  (tc.type is null)                                                             as type_sem_custo,
  rv.name                                                                       as reseller_name
from public.subscribers s
left join public.type_costs tc on tc.type = s.type
left join public.resellers rv on rv.id = s.reseller_id;

revoke all on public.subscribers_status from anon;
grant select on public.subscribers_status to authenticated, service_role;

-- Renovações / pagamentos (histórico)
--   renovar     = botão Renovar (função renew_subscriber)
--   pagamento   = pagamento acrescentado à mão ao histórico
--   editar_pag  = pagamento do histórico alterado
--   apagar_pag  = pagamento do histórico apagado (não regista os apagados em cascata com o subscritor)
create or replace function public.audit_renewals()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare c text; r public.renewals; d jsonb;
begin
  r := coalesce(new, old);
  select code into c from public.subscribers where id = r.subscriber_id;
  if tg_op = 'DELETE' then
    if c is null then return old; end if;   -- subscritor apagado: já fica registado como "apagar"
    perform public.audit_write('apagar_pag', 'renewal', old.id::text, c,
      to_jsonb(old) - 'id' - 'user_id' - 'subscriber_id' - 'created_at');
  elsif tg_op = 'UPDATE' then
    d := public.audit_diff(to_jsonb(old), to_jsonb(new));
    if d = '{}'::jsonb then return new; end if;
    perform public.audit_write('editar_pag', 'renewal', new.id::text, c, d);
  else
    perform public.audit_write(
      case when current_setting('app.in_renew', true) = '1' then 'renovar' else 'pagamento' end,
      'renewal', new.id::text, c,
      jsonb_build_object('payment_date', new.payment_date, 'period_start', new.period_start, 'period_end', new.period_end,
                         'value', new.value, 'commission', new.commission, 'paid', new.paid,
                         'payment_method', new.payment_method, 'notes', new.notes,
                         'reseller', (select name from public.resellers where id = new.reseller_id),
                         'commission_paid', new.commission_paid));
  end if;
  return r;
end $$;

drop trigger if exists audit_renewals on public.renewals;
create trigger audit_renewals after insert or update or delete on public.renewals
  for each row execute function public.audit_renewals();

-- Configuração: custos por Type e definições
create or replace function public.audit_config()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare ent text := case tg_table_name when 'type_costs' then 'type_cost' when 'payment_methods' then 'payment_method' when 'resellers' then 'reseller' else 'setting' end;
        rid text;
begin
  rid := coalesce(to_jsonb(new), to_jsonb(old)) ->> case tg_table_name when 'type_costs' then 'type' when 'payment_methods' then 'name' when 'resellers' then 'name' else 'key' end;
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
drop trigger if exists audit_resellers on public.resellers;
create trigger audit_resellers after insert or update or delete on public.resellers
  for each row execute function public.audit_config();
drop trigger if exists audit_app_settings on public.app_settings;
create trigger audit_app_settings after insert or update or delete on public.app_settings
  for each row execute function public.audit_config();

