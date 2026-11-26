-- =====================================================================
-- Atualização 008: método de pagamento nas renovações
-- Correr UMA vez no SQL Editor, depois da 007.
-- =====================================================================

alter table public.renewals add column if not exists payment_method text;

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

