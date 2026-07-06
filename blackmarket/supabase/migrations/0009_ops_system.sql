-- ============================================================================
-- THE BLACK MARKET — Operations System
--
-- New features:
--   1. Bounties      — pay to trigger 3 hostile events on a target's inventory
--   2. Personal Blackout — blind one player's price feed for 90s (₦5,000)
--   3. Pump & Dump   — spike an item 60%, it crashes 60% after 60s
--   4. Debt System   — borrow up to ₦25,000 at 50% interest, due in 90s
--   5. Wanted Level  — illegal trades build heat 0→5; level 5 = BUSTED
--   6. Assassination — freeze a player's account for 90s (₦75,000)
--   7. Final Auction — legendary item auctioned in the last 90s of the game
-- ============================================================================

-- ── New player columns ────────────────────────────────────────────────────────
alter table players
  add column if not exists wanted_level          int         not null default 0,
  add column if not exists frozen_until          timestamptz,
  add column if not exists player_blackout_until timestamptz,
  add column if not exists total_debt            numeric     not null default 0,
  add column if not exists last_illegal_trade_at timestamptz;

-- ── New market_items column ───────────────────────────────────────────────────
alter table market_items
  add column if not exists pump_until timestamptz;

-- ── New auctions column ───────────────────────────────────────────────────────
alter table auctions
  add column if not exists is_final boolean not null default false;

-- ── Bounties ──────────────────────────────────────────────────────────────────
create table if not exists bounties (
  id                uuid        primary key default gen_random_uuid(),
  game_id           uuid        not null references games(id) on delete cascade,
  placer_id         uuid        not null references players(id) on delete cascade,
  target_id         uuid        not null references players(id) on delete cascade,
  amount            numeric     not null check (amount >= 2000),
  triggers_remaining int        not null default 3,
  status            text        not null default 'active'
                                check (status in ('active','expired')),
  created_at        timestamptz not null default now()
);
alter table bounties enable row level security;
create policy "read bounties in my rooms" on bounties
  for select using (game_id in (select _my_game_ids()));
alter publication supabase_realtime add table bounties;

-- ── Loans ─────────────────────────────────────────────────────────────────────
create table if not exists loans (
  id          uuid        primary key default gen_random_uuid(),
  game_id     uuid        not null references games(id) on delete cascade,
  player_id   uuid        not null references players(id) on delete cascade,
  principal   numeric     not null,
  total_owed  numeric     not null,
  due_at      timestamptz not null,
  status      text        not null default 'active'
                          check (status in ('active','repaid','defaulted')),
  taken_at    timestamptz not null default now()
);
alter table loans enable row level security;
create policy "read own loans" on loans
  for select using (player_id in (select id from players where user_id = auth.uid()));
alter publication supabase_realtime add table loans;

-- ── Bounty: pay to put 3 hostile events on a target ──────────────────────────
create or replace function place_bounty(p_game_id uuid, p_target_id uuid, p_amount numeric)
returns bounties
language plpgsql security definer set search_path = public
as $$
declare
  me     players;
  target players;
  b      bounties;
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

  update players set cash = cash - p_amount where id = me.id;

  insert into bounties (game_id, placer_id, target_id, amount)
  values (p_game_id, me.id, p_target_id, p_amount)
  returning * into b;

  insert into events (game_id, type, text)
  values (p_game_id, 'raid',
    '🎯 BOUNTY PLACED — ' || target.handle || ' has a target on their back. ' || me.handle || ' paid ' || p_amount::text);

  return b;
end;
$$;

-- ── Personal Blackout: blind one player's price feed ─────────────────────────
create or replace function target_blackout(p_game_id uuid, p_target_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me     players;
  target players;
  cost   constant numeric := 5000;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;
  if me.frozen_until is not null and me.frozen_until > now() then raise exception 'PLAYER_FROZEN'; end if;
  if me.cash < cost then raise exception 'INSUFFICIENT_FUNDS'; end if;

  select * into target from players where id = p_target_id and game_id = p_game_id;
  if target.id is null then raise exception 'UNKNOWN_TARGET'; end if;
  if target.id = me.id then raise exception 'CANT_TARGET_SELF'; end if;
  if target.is_admin then raise exception 'CANT_TARGET_ADMIN'; end if;

  update players set cash = cash - cost where id = me.id;
  update players set player_blackout_until = now() + interval '90 seconds' where id = p_target_id;

  insert into events (game_id, type, text)
  values (p_game_id, 'blackout',
    '📡 SIGNAL JAM — an operator''s price feed has been blinded for 90 seconds.');
end;
$$;

-- ── Pump & Dump: spike an item price, then it crashes ────────────────────────
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

  cost := case mkt.tier
            when 'legendary' then 25000
            when 'rare'      then 10000
            else                   3000
          end;
  if me.cash < cost then raise exception 'INSUFFICIENT_FUNDS'; end if;

  -- Spike price 60% immediately
  new_price := round(mkt.price * 1.6);
  update players set cash = cash - cost where id = me.id;
  update market_items
  set price = new_price, pump_until = now() + interval '60 seconds',
      change = new_price - mkt.price,
      change_percent = 60, trend = 'up'
  where game_id = p_game_id and id = p_item_id
  returning * into mkt;

  insert into events (game_id, type, text)
  values (p_game_id, 'neutral',
    '📈 PUMP DETECTED — ' || mkt.name || ' is surging. Someone''s moving big money. Dump incoming.');

  return mkt;
end;
$$;

-- ── Debt System ───────────────────────────────────────────────────────────────
create or replace function take_loan(p_game_id uuid, p_amount numeric)
returns loans
language plpgsql security definer set search_path = public
as $$
declare
  me           players;
  l            loans;
  g            games;
  end_remaining numeric;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;
  if me.frozen_until is not null and me.frozen_until > now() then raise exception 'PLAYER_FROZEN'; end if;
  if me.total_debt > 0 then raise exception 'EXISTING_LOAN'; end if;
  if p_amount < 1000 or p_amount > 25000 then raise exception 'INVALID_LOAN_AMOUNT'; end if;

  select * into g from games where id = p_game_id;
  end_remaining := g.duration_seconds - extract(epoch from (now() - g.started_at));
  if end_remaining < 120 then raise exception 'LOAN_PERIOD_CLOSED'; end if;

  insert into loans (game_id, player_id, principal, total_owed, due_at)
  values (p_game_id, me.id, p_amount, round(p_amount * 1.5), now() + interval '90 seconds')
  returning * into l;

  update players set cash = cash + p_amount, total_debt = l.total_owed where id = me.id;

  insert into events (game_id, type, text)
  values (p_game_id, 'neutral',
    '💸 LOAN TAKEN — ' || me.handle || ' borrowed ' || p_amount::text || '. 50% interest. Due in 90 seconds.');

  return l;
end;
$$;

create or replace function repay_loan(p_game_id uuid)
returns players
language plpgsql security definer set search_path = public
as $$
declare
  me players;
  l  loans;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;

  select * into l from loans where player_id = me.id and game_id = p_game_id and status = 'active';
  if l.id is null then raise exception 'NO_ACTIVE_LOAN'; end if;
  if me.cash < l.total_owed then raise exception 'INSUFFICIENT_FUNDS'; end if;

  update loans set status = 'repaid' where id = l.id;
  update players set cash = cash - l.total_owed, total_debt = 0 where id = me.id returning * into me;

  insert into events (game_id, type, text)
  values (p_game_id, 'neutral', '✅ LOAN REPAID — ' || me.handle || ' cleared their debt of ' || l.total_owed::text);

  return me;
end;
$$;

-- ── Assassination: freeze a player for 90s ────────────────────────────────────
create or replace function assassinate_player(p_game_id uuid, p_target_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  me     players;
  target players;
  cost   constant numeric := 75000;
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

  update players set cash = cash - cost where id = me.id;
  update players set frozen_until = now() + interval '90 seconds' where id = p_target_id;

  insert into events (game_id, type, text)
  values (p_game_id, 'crash',
    '☠️ ACCOUNT FROZEN — ' || target.handle || ' has been neutralised for 90 seconds. They cannot trade.');
end;
$$;

-- ── Updated buy_item: frozen + wanted level ───────────────────────────────────
create or replace function buy_item(p_game_id uuid, p_item_id text, p_qty int)
returns players
language plpgsql security definer set search_path = public
as $$
declare
  me  players;
  mkt market_items;
  total numeric;
  fee   numeric;
  inv  inventory;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'INVALID_QTY'; end if;

  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;
  if me.net_worth < 1500 then raise exception 'ACCOUNT_FROZEN'; end if;
  if me.frozen_until is not null and me.frozen_until > now() then raise exception 'PLAYER_FROZEN'; end if;

  select * into mkt from market_items where game_id = p_game_id and id = p_item_id;
  if mkt.id is null then raise exception 'UNKNOWN_ITEM'; end if;

  total := mkt.price * p_qty;
  fee   := greatest(1, round(total * 0.03));
  if (total + fee) > me.cash then raise exception 'INSUFFICIENT_FUNDS'; end if;

  select * into inv from inventory where player_id = me.id and item_id = p_item_id;
  if inv.player_id is not null then
    update inventory
    set qty = inv.qty + p_qty,
        avg_buy = round((inv.avg_buy * inv.qty + mkt.price * p_qty) / (inv.qty + p_qty))
    where player_id = me.id and item_id = p_item_id;
  else
    insert into inventory (player_id, item_id, qty, avg_buy)
    values (me.id, p_item_id, p_qty, mkt.price);
  end if;

  update players
  set cash = cash - total - fee,
      trade_count = trade_count + 1,
      rep = least(100, rep + 1),
      wanted_level = case when mkt.is_illegal then least(5, wanted_level + 2) else wanted_level end,
      last_illegal_trade_at = case when mkt.is_illegal then now() else last_illegal_trade_at end
  where id = me.id
  returning * into me;

  insert into trades (game_id, player_id, item_id, side, qty, price)
  values (p_game_id, me.id, p_item_id, 'buy', p_qty, mkt.price);

  perform _recompute_net_worth(me.id);
  select * into me from players where id = me.id;

  -- Wanted level 5: instant bust
  if me.wanted_level >= 5 then
    perform _bust_player(p_game_id, me.id);
    select * into me from players where id = me.id;
  end if;

  return me;
end;
$$;

-- ── Updated sell_item: frozen + wanted level ──────────────────────────────────
create or replace function sell_item(p_game_id uuid, p_item_id text, p_qty int default null)
returns players
language plpgsql security definer set search_path = public
as $$
declare
  me         players;
  mkt        market_items;
  inv        inventory;
  sell_qty   int;
  earned     numeric;
  rep_change int;
begin
  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;
  if me.frozen_until is not null and me.frozen_until > now() then raise exception 'PLAYER_FROZEN'; end if;

  select * into inv from inventory where player_id = me.id and item_id = p_item_id;
  if inv.player_id is null or inv.qty <= 0 then raise exception 'NOTHING_TO_SELL'; end if;

  select * into mkt from market_items where game_id = p_game_id and id = p_item_id;
  if mkt.id is null then raise exception 'UNKNOWN_ITEM'; end if;

  sell_qty := coalesce(p_qty, inv.qty);
  if sell_qty <= 0 or sell_qty > inv.qty then raise exception 'INVALID_QTY'; end if;

  earned := mkt.price * sell_qty;
  rep_change := case
    when mkt.price >= inv.avg_buy        then  2
    when mkt.price >= inv.avg_buy * 0.8  then -1
    else                                      -4
  end;

  if sell_qty = inv.qty then
    delete from inventory where player_id = me.id and item_id = p_item_id;
  else
    update inventory set qty = qty - sell_qty where player_id = me.id and item_id = p_item_id;
  end if;

  update players
  set cash = cash + earned,
      trade_count = trade_count + 1,
      rep = greatest(0, least(100, rep + rep_change)),
      wanted_level = case when mkt.is_illegal then least(5, wanted_level + 1) else wanted_level end,
      last_illegal_trade_at = case when mkt.is_illegal then now() else last_illegal_trade_at end
  where id = me.id
  returning * into me;

  insert into trades (game_id, player_id, item_id, side, qty, price)
  values (p_game_id, me.id, p_item_id, 'sell', sell_qty, mkt.price);

  perform _recompute_net_worth(me.id);
  select * into me from players where id = me.id;

  if me.wanted_level >= 5 then
    perform _bust_player(p_game_id, me.id);
    select * into me from players where id = me.id;
  end if;

  return me;
end;
$$;

-- ── Bust helper ───────────────────────────────────────────────────────────────
create or replace function _bust_player(p_game_id uuid, p_player_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  p players;
  fine constant numeric := 5000;
begin
  select * into p from players where id = p_player_id;

  -- Seize all illegal inventory
  delete from inventory
  where player_id = p_player_id
    and item_id in (select id from market_items where game_id = p_game_id and is_illegal = true);

  -- Fine + reset wanted level
  update players
  set cash = greatest(0, cash - fine),
      wanted_level = 0,
      last_illegal_trade_at = null
  where id = p_player_id;

  perform _recompute_net_worth(p_player_id);

  insert into events (game_id, type, text)
  values (p_game_id, 'raid',
    '🚨 BUSTED — ' || p.handle || ' has been raided. All illegal goods seized + ₦5,000 fine.');
end;
$$;

-- ── Updated market_tick ───────────────────────────────────────────────────────
create or replace function market_tick(p_game_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  g              games;
  got_lock       boolean;
  elapsed        numeric;
  ticks          int;
  i              int;
  vol            numeric;
  drift          numeric;
  pct            numeric;
  it             record;
  new_price      numeric;
  random_event   record;
  end_remaining  numeric;
  top_player     players;
  inactive_rid   text;
  active_rid     text;
  event_interval int;
  open_ct        int;
  ctmpl          record;
  b              record;
  inv_it         record;
  l              record;
  seized_value   numeric;
  final_item_id  text;
  phase_changed  boolean := false;
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

      -- Pump: add upward bias while active
      if it.pump_until is not null and it.pump_until > now() then
        pct := pct + 0.18;
      end if;

      -- Pump dump crash: pump just expired this window
      if it.pump_until is not null and it.pump_until <= now() and it.pump_until > g.tick_at then
        new_price := greatest(round(it.base_price * 0.10), round(it.price * 0.40));
        update market_items
        set price = new_price, pump_until = null,
            change = new_price - it.price, change_percent = -60, trend = 'down',
            history = (case when jsonb_array_length(it.history) >= 60
                            then (it.history - 0) else it.history end) || to_jsonb(new_price)
        where game_id = p_game_id and id = it.id;

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
          change_percent = case when it.price = 0 then 0
                                else ((new_price - it.price) / it.price) * 100 end,
          trend = case when new_price > it.price then 'up'
                       when new_price < it.price then 'down'
                       else 'stable' end,
          history = (case when jsonb_array_length(it.history) >= 60
                          then (it.history - 0) else it.history end) || to_jsonb(new_price)
      where game_id = p_game_id and id = it.id;
    end loop;
  end loop;

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

      -- Final auction: bonus cash to winner
      if it.is_final then
        update players set cash = cash + 20000 where id = it.current_bidder_id;
        insert into events (game_id, type, text)
        values (p_game_id, 'neutral',
          '🏆 FINAL AUCTION WON — ' || it.name || ' secured for ' || it.current_bid::text || ' + ₦20,000 bonus!');
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

  if extract(epoch from (now() - g.last_event_at)) >= 120 or
     (select count(*) from rumors where game_id = p_game_id and active = true) < 5 then
    select r.id into active_rid from rumors r
    where r.game_id = p_game_id and r.active = true
      and r.id not in (select rumor_id from rumor_purchases where game_id = p_game_id)
    order by random() limit 1;
    if active_rid is not null then
      update rumors set active = false where game_id = p_game_id and id = active_rid;
    end if;
    select r.id into active_rid from rumors r
    where r.game_id = p_game_id and r.active = false order by random() limit 1;
    if active_rid is not null then
      update rumors set active = true where game_id = p_game_id and id = active_rid;
    end if;
  end if;

  -- ── Bounty events: 20% chance per tick, crash one of target's items ──────

  for b in select * from bounties where game_id = p_game_id and status = 'active' loop
    if b.created_at + interval '90 seconds' < now() or b.triggers_remaining <= 0 then
      update bounties set status = 'expired' where id = b.id;
      continue;
    end if;
    if random() < 0.20 then
      -- Crash a random item held by the target
      select i.item_id into inv_it
      from inventory i
      join market_items m on m.id = i.item_id and m.game_id = p_game_id
      where i.player_id = b.target_id
      order by random() limit 1;

      if inv_it.item_id is not null then
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
    -- Try to pay from cash first
    if (select cash from players where id = l.player_id) >= l.total_owed then
      update players set cash = cash - l.total_owed, total_debt = 0 where id = l.player_id;
      update loans set status = 'repaid' where id = l.id;
      insert into events (game_id, type, text)
      values (p_game_id, 'neutral',
        '⚠️ AUTO-REPAY — loan collected from ' ||
        (select handle from players where id = l.player_id) || ' on due date.');
    else
      -- Seize inventory items until debt covered
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
      values (p_game_id, 'crash',
        '💥 LOAN DEFAULT — ' ||
        (select handle from players where id = l.player_id) ||
        ' couldn''t repay their debt. Inventory seized.');
    end if;
  end loop;

  -- ── Wanted level decay: -1 every 30s if no recent illegal trade ──────────

  update players
  set wanted_level = greatest(0, wanted_level - 1)
  where game_id = p_game_id
    and wanted_level > 0
    and (last_illegal_trade_at is null
         or extract(epoch from (now() - last_illegal_trade_at)) > 30);

  -- ── World events ─────────────────────────────────────────────────────────

  event_interval := case g.phase
                      when 'COLLAPSE'    then  5
                      when 'FINAL PHASE' then 10
                      else                    20
                    end;

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

  -- ── Phase transitions ─────────────────────────────────────────────────────

  end_remaining := g.duration_seconds - extract(epoch from (now() - g.started_at));

  if end_remaining <= 0 and g.status = 'playing' then
    select * into top_player from players
    where game_id = p_game_id and is_admin = false order by net_worth desc limit 1;

    insert into events (game_id, type, text)
    values (p_game_id, 'neutral',
      case when top_player.id is not null
           then '🏆 GAME OVER — ' || top_player.handle || ' wins with ' || top_player.net_worth::text
           else '🏆 GAME OVER — The market has closed.' end);

    update games
    set status = 'ended', phase = 'COLLAPSE', winner_id = top_player.id where id = p_game_id;

  else
    -- Trigger final auction when entering COLLAPSE for the first time
    if end_remaining <= 90 and g.phase <> 'COLLAPSE' then
      if not exists (select 1 from auctions where game_id = p_game_id and is_final = true) then
        select id into final_item_id
        from market_items where game_id = p_game_id and tier = 'legendary'
        order by random() limit 1;

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

-- ── Grants ────────────────────────────────────────────────────────────────────
grant execute on function
  place_bounty(uuid, uuid, numeric),
  target_blackout(uuid, uuid),
  pump_item(uuid, text),
  take_loan(uuid, numeric),
  repay_loan(uuid),
  assassinate_player(uuid, uuid)
to authenticated, anon;
