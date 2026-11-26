-- =====================================================================
-- Atualização 009: cor por Type
-- Correr UMA vez no SQL Editor, depois da 008.
-- =====================================================================

alter table public.type_costs add column if not exists color text;

update public.type_costs set color = '#2563eb' where type = 'C' and color is null;
update public.type_costs set color = '#ea580c' where type = 'P' and color is null;
