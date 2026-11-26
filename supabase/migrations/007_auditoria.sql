-- =====================================================================
-- Atualização 007: log de auditoria
-- Correr UMA vez no SQL Editor, depois da 006.
-- =====================================================================

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

revoke all on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer) from public, anon;
grant execute on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer) to authenticated;

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
                       'value', new.value, 'commission', new.commission, 'paid', new.paid, 'notes', new.notes));
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
declare ent text := case tg_table_name when 'type_costs' then 'type_cost' else 'setting' end;
        rid text;
begin
  rid := coalesce(to_jsonb(new), to_jsonb(old)) ->> case when tg_table_name = 'type_costs' then 'type' else 'key' end;
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
drop trigger if exists audit_app_settings on public.app_settings;
create trigger audit_app_settings after insert or update or delete on public.app_settings
  for each row execute function public.audit_config();
