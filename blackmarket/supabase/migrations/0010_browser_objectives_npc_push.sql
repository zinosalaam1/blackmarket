-- ============================================================================
-- THE BLACK MARKET — Room Browser, Objective Evaluation, Real NPC Trading,
--                    Push Notification Infrastructure
-- ============================================================================

-- ── Schema additions ──────────────────────────────────────────────────────────

-- Games: public room browser
alter table games
  add column if not exists is_public     boolean not null default false,
  add column if not exists player_count  int     not null default 0,
  add column if not exists room_name     text;

-- Players: objective tracking, peak rank, NPC strategy
alter table players
  add column if not exists objective_completed  boolean,
  add column if not exists objective_score      text,
  add column if not exists crash_triggers       int not null default 0,
  add column if not exists illegal_trade_count  int not null default 0,
  add column if not exists ops_actions_count    int not null default 0,
  add column if not exists kingmaker_target_id  uuid references players(id),
  add column if not exists npc_strategy         text not null default 'opportunist',
  add column if not exists peak_rank            int;

-- Market items: track who pumped each item (for crash_triggers attribution)
alter table market_items
  add column if not exists pump_placer_id uuid references players(id) on delete set null;

-- Device tokens for push notifications
create table if not exists device_tokens (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  token      text        not null,
  platform   text        not null check (platform in ('android','ios','web')),
  updated_at timestamptz not null default now(),
  unique (user_id, platform)
);
alter table device_tokens enable row level security;
create policy "manage own device tokens" on device_tokens
  for all using (user_id = auth.uid());

-- ── Room browser RLS: public rooms readable by any authenticated user ─────────

drop policy if exists "read my rooms" on games;
create policy "read my rooms or public rooms" on games
  for select using (
    id in (select _my_game_ids())
    or (is_public = true and status in ('lobby','playing'))
  );

-- ── list_public_rooms() ───────────────────────────────────────────────────────

create or replace function list_public_rooms()
returns table(
  id uuid, code text, room_name text, status text, phase text,
  player_count int, created_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select g.id, g.code, g.room_name, g.status, g.phase, g.player_count, g.created_at
  from games g
  where g.is_public = true and g.status in ('lobby','playing')
  order by g.player_count desc, g.created_at desc
  limit 20;
$$;
grant execute on function list_public_rooms() to authenticated, anon;

-- ── Updated create_room: public flag + room name ──────────────────────────────

create or replace function create_room(p_is_public boolean default false, p_room_name text default null)
returns games
language plpgsql
security definer
set search_path = public
as $$
declare
  g         games;
  v_code    text;
  my_handle text;
  attempt   int := 0;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select handle into my_handle from profiles where user_id = auth.uid();
  if my_handle is null then raise exception 'PROFILE_REQUIRED'; end if;

  loop
    attempt := attempt + 1;
    v_code := _generate_room_code_raw();
    begin
      insert into games (code, is_public, room_name)
      values (v_code, p_is_public, p_room_name)
      returning * into g;
      exit;
    exception when unique_violation then
      if attempt > 20 then raise exception 'CODE_GEN_FAILED'; end if;
    end;
  end loop;

  perform _seed_room(g.id);
  insert into players (game_id, user_id, handle, is_admin)
  values (g.id, auth.uid(), my_handle, true);
  update games set player_count = 1 where id = g.id;
  select * into g from games where id = g.id;
  return g;
end;
$$;

-- ── Updated join_room: increment player_count ─────────────────────────────────

create or replace function join_room(p_code text)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  g         games;
  my_handle text;
  p         players;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;

  select handle into my_handle from profiles where user_id = auth.uid();
  if my_handle is null then raise exception 'PROFILE_REQUIRED'; end if;

  g := _room_by_code(p_code);
  if g.id is null then raise exception 'ROOM_NOT_FOUND'; end if;

  select * into p from players where game_id = g.id and user_id = auth.uid();
  if p.id is not null then
    update players set online = true where id = p.id returning * into p;
    return p;
  end if;

  if exists (select 1 from players where game_id = g.id and handle = my_handle) then
    raise exception 'HANDLE_TAKEN';
  end if;

  insert into players (game_id, user_id, handle) values (g.id, auth.uid(), my_handle) returning * into p;
  update games set player_count = player_count + 1 where id = g.id;
  return p;
end;
$$;

-- ── Updated leave_game: decrement player_count ───────────────────────────────

create or replace function leave_game(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  delete from players where game_id = p_game_id and user_id = auth.uid();
  update games set player_count = greatest(0, player_count - 1) where id = p_game_id;
end;
$$;

-- ── pump_item: track pump_placer_id + ops_actions_count ──────────────────────

create or replace function pump_item(p_game_id uuid, p_item_id text)
returns market_items
language plpgsql security definer set search_path = public
as $$
declare
  me   players;
  mkt  market_items;
  cost numeric;
  new_price numeric;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;
  if me.frozen_until is not null and me.frozen_until > now() then raise exception 'PLAYER_FROZEN'; end if;

  select * into mkt from market_items where game_id = p_game_id and id = p_item_id;
  if mkt.id is null then raise exception 'UNKNOWN_ITEM'; end if;
  if mkt.pump_until is not null and mkt.pump_until > now() then raise exception 'ALREADY_PUMPED'; end if;

  cost := case mkt.tier when 'legendary' then 25000 when 'rare' then 10000 else 3000 end;
  if me.cash < cost then raise exception 'INSUFFICIENT_FUNDS'; end if;

  new_price := round(mkt.price * 1.6);
  update players
  set cash = cash - cost, ops_actions_count = ops_actions_count + 1
  where id = me.id;

  update market_items
  set price = new_price, pump_until = now() + interval '60 seconds',
      pump_placer_id = me.id,
      change = new_price - mkt.price, change_percent = 60, trend = 'up'
  where game_id = p_game_id and id = p_item_id
  returning * into mkt;

  insert into events (game_id, type, text)
  values (p_game_id, 'neutral',
    '📈 PUMP DETECTED — ' || mkt.name || ' is surging. Someone''s moving big money. Dump incoming.');
  return mkt;
end;
$$;

-- ── place_bounty / target_blackout / assassinate_player: track ops_actions ───

create or replace function place_bounty(p_game_id uuid, p_target_id uuid, p_amount numeric)
returns bounties
language plpgsql security definer set search_path = public
as $$
declare
  me target players; b bounties;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;
  if me.frozen_until is not null and me.frozen_until > now() then raise exception 'PLAYER_FROZEN'; end if;
  select * into target from players where id = p_target_id and game_id = p_game_id;
  if target.id is null then raise exception 'UNKNOWN_TARGET'; end if;
  if target.id = me.id then raise exception 'CANT_TARGET_SELF'; end if;
  if target.is_admin then raise exception 'CANT_TARGET_ADMIN'; end if;
  if p_amount < 2000 then raise exception 'BOUNTY_TOO_LOW'; end if;
  if p_amount > me.cash then raise exception 'INSUFFICIENT_FUNDS'; end if;

  update players set cash = cash - p_amount, ops_actions_count = ops_actions_count + 1 where id = me.id;
  insert into bounties (game_id, placer_id, target_id, amount) values (p_game_id, me.id, p_target_id, p_amount) returning * into b;
  insert into events (game_id, type, text)
  values (p_game_id, 'raid', '🎯 BOUNTY PLACED — ' || target.handle || ' has a target on their back. ' || me.handle || ' paid ' || p_amount::text);
  return b;
end;
$$;

create or replace function target_blackout(p_game_id uuid, p_target_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me target players; cost constant numeric := 5000;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;
  if me.frozen_until is not null and me.frozen_until > now() then raise exception 'PLAYER_FROZEN'; end if;
  if me.cash < cost then raise exception 'INSUFFICIENT_FUNDS'; end if;
  select * into target from players where id = p_target_id and game_id = p_game_id;
  if target.id is null then raise exception 'UNKNOWN_TARGET'; end if;
  if target.id = me.id then raise exception 'CANT_TARGET_SELF'; end if;
  if target.is_admin then raise exception 'CANT_TARGET_ADMIN'; end if;
  update players set cash = cash - cost, ops_actions_count = ops_actions_count + 1 where id = me.id;
  update players set player_blackout_until = now() + interval '90 seconds' where id = p_target_id;
  insert into events (game_id, type, text) values (p_game_id, 'blackout', '📡 SIGNAL JAM — an operator''s price feed has been blinded for 90 seconds.');
end;
$$;

create or replace function assassinate_player(p_game_id uuid, p_target_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me target players; cost constant numeric := 75000;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;
  if me.frozen_until is not null and me.frozen_until > now() then raise exception 'PLAYER_FROZEN'; end if;
  if me.cash < cost then raise exception 'INSUFFICIENT_FUNDS'; end if;
  select * into target from players where id = p_target_id and game_id = p_game_id;
  if target.id is null then raise exception 'UNKNOWN_TARGET'; end if;
  if target.id = me.id then raise exception 'CANT_TARGET_SELF'; end if;
  if target.is_admin then raise exception 'CANT_TARGET_ADMIN'; end if;
  if target.frozen_until is not null and target.frozen_until > now() then raise exception 'TARGET_ALREADY_FROZEN'; end if;
  update players set cash = cash - cost, ops_actions_count = ops_actions_count + 1 where id = me.id;
  update players set frozen_until = now() + interval '90 seconds' where id = p_target_id;
  insert into events (game_id, type, text)
  values (p_game_id, 'crash', '☠️ ACCOUNT FROZEN — ' || target.handle || ' has been neutralised for 90 seconds. They cannot trade.');
end;
$$;

-- ── Updated admin_auto_assign_objectives: set kingmaker_target_id ─────────────

create or replace function admin_auto_assign_objectives(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  pool text[] := _objective_pool();
  rec  record;
  i    int := 0;
  non_admins uuid[];
  km_target  uuid;
begin
  perform _require_admin(p_game_id);

  -- Collect non-admin player ids for kingmaker target assignment
  select array_agg(id) into non_admins
  from players where game_id = p_game_id and is_admin = false;

  for rec in select id from players where game_id = p_game_id and is_admin = false order by joined_at loop
    update players set objective_id = pool[1 + (i % array_length(pool,1))] where id = rec.id;

    -- Assign a random kingmaker target (different player)
    if pool[1 + (i % array_length(pool,1))] = 'kingmaker' then
      select id into km_target from players
      where game_id = p_game_id and is_admin = false and id <> rec.id
      order by random() limit 1;
      update players set kingmaker_target_id = km_target where id = rec.id;
    end if;
    i := i + 1;
  end loop;
end;
$$;

-- ── Objective evaluation ──────────────────────────────────────────────────────

create or replace function evaluate_objectives(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  rec          record;
  total_p      int;
  rank_num     int := 0;
  completed    boolean;
  score_text   text;
  inv_count    int;
  rumor_count  int;
  km_rank      int;
begin
  select count(*) into total_p
  from players where game_id = p_game_id and is_admin = false;

  for rec in
    select p.*, row_number() over (order by p.net_worth desc) as rn
    from players p
    where p.game_id = p_game_id and p.is_admin = false
  loop
    completed := false;
    score_text := null;

    case rec.objective_id
      when 'tycoon' then
        completed := rec.rn = 1;
        score_text := 'Finish #1 by net worth — you ranked #' || rec.rn;

      when 'broker' then
        completed := rec.trade_count >= 50;
        score_text := rec.trade_count::text || '/50 trades completed';

      when 'collector' then
        select count(*) into inv_count
        from inventory i
        join market_items m on m.id = i.item_id and m.game_id = p_game_id
        where i.player_id = rec.id and m.tier in ('rare','legendary');
        completed := inv_count >= 5;
        score_text := inv_count::text || '/5 rare/legendary items held at game end';

      when 'saboteur' then
        completed := rec.crash_triggers >= 3;
        score_text := rec.crash_triggers::text || '/3 market crashes triggered via pump & dump';

      when 'smuggler' then
        completed := rec.illegal_trade_count >= 3 and rec.wanted_level < 5;
        score_text := rec.illegal_trade_count::text || '/3 illegal trades, heat level ' || rec.wanted_level::text || '/5';

      when 'informant' then
        select count(*) into rumor_count
        from rumor_purchases where game_id = p_game_id and player_id = rec.id;
        completed := rumor_count >= 5;
        score_text := rumor_count::text || '/5 intel rumors purchased';

      when 'kingmaker' then
        if rec.kingmaker_target_id is not null then
          select rn::int into km_rank from (
            select id, row_number() over (order by net_worth desc) as rn
            from players where game_id = p_game_id and is_admin = false
          ) ranked where id = rec.kingmaker_target_id;
          completed := coalesce(km_rank, 999) <= 3;
          score_text := 'Your assigned target finished #' || coalesce(km_rank::text, '?');
        else
          score_text := 'No target was assigned';
        end if;

      when 'ghost' then
        -- Never in top 25%, clean record
        completed := coalesce(rec.peak_rank, 999) > greatest(1, total_p * 0.25)::int
                     and rec.wanted_level <= 1;
        score_text := 'Best rank achieved: #' || coalesce(rec.peak_rank::text,'?') ||
                      ', heat level: ' || rec.wanted_level::text;

      when 'chaos' then
        completed := rec.ops_actions_count >= 5;
        score_text := rec.ops_actions_count::text || '/5 covert operations executed';

      else
        completed := false;
        score_text := 'Unknown objective';
    end case;

    update players
    set objective_completed = completed, objective_score = score_text
    where id = rec.id;
  end loop;
end;
$$;

-- ── Full market_tick replacement (adds NPC trading + peak_rank) ───────────────

create or replace function market_tick(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  g             games;
  got_lock      boolean;
  elapsed       numeric;
  ticks         int;
  i             int;
  vol           numeric;
  drift         numeric;
  pct           numeric;
  it            record;
  new_price     numeric;
  random_event  record;
  end_remaining numeric;
  top_player    players;
  active_rid    text;
  event_interval int;
  open_ct       int;
  ctmpl         record;
  b             record;
  inv_it        record;
  l             record;
  seized_value  numeric;
  final_item_id text;
  -- NPC trading
  npc_r         record;
  npc_m         market_items;
  npc_i         record;
  npc_qty       int;
begin
  select pg_try_advisory_xact_lock(hashtext(p_game_id::text)) into got_lock;
  if not got_lock then return; end if;

  select * into g from games where id = p_game_id for update;
  if g.id is null or g.status <> 'playing' then return; end if;

  elapsed := extract(epoch from (now() - g.tick_at));
  ticks := least(floor(elapsed / 2)::int, 30);
  if ticks < 1 then return; end if;

  -- ── Price simulation ─────────────────────────────────────────────────────

  for i in 1..ticks loop
    for it in select * from market_items where game_id = p_game_id loop
      vol := case it.tier
               when 'legendary' then 0.10
               when 'rare'      then 0.07
               else                   0.04
             end;
      drift := random() * 2 - 1;
      pct := drift * vol * (case g.phase
               when 'COLLAPSE'    then 5.0
               when 'FINAL PHASE' then 2.0
               else                    1.0
             end);

      if it.pump_until is not null and it.pump_until > now() then
        pct := pct + 0.18;
      end if;

      if it.pump_until is not null and it.pump_until <= now() and it.pump_until > g.tick_at then
        new_price := greatest(round(it.base_price * 0.10), round(it.price * 0.40));
        update market_items
        set price = new_price, pump_until = null, pump_placer_id = null,
            change = new_price - it.price, change_percent = -60, trend = 'down',
            history = (case when jsonb_array_length(it.history) >= 60 then (it.history - 0) else it.history end) || to_jsonb(new_price)
        where game_id = p_game_id and id = it.id;
        if it.pump_placer_id is not null then
          update players set crash_triggers = crash_triggers + 1 where id = it.pump_placer_id;
        end if;
        insert into events (game_id, type, text)
        values (p_game_id, 'crash', '📉 DUMP — ' || it.name || ' collapses after the pump. Sellers bailed.');
        continue;
      end if;

      new_price := greatest(
        round(it.base_price * 0.10),
        least(round(it.base_price * 8), round(it.price * (1 + pct)))
      );
      update market_items
      set price = new_price,
          change = new_price - it.price,
          change_percent = case when it.price = 0 then 0 else ((new_price - it.price) / it.price) * 100 end,
          trend = case when new_price > it.price then 'up' when new_price < it.price then 'down' else 'stable' end,
          history = (case when jsonb_array_length(it.history) >= 60 then (it.history - 0) else it.history end) || to_jsonb(new_price)
      where game_id = p_game_id and id = it.id;
    end loop;
  end loop;

  -- ── NPC trading: 6% chance per NPC per tick ──────────────────────────────

  for npc_r in select * from players where game_id = p_game_id and is_npc = true loop
    if random() < 0.06 then
      if random() < 0.55 then
        -- BUY: strategy based on npc_strategy column
        case npc_r.npc_strategy
          when 'bull' then
            select * into npc_m from market_items
            where game_id = p_game_id and trend = 'up' and is_illegal = false
              and price > 0 and price <= npc_r.cash * 0.35
            order by change_percent desc limit 1;
          when 'bear' then
            select * into npc_m from market_items
            where game_id = p_game_id and trend = 'down' and is_illegal = false
              and price > 0 and price <= npc_r.cash * 0.40
            order by change_percent asc limit 1;
          else -- opportunist
            select * into npc_m from market_items
            where game_id = p_game_id and is_illegal = false
              and price > 0 and price <= npc_r.cash * 0.50
            order by random() limit 1;
        end case;

        if npc_m.id is not null then
          npc_qty := greatest(1, least(5, floor(npc_r.cash * 0.25 / npc_m.price)::int));
          if npc_r.cash >= npc_m.price * npc_qty then
            select * into npc_i from inventory where player_id = npc_r.id and item_id = npc_m.id;
            if npc_i is not null then
              update inventory
              set qty = npc_i.qty + npc_qty,
                  avg_buy = round((npc_i.avg_buy * npc_i.qty + npc_m.price * npc_qty) / (npc_i.qty + npc_qty))
              where player_id = npc_r.id and item_id = npc_m.id;
            else
              insert into inventory (player_id, item_id, qty, avg_buy)
              values (npc_r.id, npc_m.id, npc_qty, npc_m.price);
            end if;
            update players set cash = cash - npc_m.price * npc_qty, trade_count = trade_count + 1
            where id = npc_r.id;
            perform _recompute_net_worth(npc_r.id);
          end if;
        end if;

      else
        -- SELL: sell a profitable holding (8%+ gain)
        select i.item_id, i.qty, i.avg_buy, m.price as current_price
        into npc_i
        from inventory i
        join market_items m on m.id = i.item_id and m.game_id = p_game_id
        where i.player_id = npc_r.id and m.price >= i.avg_buy * 1.08
        order by (m.price::float / i.avg_buy) desc limit 1;

        if npc_i is not null and npc_i.item_id is not null then
          update players
          set cash = cash + npc_i.current_price * npc_i.qty, trade_count = trade_count + 1
          where id = npc_r.id;
          delete from inventory where player_id = npc_r.id and item_id = npc_i.item_id;
          perform _recompute_net_worth(npc_r.id);
        end if;
      end if;
    end if;

    -- NPC auction bidding: 2% chance
    for it in select * from auctions where game_id = p_game_id and settled = false and ends_at > now() loop
      if random() < 0.02 and npc_r.id <> coalesce(it.current_bidder_id, '00000000-0000-0000-0000-000000000000'::uuid) then
        new_price := it.current_bid + round(random() * 600 + 200);
        if npc_r.cash >= new_price then
          if it.current_bidder_id is not null then
            update players set cash = cash + it.current_bid where id = it.current_bidder_id;
          end if;
          update players set cash = cash - new_price where id = npc_r.id;
          update auctions set current_bid = new_price, current_bidder_id = npc_r.id, bid_count = bid_count + 1
          where id = it.id;
          perform _recompute_net_worth(npc_r.id);
        end if;
      end if;
    end loop;
  end loop;

  -- ── Peak rank tracking (updated after every net_worth recompute) ──────────

  update players p
  set peak_rank = case
    when p.peak_rank is null then ranked.rn::int
    when ranked.rn < p.peak_rank then ranked.rn::int
    else p.peak_rank
  end
  from (
    select id, row_number() over (order by net_worth desc) as rn
    from players where game_id = p_game_id and is_admin = false
  ) ranked
  where p.id = ranked.id and p.game_id = p_game_id;

  -- ── Auctions ─────────────────────────────────────────────────────────────

  update auctions
  set current_bid = case when random() > 0.75 then current_bid + round(random()*800+300) else current_bid end,
      bid_count   = case when random() > 0.75 then bid_count + 1 else bid_count end
  where game_id = p_game_id and settled = false and ends_at > now() and is_final = false;

  for it in select * from auctions where game_id = p_game_id and settled = false and ends_at <= now() loop
    if it.current_bidder_id is not null then
      insert into inventory (player_id, item_id, qty, avg_buy)
      values (it.current_bidder_id, 'auction:' || it.name, 1, it.current_bid)
      on conflict (player_id, item_id) do update set qty = inventory.qty + 1;
      if it.is_final then
        update players set cash = cash + 20000 where id = it.current_bidder_id;
        insert into events (game_id, type, text)
        values (p_game_id, 'neutral', '🏆 FINAL AUCTION WON — ' || it.name || ' secured for ' || it.current_bid::text || ' + ₦20,000 bonus!');
      end if;
    end if;
    update auctions set settled = true where id = it.id;
    if not it.is_final then
      insert into events (game_id, type, text)
      values (p_game_id, 'neutral',
        case when it.current_bidder_id is not null
             then 'AUCTION CLOSED — ' || it.name || ' sold for ' || it.current_bid
             else 'AUCTION CLOSED — ' || it.name || ' had no bids' end);
      insert into auctions (game_id, name, icon, current_bid, bid_count, ends_at)
      values (p_game_id, it.name, it.icon, round(it.current_bid * 0.3), 0, now() + interval '45 seconds');
    end if;
  end loop;

  -- ── Contracts ────────────────────────────────────────────────────────────

  update contracts set status = 'expired'
  where game_id = p_game_id and status = 'open' and expires_at <= now();

  select count(*) into open_ct from contracts where game_id = p_game_id and status in ('open','accepted');
  if open_ct < 5 and random() > 0.5 then
    select * into ctmpl from _contract_template() order by random() limit 1;
    insert into contracts (game_id, author, demand, reward, risk, is_illegal, item_id, qty_required, expires_at)
    values (p_game_id, ctmpl.author, ctmpl.demand, ctmpl.reward, ctmpl.risk,
            ctmpl.is_illegal, ctmpl.item_id, ctmpl.qty_required,
            now() + (ctmpl.ttl_seconds || ' seconds')::interval);
  end if;

  -- ── Intel rotation ───────────────────────────────────────────────────────

  if (select count(*) from rumors where game_id = p_game_id and active = true) < 5 then
    select r.id into active_rid from rumors r
    where r.game_id = p_game_id and r.active = false order by random() limit 1;
    if active_rid is not null then update rumors set active = true where game_id = p_game_id and id = active_rid; end if;
  end if;

  if extract(epoch from (now() - g.last_event_at)) >= 120 then
    select r.id into active_rid from rumors r
    where r.game_id = p_game_id and r.active = true
      and r.id not in (select rumor_id from rumor_purchases where game_id = p_game_id)
    order by random() limit 1;
    if active_rid is not null then update rumors set active = false where game_id = p_game_id and id = active_rid; end if;
    select r.id into active_rid from rumors r
    where r.game_id = p_game_id and r.active = false order by random() limit 1;
    if active_rid is not null then update rumors set active = true where game_id = p_game_id and id = active_rid; end if;
  end if;

  -- ── Bounty events ────────────────────────────────────────────────────────

  for b in select * from bounties where game_id = p_game_id and status = 'active' loop
    if b.created_at + interval '90 seconds' < now() or b.triggers_remaining <= 0 then
      update bounties set status = 'expired' where id = b.id;
      continue;
    end if;
    if random() < 0.20 then
      select i.item_id into inv_it
      from inventory i join market_items m on m.id = i.item_id and m.game_id = p_game_id
      where i.player_id = b.target_id order by random() limit 1;
      if inv_it is not null and inv_it.item_id is not null then
        update market_items
        set price = greatest(round(base_price * 0.10), round(price * 0.55)),
            change_percent = -45, trend = 'down'
        where game_id = p_game_id and id = inv_it.item_id;
      end if;
      update bounties set triggers_remaining = triggers_remaining - 1 where id = b.id;
    end if;
  end loop;

  -- ── Loan defaults ────────────────────────────────────────────────────────

  for l in select * from loans where game_id = p_game_id and status = 'active' and due_at <= now() loop
    if (select cash from players where id = l.player_id) >= l.total_owed then
      update players set cash = cash - l.total_owed, total_debt = 0 where id = l.player_id;
      update loans set status = 'repaid' where id = l.id;
      insert into events (game_id, type, text)
      values (p_game_id, 'neutral', '⚠️ AUTO-REPAY — loan collected from ' || (select handle from players where id = l.player_id));
    else
      seized_value := 0;
      for inv_it in
        select i.item_id, i.qty, m.price
        from inventory i join market_items m on m.id = i.item_id and m.game_id = p_game_id
        where i.player_id = l.player_id order by (m.price * i.qty) desc
      loop
        exit when seized_value >= l.total_owed;
        seized_value := seized_value + (inv_it.price * inv_it.qty);
        delete from inventory where player_id = l.player_id and item_id = inv_it.item_id;
      end loop;
      update loans set status = 'defaulted' where id = l.id;
      update players set total_debt = 0 where id = l.player_id;
      perform _recompute_net_worth(l.player_id);
      insert into events (game_id, type, text)
      values (p_game_id, 'crash', '💥 LOAN DEFAULT — ' || (select handle from players where id = l.player_id) || ' couldn''t repay. Inventory seized.');
    end if;
  end loop;

  -- ── Wanted level decay ───────────────────────────────────────────────────

  update players
  set wanted_level = greatest(0, wanted_level - 1)
  where game_id = p_game_id and wanted_level > 0
    and (last_illegal_trade_at is null or extract(epoch from (now() - last_illegal_trade_at)) > 30);

  -- ── World events ─────────────────────────────────────────────────────────

  event_interval := case g.phase when 'COLLAPSE' then 5 when 'FINAL PHASE' then 10 else 20 end;

  if extract(epoch from (now() - g.last_event_at)) >= event_interval then
    if g.phase = 'COLLAPSE' then
      select * into random_event from (values
        ('crash','TOTAL MARKET CRASH — panic selling across all sectors'),
        ('tax','EMERGENCY TAXATION — authorities seizing assets from top traders'),
        ('raid','MASS RAID — all illegal goods flagged and seized'),
        ('blackout','COMMS BLACKOUT — price data cut for 90 seconds')
      ) as t(type,text) order by random() limit 1;
    elsif g.phase = 'FINAL PHASE' then
      select * into random_event from (values
        ('crash','MARKET CRASH — sell-off triggered by false reserve reports'),
        ('raid','GOVERNMENT RAID — illegal shipment intercepted'),
        ('tax','TAX SWEEP — the top 8 operators just lost 25%'),
        ('blackout','SIGNAL JAM — price feeds disrupted for 90 seconds'),
        ('neutral','FINAL PHASE — the market is entering its last chapter'),
        ('leak','INTELLIGENCE LEAK — a player''s full inventory is now public')
      ) as t(type,text) order by random() limit 1;
    else
      select * into random_event from (values
        ('crash','MARKET CRASH — false reserve report triggers a sell-off'),
        ('raid','GOVERNMENT RAID — illegal goods seized from an unknown seller'),
        ('leak','INFORMATION LEAK — a player''s inventory has been exposed'),
        ('tax','TAX COLLECTION — the wealthiest operators just lost 25%'),
        ('blackout','BLACKOUT EVENT — all price data hidden for 90 seconds'),
        ('neutral','NEW CONTRACT — a buyer is offering a premium for rare goods'),
        ('neutral','RUMOUR MILL — new intel circulating. Check the Intel tab.')
      ) as t(type,text) order by random() limit 1;
    end if;
    perform _apply_event(p_game_id, random_event.type, random_event.text);
    update games set last_event_at = now() where id = p_game_id;
  end if;

  -- ── Phase transitions + game end ─────────────────────────────────────────

  end_remaining := g.duration_seconds - extract(epoch from (now() - g.started_at));

  if end_remaining <= 0 and g.status = 'playing' then
    -- Evaluate objectives before closing
    perform evaluate_objectives(p_game_id);

    select * into top_player from players
    where game_id = p_game_id and is_admin = false order by net_worth desc limit 1;

    insert into events (game_id, type, text)
    values (p_game_id, 'neutral',
      case when top_player.id is not null
           then '🏆 GAME OVER — ' || top_player.handle || ' wins with ' || top_player.net_worth::text
           else '🏆 GAME OVER — The market has closed.' end);

    update games set status = 'ended', phase = 'COLLAPSE', winner_id = top_player.id where id = p_game_id;
  else
    if end_remaining <= 90 and g.phase <> 'COLLAPSE' then
      if not exists (select 1 from auctions where game_id = p_game_id and is_final = true) then
        select id into final_item_id from market_items
        where game_id = p_game_id and tier = 'legendary' order by random() limit 1;
        if final_item_id is not null then
          insert into auctions (game_id, name, icon, current_bid, bid_count, ends_at, is_final)
          values (p_game_id,
            (select name from market_items where game_id = p_game_id and id = final_item_id),
            '🏆', 30000, 0, now() + interval '90 seconds', true);
          insert into events (game_id, type, text)
          values (p_game_id, 'neutral',
            '🏆 FINAL AUCTION OPEN — one legendary item, 90 seconds, ₦20,000 bonus to the winner. This is it.');
        end if;
      end if;
    end if;

    update games
    set phase = case
          when end_remaining <= 90  then 'COLLAPSE'
          when end_remaining <= 240 then 'FINAL PHASE'
          else 'OPEN' end,
        tick_at = g.tick_at + (ticks * interval '2 seconds')
    where id = p_game_id;
  end if;

  perform _recompute_net_worth_all(p_game_id);
end;
$$;

-- ── Updated admin_add_npc: assign a random strategy ──────────────────────────

create or replace function admin_add_npc(p_game_id uuid)
returns players
language plpgsql security definer set search_path = public
as $$
declare
  pool      text[] := array['PHANTOM_X','DARKPOOL','VOID_TRADER','ANON_7','MARKET_GHOST','THE_ORACLE','ZERO_DAY'];
  strategies text[] := array['bull','bear','opportunist','bull','bear'];
  used      text[];
  available text[];
  chosen    text;
  strategy  text;
  p         players;
begin
  perform _require_admin(p_game_id);
  select array_agg(handle) into used from players where game_id = p_game_id;
  select array_agg(h) into available from unnest(pool) h where h <> all (coalesce(used, array[]::text[]));
  chosen := coalesce(available[1 + floor(random() * greatest(array_length(available,1),1))::int], 'NPC_' || floor(random()*999)::text);
  strategy := strategies[1 + floor(random() * array_length(strategies,1))::int];

  insert into players (game_id, handle, is_npc, cash, rep, trade_count, online, npc_strategy)
  values (p_game_id, chosen, true, 10000 + floor(random()*50000), 30 + floor(random()*60), 0, true, strategy)
  returning * into p;
  return p;
end;
$$;

-- ── Grants ────────────────────────────────────────────────────────────────────

grant execute on function
  list_public_rooms(),
  evaluate_objectives(uuid)
to authenticated, anon;
