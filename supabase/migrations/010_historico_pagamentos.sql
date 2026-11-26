-- =====================================================================
-- Atualização 010: histórico de pagamentos editável (auditoria de pagamentos manuais)
-- Correr UMA vez no SQL Editor, depois da 009.
-- =====================================================================

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
         active            = true
   where id = s.id
  returning * into s;
  perform set_config('app.in_renew', '', true);

  return s;
end $$;

revoke all on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer, text) from public, anon;
grant execute on function public.renew_subscriber(uuid, numeric, numeric, boolean, text, date, date, integer, text) to authenticated;

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
                         'payment_method', new.payment_method, 'notes', new.notes));
  end if;
  return r;
end $$;

drop trigger if exists audit_renewals on public.renewals;
create trigger audit_renewals after insert or update or delete on public.renewals
  for each row execute function public.audit_renewals();

