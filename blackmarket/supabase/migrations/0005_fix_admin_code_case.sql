-- ============================================================================
-- THE BLACK MARKET — fix: admin code comparison was case-sensitive on the
-- stored side. admin_login() uppercased the typed code but compared it
-- against the RAW stored value, so any admin_code containing lowercase
-- letters could never match anything you typed.
-- ============================================================================

create or replace function admin_login(p_code text)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  g games;
  p players;
  stored text;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select value into stored from app_settings where key = 'admin_code';
  if stored is null or upper(trim(p_code)) <> upper(trim(stored)) then
    raise exception 'INVALID_CODE';
  end if;

  g := get_or_create_lobby();

  insert into players (game_id, user_id, handle, is_admin)
  values (g.id, auth.uid(), 'ADMIN', true)
  on conflict (game_id, user_id) do update set is_admin = true, online = true
  returning * into p;

  return p;
end;
$$;
