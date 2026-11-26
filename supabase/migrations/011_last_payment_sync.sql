-- =====================================================================
-- Atualização 011: LastPaymentDate atualizado pelo histórico de pagamentos
-- Correr UMA vez no SQL Editor, depois da 010.
-- =====================================================================

-- ---------- LastPaymentDate sincronizado com o histórico de pagamentos ----------
-- Inserir pagamento pago      → LastPaymentDate = o mais recente entre o atual e o novo
-- Editar/apagar o último      → recalcula a partir dos pagamentos pagos que restam
--                               (se não restar nenhum, mantém o valor atual)
create or replace function public.sync_last_payment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  sid   uuid := coalesce(new.subscriber_id, old.subscriber_id);
  atual date;
  maxp  date;
begin
  select last_payment_date into atual from public.subscribers where id = sid;
  if not found then return coalesce(new, old); end if;   -- subscritor a ser apagado
  select max(payment_date) into maxp from public.renewals where subscriber_id = sid and paid;

  perform set_config('app.in_sync', '1', true);
  if tg_op = 'INSERT' then
    if new.paid and (atual is null or new.payment_date > atual) then
      update public.subscribers set last_payment_date = new.payment_date where id = sid;
    end if;
  elsif (tg_op = 'DELETE' and old.paid and old.payment_date = atual)
     or (tg_op = 'UPDATE' and ((old.paid and old.payment_date = atual) or (new.paid and (atual is null or new.payment_date > atual)))) then
    update public.subscribers set last_payment_date = coalesce(maxp, atual) where id = sid;
  end if;
  perform set_config('app.in_sync', '', true);
  return coalesce(new, old);
end $$;

drop trigger if exists sync_last_payment on public.renewals;
create trigger sync_last_payment after insert or update or delete on public.renewals
  for each row execute function public.sync_last_payment();

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
      when d ? 'keep_active' and (select count(*) from jsonb_object_keys(d)) = 1 then
        case when new.keep_active then 'ligar' else 'desligar' end
      else 'editar' end;
    perform public.audit_write(act, 'subscriber', new.id::text, new.code, d);
  end if;
  return coalesce(new, old);
end $$;


-- Corrigir os dados existentes: LastPaymentDate = o mais recente entre o atual e o histórico
select set_config('app.in_sync', '1', false);
update public.subscribers s
   set last_payment_date = h.maxp
  from (select subscriber_id, max(payment_date) as maxp from public.renewals where paid group by subscriber_id) h
 where h.subscriber_id = s.id
   and (s.last_payment_date is null or h.maxp > s.last_payment_date);
select set_config('app.in_sync', '', false);
