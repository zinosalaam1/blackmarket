-- ============================================================================
-- THE BLACK MARKET — Supabase backend
-- Server-authoritative game logic via SECURITY DEFINER Postgres functions.
-- Clients only ever SELECT (read) tables directly + subscribe to Realtime.
-- All writes happen through the RPC functions below (called via supabase.rpc()).
-- ============================================================================

create extension if not exists pgcrypto;

-- ── Config (admin code lives in DB, never shipped to the client bundle) ────
create table if not exists app_settings (
  key   text primary key,
  value text not null
);
insert into app_settings (key, value) values ('admin_code', 'BLACKMARKET')
  on conflict (key) do nothing;
-- Change the admin code any time with:
--   update app_settings set value = 'NEW_CODE' where key = 'admin_code';

-- ── Games (one "room" per playthrough) ──────────────────────────────────────
create table if not exists games (
  id               uuid primary key default gen_random_uuid(),
  status           text not null default 'lobby' check (status in ('lobby','playing','ended')),
  phase            text not null default 'OPEN' check (phase in ('OPEN','FINAL PHASE','COLLAPSE')),
  duration_seconds int  not null default 5400, -- 90 minutes
  started_at       timestamptz,
  tick_at          timestamptz not null default now(),
  last_event_at    timestamptz not null default now(),
  blackout_until   timestamptz,
  created_at       timestamptz not null default now()
);

-- ── Players ──────────────────────────────────────────────────────────────────
create table if not exists players (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references games(id) on delete cascade,
  user_id       uuid references auth.users(id), -- null for NPC/test players
  handle        text not null,
  is_admin      boolean not null default false,
  is_npc        boolean not null default false,
  objective_id  text,
  cash          numeric not null default 10000,
  rep           int not null default 60,
  trade_count   int not null default 0,
  online        boolean not null default true,
  joined_at     timestamptz not null default now(),
  unique (game_id, handle),
  unique (game_id, user_id)
);

-- ── Market items (seeded per game) ──────────────────────────────────────────
create table if not exists market_items (
  game_id        uuid not null references games(id) on delete cascade,
  id             text not null,
  name           text not null,
  tier           text not null check (tier in ('common','rare','legendary')),
  price          numeric not null,
  base_price     numeric not null,
  change         numeric not null default 0,
  change_percent numeric not null default 0,
  trend          text not null default 'stable' check (trend in ('up','down','stable')),
  is_illegal     boolean not null default false,
  history        jsonb not null default '[]'::jsonb,
  primary key (game_id, id)
);

-- ── Inventory ────────────────────────────────────────────────────────────────
create table if not exists inventory (
  player_id uuid not null references players(id) on delete cascade,
  item_id   text not null,
  qty       int not null check (qty >= 0),
  avg_buy   numeric not null,
  primary key (player_id, item_id)
);

-- ── Rumors ───────────────────────────────────────────────────────────────────
create table if not exists rumors (
  game_id     uuid not null references games(id) on delete cascade,
  id          text not null,
  text        text not null,
  credibility text not null check (credibility in ('HOT','COLD','???')),
  cost        numeric not null,
  primary key (game_id, id)
);

create table if not exists rumor_purchases (
  player_id    uuid not null references players(id) on delete cascade,
  rumor_id     text not null,
  game_id      uuid not null references games(id) on delete cascade,
  purchased_at timestamptz not null default now(),
  primary key (player_id, rumor_id)
);

-- ── Live event feed ──────────────────────────────────────────────────────────
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references games(id) on delete cascade,
  type       text not null check (type in ('crash','raid','leak','tax','blackout','neutral')),
  text       text not null,
  created_at timestamptz not null default now()
);

-- ── Auction (one active lot per game at a time) ─────────────────────────────
create table if not exists auctions (
  id                uuid primary key default gen_random_uuid(),
  game_id           uuid not null references games(id) on delete cascade,
  name              text not null,
  icon              text not null,
  current_bid       numeric not null,
  current_bidder_id uuid references players(id),
  bid_count         int not null default 0,
  ends_at           timestamptz not null,
  settled           boolean not null default false,
  created_at        timestamptz not null default now()
);

-- ── Trade ledger (audit trail / anti-cheat / "Broker" objective tracking) ──
create table if not exists trades (
  id        uuid primary key default gen_random_uuid(),
  game_id   uuid not null references games(id) on delete cascade,
  player_id uuid not null references players(id) on delete cascade,
  item_id   text not null,
  side      text not null check (side in ('buy','sell')),
  qty       int not null,
  price     numeric not null,
  ts        timestamptz not null default now()
);

create index if not exists idx_players_game on players(game_id);
create index if not exists idx_inventory_player on inventory(player_id);
create index if not exists idx_events_game on events(game_id, created_at desc);
create index if not exists idx_trades_game on trades(game_id);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

alter table games            enable row level security;
alter table players          enable row level security;
alter table market_items     enable row level security;
alter table inventory        enable row level security;
alter table rumors           enable row level security;
alter table rumor_purchases  enable row level security;
alter table events           enable row level security;
alter table auctions         enable row level security;
alter table trades           enable row level security;
alter table app_settings     enable row level security;
-- app_settings: no policies at all -> totally inaccessible to clients.

create policy "read games"        on games            for select using (true);
create policy "read players"      on players          for select using (true);
create policy "read market_items" on market_items     for select using (true);
create policy "read rumors"       on rumors           for select using (true);
create policy "read events"       on events           for select using (true);
create policy "read auctions"     on auctions         for select using (true);

create policy "read own inventory" on inventory
  for select using (player_id in (select id from players where user_id = auth.uid()));
create policy "read own rumor_purchases" on rumor_purchases
  for select using (player_id in (select id from players where user_id = auth.uid()));
create policy "read own trades" on trades
  for select using (player_id in (select id from players where user_id = auth.uid()));

-- ============================================================================
-- HELPERS
-- ============================================================================

create or replace function _current_player(p_game_id uuid)
returns players
language sql
security definer
set search_path = public
as $$
  select * from players where game_id = p_game_id and user_id = auth.uid();
$$;

create or replace function _require_admin(p_game_id uuid)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  p players;
begin
  select * into p from players where game_id = p_game_id and user_id = auth.uid() and is_admin = true;
  if p.id is null then
    raise exception 'ADMIN_ONLY';
  end if;
  return p;
end;
$$;

create or replace function _objective_pool()
returns text[]
language sql
immutable
as $$
  select array['tycoon','collector','broker','saboteur','smuggler','informant','kingmaker','ghost','chaos'];
$$;

create or replace function _market_template()
returns table(id text, name text, tier text, base_price numeric, is_illegal boolean)
language sql
immutable
as $$
  values
    ('batteries','Batteries','common',120,false),
    ('electronics','Electronics','common',340,false),
    ('gold','Gold','common',1000,false),
    ('fuel','Fuel Cells','common',280,false),
    ('ancient_coins','Ancient Coins','rare',2800,false),
    ('crypto_keys','Crypto Keys','rare',4200,false),
    ('lost_docs','Lost Documents','rare',3600,false),
    ('bio_sample','Bio Sample','rare',5100,true),
    ('red_diamond','Red Diamond','legendary',18000,false),
    ('gov_secrets','Gov. Secrets','legendary',22000,true),
    ('quantum_chip','Quantum Chip','legendary',31000,false);
$$;

create or replace function _rumor_template()
returns table(id text, text text, credibility text, cost numeric)
language sql
immutable
as $$
  values
    ('r1','Red Diamond reserves discovered in Sector 7. Price may collapse 60%.','???',500),
    ('r2','Government raid on illegal electronics scheduled for next phase.','HOT',1200),
    ('r3','Quantum Chip shortage incoming — three suppliers went dark overnight.','COLD',800),
    ('r4','Broker alliance coordinating a Gold pump. Insiders say buy now.','???',600),
    ('r5','Ancient Coins are all counterfeits. Seller is running a long con.','HOT',950),
    ('r6','Market Collapse event triggers in 8 minutes. Prepare.','???',2000);
$$;

create or replace function _init_history(p_base numeric, p_len int default 30)
returns jsonb
language plpgsql
as $$
declare
  h numeric[] := array[p_base];
  prev numeric;
  delta numeric;
  i int;
begin
  for i in 2..p_len loop
    prev := h[i-1];
    delta := prev * (random() * 0.1 - 0.05);
    h := h || greatest(1, round(prev + delta));
  end loop;
  return to_jsonb(h);
end;
$$;

-- ============================================================================
-- LOBBY / SESSION MANAGEMENT
-- ============================================================================

create or replace function get_or_create_lobby()
returns games
language plpgsql
security definer
set search_path = public
as $$
declare
  g games;
  item record;
  rumor record;
begin
  select * into g from games where status = 'lobby' order by created_at desc limit 1;
  if g.id is not null then
    return g;
  end if;

  insert into games default values returning * into g;

  for item in select * from _market_template() loop
    insert into market_items (game_id, id, name, tier, price, base_price, is_illegal, history)
    values (g.id, item.id, item.name, item.tier, item.base_price, item.base_price, item.is_illegal, _init_history(item.base_price));
  end loop;

  for rumor in select * from _rumor_template() loop
    insert into rumors (game_id, id, text, credibility, cost) values (g.id, rumor.id, rumor.text, rumor.credibility, rumor.cost);
  end loop;

  insert into auctions (game_id, name, icon, current_bid, bid_count, ends_at)
  values (g.id, 'Golden Passport', '🛂', 8500, 6, now() + interval '90 seconds');

  insert into events (game_id, type, text)
  values (g.id, 'neutral', 'THE BLACK MARKET is now open.');

  return g;
end;
$$;

create or replace function join_game(p_handle text)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  g games;
  cleaned text;
  p players;
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  cleaned := upper(regexp_replace(trim(p_handle), '\s+', '_', 'g'));
  if length(cleaned) < 3 or length(cleaned) > 16 or cleaned !~ '^[A-Z0-9_]+$' then
    raise exception 'INVALID_HANDLE';
  end if;

  g := get_or_create_lobby();

  if exists (select 1 from players where game_id = g.id and handle = cleaned and user_id is distinct from auth.uid()) then
    raise exception 'HANDLE_TAKEN';
  end if;

  insert into players (game_id, user_id, handle)
  values (g.id, auth.uid(), cleaned)
  on conflict (game_id, user_id) do update set handle = excluded.handle, online = true
  returning * into p;

  return p;
end;
$$;

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
  if stored is null or upper(trim(p_code)) <> stored then
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

create or replace function admin_update_player(p_player_id uuid, p_objective_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target players;
begin
  select * into target from players where id = p_player_id;
  perform _require_admin(target.game_id);
  update players set objective_id = p_objective_id where id = p_player_id;
end;
$$;

create or replace function admin_remove_player(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target players;
begin
  select * into target from players where id = p_player_id;
  perform _require_admin(target.game_id);
  delete from players where id = p_player_id;
end;
$$;

create or replace function admin_add_npc(p_game_id uuid)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  pool text[] := array['PHANTOM_X','DARKPOOL','VOID_TRADER','ANON_7','MARKET_GHOST','THE_ORACLE','ZERO_DAY'];
  used text[];
  available text[];
  chosen text;
  p players;
begin
  perform _require_admin(p_game_id);
  select array_agg(handle) into used from players where game_id = p_game_id;
  select array_agg(h) into available from unnest(pool) h where h <> all (coalesce(used, array[]::text[]));
  chosen := coalesce(available[1 + floor(random() * greatest(array_length(available,1),1))::int], 'NPC_' || floor(random()*999)::text);

  insert into players (game_id, handle, is_npc, cash, rep, trade_count, online)
  values (p_game_id, chosen, true, 10000 + floor(random()*50000), 30 + floor(random()*60), floor(random()*30), true)
  returning * into p;
  return p;
end;
$$;

create or replace function admin_auto_assign_objectives(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pool text[] := _objective_pool();
  rec record;
  i int := 0;
begin
  perform _require_admin(p_game_id);
  for rec in select id from players where game_id = p_game_id and is_admin = false order by joined_at loop
    update players set objective_id = pool[1 + (i % array_length(pool,1))] where id = rec.id;
    i := i + 1;
  end loop;
end;
$$;

create or replace function admin_start_game(p_game_id uuid)
returns games
language plpgsql
security definer
set search_path = public
as $$
declare
  g games;
  pool text[] := _objective_pool();
  rec record;
begin
  perform _require_admin(p_game_id);

  for rec in select id from players where game_id = p_game_id and is_admin = false and objective_id is null loop
    update players set objective_id = pool[1 + floor(random() * array_length(pool,1))::int] where id = rec.id;
  end loop;

  update games
  set status = 'playing', started_at = now(), tick_at = now(), last_event_at = now(), phase = 'OPEN'
  where id = p_game_id
  returning * into g;

  insert into events (game_id, type, text) values (p_game_id, 'neutral', 'THE BLACK MARKET has opened for trading. Good luck, operators.');

  return g;
end;
$$;

create or replace function admin_trigger_event(p_game_id uuid, p_type text, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform _require_admin(p_game_id);
  perform _apply_event(p_game_id, p_type, p_text);
end;
$$;

-- ============================================================================
-- EVENT SIDE-EFFECTS
-- ============================================================================

create or replace function _apply_event(p_game_id uuid, p_type text, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into events (game_id, type, text) values (p_game_id, p_type, p_text);

  if p_type = 'crash' then
    update market_items
    set price = greatest(round(base_price * 0.2), round(price * 0.6)),
        change = round(price * 0.6) - price,
        change_percent = -40,
        trend = 'down'
    where game_id = p_game_id and random() > 0.5;

  elsif p_type = 'tax' then
    update players
    set cash = round(cash * 0.85)
    where id in (
      select id from players where game_id = p_game_id and is_admin = false
      order by cash desc limit 5
    );

  elsif p_type = 'blackout' then
    update games set blackout_until = now() + interval '60 seconds' where id = p_game_id;
  end if;
end;
$$;

-- ============================================================================
-- MARKET TICK
-- ============================================================================

create or replace function market_tick(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  g games;
  got_lock boolean;
  elapsed numeric;
  ticks int;
  i int;
  vol numeric;
  drift numeric;
  pct numeric;
  it record;
  new_price numeric;
  random_event record;
  end_remaining numeric;
begin
  select pg_try_advisory_xact_lock(hashtext(p_game_id::text)) into got_lock;
  if not got_lock then
    return;
  end if;

  select * into g from games where id = p_game_id for update;
  if g.id is null or g.status <> 'playing' then
    return;
  end if;

  elapsed := extract(epoch from (now() - g.tick_at));
  ticks := floor(elapsed / 2);
  if ticks < 1 then
    return;
  end if;
  ticks := least(ticks, 30);

  for i in 1..ticks loop
    for it in select * from market_items where game_id = p_game_id loop
      vol := case it.tier when 'legendary' then 0.06 when 'rare' then 0.045 else 0.03 end;
      drift := random() * 2 - 1;
      pct := drift * vol * (case when g.phase = 'COLLAPSE' then 3 else 1 end);
      new_price := greatest(round(it.base_price * 0.2), least(round(it.base_price * 5), round(it.price * (1 + pct))));
      update market_items
      set price = new_price,
          change = new_price - it.price,
          change_percent = case when it.price = 0 then 0 else ((new_price - it.price) / it.price) * 100 end,
          trend = case when new_price > it.price then 'up' when new_price < it.price then 'down' else 'stable' end,
          history = (case when jsonb_array_length(it.history) >= 60
                          then (it.history - 0) else it.history end) || to_jsonb(new_price)
      where game_id = p_game_id and id = it.id;
    end loop;
  end loop;

  update auctions
  set current_bid = case when random() > 0.8 then current_bid + round(random()*500+200) else current_bid end,
      bid_count = case when random() > 0.8 then bid_count + 1 else bid_count end
  where game_id = p_game_id and settled = false and ends_at > now();

  for it in select * from auctions where game_id = p_game_id and settled = false and ends_at <= now() loop
    if it.current_bidder_id is not null then
      insert into inventory (player_id, item_id, qty, avg_buy)
      values (it.current_bidder_id, 'auction:' || it.name, 1, it.current_bid)
      on conflict (player_id, item_id) do update set qty = inventory.qty + 1;
    end if;
    update auctions set settled = true where id = it.id;
    insert into events (game_id, type, text)
    values (p_game_id, 'neutral', case when it.current_bidder_id is not null
      then 'AUCTION CLOSED — ' || it.name || ' sold for ' || it.current_bid
      else 'AUCTION CLOSED — ' || it.name || ' had no bids' end);
    insert into auctions (game_id, name, icon, current_bid, bid_count, ends_at)
    values (p_game_id, it.name, it.icon, round(it.current_bid * 0.4), 0, now() + interval '90 seconds');
  end loop;

  if extract(epoch from (now() - g.last_event_at)) >= 18 then
    select * into random_event from (values
      ('crash','MARKET CRASH — false reserve report triggers a sell-off'),
      ('raid','GOVERNMENT RAID — illegal goods seized from an unknown seller'),
      ('leak','INFORMATION LEAK — a player''s inventory has been exposed'),
      ('tax','TAX COLLECTION — the wealthiest operators just lost 15% of their cash'),
      ('blackout','BLACKOUT EVENT — all price data hidden for 60 seconds'),
      ('neutral','NEW CONTRACT — a buyer is offering a premium for rare goods')
    ) as t(type, text) order by random() limit 1;

    perform _apply_event(p_game_id, random_event.type, random_event.text);
    update games set last_event_at = now() where id = p_game_id;
  end if;

  end_remaining := g.duration_seconds - extract(epoch from (now() - g.started_at));
  update games
  set phase = case
        when end_remaining <= 60 then 'COLLAPSE'
        when end_remaining <= 300 then 'FINAL PHASE'
        else 'OPEN'
      end,
      status = case when end_remaining <= 0 then 'ended' else status end,
      tick_at = g.tick_at + (ticks * interval '2 seconds')
  where id = p_game_id;
end;
$$;

-- ============================================================================
-- TRADING
-- ============================================================================

create or replace function buy_item(p_game_id uuid, p_item_id text, p_qty int)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  me players;
  mkt market_items;
  total numeric;
  inv inventory;
begin
  if p_qty is null or p_qty <= 0 then
    raise exception 'INVALID_QTY';
  end if;

  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;

  select * into mkt from market_items where game_id = p_game_id and id = p_item_id;
  if mkt.id is null then raise exception 'UNKNOWN_ITEM'; end if;

  total := mkt.price * p_qty;
  if total > me.cash then raise exception 'INSUFFICIENT_FUNDS'; end if;

  select * into inv from inventory where player_id = me.id and item_id = p_item_id;
  if inv.player_id is not null then
    update inventory
    set qty = inv.qty + p_qty,
        avg_buy = round((inv.avg_buy * inv.qty + mkt.price * p_qty) / (inv.qty + p_qty))
    where player_id = me.id and item_id = p_item_id;
  else
    insert into inventory (player_id, item_id, qty, avg_buy) values (me.id, p_item_id, p_qty, mkt.price);
  end if;

  update players
  set cash = cash - total, trade_count = trade_count + 1, rep = least(100, rep + 1)
  where id = me.id
  returning * into me;

  insert into trades (game_id, player_id, item_id, side, qty, price) values (p_game_id, me.id, p_item_id, 'buy', p_qty, mkt.price);

  return me;
end;
$$;

create or replace function sell_item(p_game_id uuid, p_item_id text, p_qty int default null)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  me players;
  mkt market_items;
  inv inventory;
  sell_qty int;
  earned numeric;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;

  select * into inv from inventory where player_id = me.id and item_id = p_item_id;
  if inv.player_id is null or inv.qty <= 0 then raise exception 'NOTHING_TO_SELL'; end if;

  select * into mkt from market_items where game_id = p_game_id and id = p_item_id;
  if mkt.id is null then raise exception 'UNKNOWN_ITEM'; end if;

  sell_qty := coalesce(p_qty, inv.qty);
  if sell_qty <= 0 or sell_qty > inv.qty then raise exception 'INVALID_QTY'; end if;

  earned := mkt.price * sell_qty;

  if sell_qty = inv.qty then
    delete from inventory where player_id = me.id and item_id = p_item_id;
  else
    update inventory set qty = qty - sell_qty where player_id = me.id and item_id = p_item_id;
  end if;

  update players
  set cash = cash + earned, trade_count = trade_count + 1, rep = least(100, rep + 2)
  where id = me.id
  returning * into me;

  insert into trades (game_id, player_id, item_id, side, qty, price) values (p_game_id, me.id, p_item_id, 'sell', sell_qty, mkt.price);

  return me;
end;
$$;

create or replace function buy_rumor(p_game_id uuid, p_rumor_id text)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  me players;
  r rumors;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;

  if exists (select 1 from rumor_purchases where player_id = me.id and rumor_id = p_rumor_id) then
    raise exception 'ALREADY_PURCHASED';
  end if;

  select * into r from rumors where game_id = p_game_id and id = p_rumor_id;
  if r.id is null then raise exception 'UNKNOWN_RUMOR'; end if;
  if r.cost > me.cash then raise exception 'INSUFFICIENT_FUNDS'; end if;

  update players set cash = cash - r.cost where id = me.id returning * into me;
  insert into rumor_purchases (player_id, rumor_id, game_id) values (me.id, p_rumor_id, p_game_id);

  return me;
end;
$$;

create or replace function place_bid(p_auction_id uuid, p_amount numeric)
returns auctions
language plpgsql
security definer
set search_path = public
as $$
declare
  me players;
  a auctions;
begin
  select * into a from auctions where id = p_auction_id for update;
  if a.id is null or a.settled or a.ends_at <= now() then raise exception 'AUCTION_CLOSED'; end if;

  select * into me from players where game_id = a.game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;

  if p_amount <= a.current_bid then raise exception 'BID_TOO_LOW'; end if;
  if p_amount > me.cash then raise exception 'INSUFFICIENT_FUNDS'; end if;

  if a.current_bidder_id is not null then
    update players set cash = cash + a.current_bid where id = a.current_bidder_id;
  end if;

  update players set cash = cash - p_amount where id = me.id;

  update auctions
  set current_bid = p_amount, current_bidder_id = me.id, bid_count = bid_count + 1
  where id = p_auction_id
  returning * into a;

  return a;
end;
$$;

-- ============================================================================
-- GRANTS
-- ============================================================================

grant execute on function
  get_or_create_lobby(), join_game(text), admin_login(text),
  admin_update_player(uuid, text), admin_remove_player(uuid), admin_add_npc(uuid),
  admin_auto_assign_objectives(uuid), admin_start_game(uuid), admin_trigger_event(uuid, text, text),
  market_tick(uuid), buy_item(uuid, text, int), sell_item(uuid, text, int),
  buy_rumor(uuid, text), place_bid(uuid, numeric)
to authenticated, anon;

-- ============================================================================
-- REALTIME
-- ============================================================================
alter publication supabase_realtime add table games, players, market_items, events, auctions, inventory;
