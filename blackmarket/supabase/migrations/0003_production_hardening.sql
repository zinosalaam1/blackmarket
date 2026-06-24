-- ============================================================================
-- THE BLACK MARKET — production hardening
-- Adds an admin-only "start a new round" function, since get_or_create_lobby()
-- otherwise keeps returning the same lobby forever once one exists.
-- ============================================================================

create or replace function admin_reset_game(p_game_id uuid)
returns games
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _require_admin(p_game_id);
  -- Archive the old session — its rows stay in the DB for history/audit,
  -- they just stop being the "active" lobby/game.
  update games set status = 'ended' where id = p_game_id and status <> 'ended';
  return get_or_create_lobby();
end;
$$;

grant execute on function admin_reset_game(uuid) to authenticated, anon;
