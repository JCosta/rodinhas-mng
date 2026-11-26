-- =====================================================================
-- Atualização 014: 2FA obrigatória para os admins
-- ATENÇÃO: depois de correr isto, a app passa a pedir a ativação do 2FA
-- no próximo login (app autenticadora: Google/Microsoft Authenticator, 1Password…).
-- Correr UMA vez no SQL Editor, depois da 013.
-- =====================================================================

create table if not exists public.admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  require_mfa boolean not null default true,   -- exige 2FA (código da app autenticadora) para aceder aos dados
  created_at  timestamptz not null default now()
);
alter table public.admins add column if not exists require_mfa boolean not null default true;
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;
grant select on public.admins to service_role;   -- para o backup semanal

-- Admin = está na tabela admins E (se require_mfa) a sessão foi verificada com 2FA (aal2).
-- Sem 2FA, a base de dados não devolve nem altera nada — mesmo que alguém tenha a password.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
      and (not a.require_mfa
           or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1') = 'aal2')
  );
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Para a app saber se a conta é admin (antes de pedir o 2FA). Não dá acesso a dados.
create or replace function public.admin_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'admin', exists (select 1 from public.admins where user_id = auth.uid()),
    'require_mfa', coalesce((select require_mfa from public.admins where user_id = auth.uid()), true),
    'aal', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', 'aal1'));
$$;
revoke all on function public.admin_status() from public, anon;
grant execute on function public.admin_status() to authenticated;

