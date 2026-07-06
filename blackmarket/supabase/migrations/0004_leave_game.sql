-- ============================================================================
-- THE BLACK MARKET — fix: actually leaving the lobby/game
--
-- Previously "Leave Lobby" / "Exit" just reloaded the page. Since the
-- player's row was never removed, and the same browser keeps the same
-- anonymous auth session (persisted in localStorage), reloading always
-- found the same player row again and dropped you right back in.
--
-- leave_game() deletes your player row for the given game, so after
-- calling it a reload correctly shows the signup screen again.
-- ============================================================================

create or replace function leave_game(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  delete from players where game_id = p_game_id and user_id = auth.uid();
end;
$$;

grant execute on function leave_game(uuid) to authenticated, anon;
