-- ============================================================================
-- THE BLACK MARKET — real accounts + multi-room hosting + delete-player fix
--
-- 1) FIX: players couldn't always be deleted — auctions.current_bidder_id
--    and contracts.accepted_by had no ON DELETE behavior, so deleting a
--    player who'd bid or accepted a contract hit a foreign-key violation.
-- 2) Real accounts: email+password signup/login replaces anonymous-only
--    auth. A `profiles` table holds your permanent handle, tied to your
--    account rather than re-typed per room.
-- 3) Multi-room: anyone (once logged in) can host their own room
--    (`create_room()`), becoming its admin automatically, and share a
--    6-character code / link. Replaces the old single global lobby and
--    the shared admin-code model entirely.
-- ============================================================================

-- ── 1) Delete-player fix ─────────────────────────────────────────────────────

alter table auctions drop constraint if exists auctions_current_bidder_id_fkey;
alter table auctions add constraint auctions_current_bidder_id_fkey
  foreign key (current_bidder_id) references players(id) on delete set null;

alter table contracts drop constraint if exists contracts_accepted_by_fkey;
alter table contracts add constraint contracts_accepted_by_fkey
  foreign key (accepted_by) references players(id) on delete set null;

-- ── 2) Profiles (permanent handle per account) ──────────────────────────────

create table if not exists profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  handle     text not null unique,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
create policy "read own profile" on profiles for select using (user_id = auth.uid());

create or replace function create_profile(p_handle text)
returns profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  cleaned text;
  result profiles;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  cleaned := upper(regexp_replace(trim(p_handle), '\s+', '_', 'g'));
  if length(cleaned) < 3 or length(cleaned) > 16 or cleaned !~ '^[A-Z0-9_]+$' then
    raise exception 'INVALID_HANDLE';
  end if;

  if exists (select 1 from profiles where handle = cleaned and user_id <> auth.uid()) then
    raise exception 'HANDLE_TAKEN';
  end if;

  insert into profiles (user_id, handle) values (auth.uid(), cleaned)
  on conflict (user_id) do update set handle = excluded.handle
  returning * into result;

  return result;
end;
$$;

grant execute on function create_profile(text) to authenticated, anon;

-- ── 3) Room codes (multi-room) ──────────────────────────────────────────────

alter table games add column if not exists code text;

create or replace function _generate_room_code_raw()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; -- no 0/O or 1/I — easy to read aloud
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

do $$
declare r record;
begin
  for r in select id from games where code is null loop
    update games set code = _generate_room_code_raw() where id = r.id;
  end loop;
end;
$$;

alter table games alter column code set not null;
create unique index if not exists idx_games_active_code on games(code) where status <> 'ended';

create or replace function _seed_room(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
  rumor record;
  contract record;
begin
  for item in select * from _market_template() loop
    insert into market_items (game_id, id, name, tier, price, base_price, is_illegal, history)
    values (p_game_id, item.id, item.name, item.tier, item.base_price, item.base_price, item.is_illegal, _init_history(item.base_price));
  end loop;

  for rumor in select * from _rumor_template() loop
    insert into rumors (game_id, id, text, credibility, cost) values (p_game_id, rumor.id, rumor.text, rumor.credibility, rumor.cost);
  end loop;

  insert into auctions (game_id, name, icon, current_bid, bid_count, ends_at)
  values (p_game_id, 'Golden Passport', '🛂', 8500, 6, now() + interval '90 seconds');

  for contract in select * from _contract_template() order by random() limit 4 loop
    insert into contracts (game_id, author, demand, reward, risk, is_illegal, item_id, qty_required, expires_at)
    values (p_game_id, contract.author, contract.demand, contract.reward, contract.risk, contract.is_illegal, contract.item_id, contract.qty_required, now() + (contract.ttl_seconds || ' seconds')::interval);
  end loop;

  insert into events (game_id, type, text) values (p_game_id, 'neutral', 'THE BLACK MARKET is now open.');
end;
$$;

create or replace function create_room()
returns games
language plpgsql
security definer
set search_path = public
as $$
declare
  g games;
  v_code text;
  my_handle text;
  attempt int := 0;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select handle into my_handle from profiles where user_id = auth.uid();
  if my_handle is null then
    raise exception 'PROFILE_REQUIRED';
  end if;

  loop
    attempt := attempt + 1;
    v_code := _generate_room_code_raw();
    begin
      insert into games (code) values (v_code) returning * into g;
      exit;
    exception when unique_violation then
      if attempt > 20 then
        raise exception 'CODE_GEN_FAILED';
      end if;
    end;
  end loop;

  perform _seed_room(g.id);
  insert into players (game_id, user_id, handle, is_admin) values (g.id, auth.uid(), my_handle, true);

  return g;
end;
$$;

create or replace function _room_by_code(p_code text)
returns games
language sql
security definer
set search_path = public
as $$
  select * from games where code = upper(trim(p_code)) and status <> 'ended' order by created_at desc limit 1;
$$;

create or replace function join_room(p_code text)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  g games;
  my_handle text;
  p players;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  select handle into my_handle from profiles where user_id = auth.uid();
  if my_handle is null then
    raise exception 'PROFILE_REQUIRED';
  end if;

  g := _room_by_code(p_code);
  if g.id is null then
    raise exception 'ROOM_NOT_FOUND';
  end if;

  select * into p from players where game_id = g.id and user_id = auth.uid();
  if p.id is not null then
    update players set online = true where id = p.id returning * into p;
    return p;
  end if;

  if exists (select 1 from players where game_id = g.id and handle = my_handle) then
    raise exception 'HANDLE_TAKEN';
  end if;

  insert into players (game_id, user_id, handle) values (g.id, auth.uid(), my_handle) returning * into p;
  return p;
end;
$$;

create or replace function admin_reset_game(p_game_id uuid)
returns games
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _require_admin(p_game_id);
  update games set status = 'ended' where id = p_game_id and status <> 'ended';
  return create_room();
end;
$$;

-- Retire the old single-lobby / shared-admin-code entry points.
drop function if exists get_or_create_lobby();
drop function if exists join_game(text);
drop function if exists admin_login(text);
drop table if exists app_settings;

grant execute on function create_room(), join_room(text) to authenticated, anon;

-- ============================================================================
-- RLS — scope every read to "rooms you're actually a player in." Necessary
-- now that rooms are meant to be private-by-code rather than one shared,
-- fully-public lobby.
-- ============================================================================

create or replace function _my_game_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select game_id from players where user_id = auth.uid();
$$;

drop policy if exists "read games" on games;
create policy "read my rooms" on games for select using (id in (select _my_game_ids()));

drop policy if exists "read players" on players;
create policy "read players in my rooms" on players for select using (game_id in (select _my_game_ids()));

drop policy if exists "read market_items" on market_items;
create policy "read market_items in my rooms" on market_items for select using (game_id in (select _my_game_ids()));

drop policy if exists "read rumors" on rumors;
create policy "read rumors in my rooms" on rumors for select using (game_id in (select _my_game_ids()));

drop policy if exists "read events" on events;
create policy "read events in my rooms" on events for select using (game_id in (select _my_game_ids()));

drop policy if exists "read auctions" on auctions;
create policy "read auctions in my rooms" on auctions for select using (game_id in (select _my_game_ids()));

drop policy if exists "read contracts" on contracts;
create policy "read contracts in my rooms" on contracts for select using (game_id in (select _my_game_ids()));
