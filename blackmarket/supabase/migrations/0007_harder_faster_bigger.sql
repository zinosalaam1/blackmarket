-- ============================================================================
-- THE BLACK MARKET — harder, faster, bigger
--
-- 1. 15-minute game (900s), tighter phases
-- 2. 20 market items (was 11)
-- 3. 15 intel rumors, only 8 active at a time, rotate every ~2 minutes
-- 4. Mistakes are costly: 3% buy fee, harsher events, higher volatility
-- 5. Event frequency: 20s → 12s → 5s as phase escalates
-- 6. Winners screen: broadcast a winner event + winner_id on game end
-- 7. Busted mechanic: can't trade if net_worth < ₦1,500
-- ============================================================================

-- ── 1. Default game duration ─────────────────────────────────────────────────

alter table games
  alter column duration_seconds set default 900,
  add column if not exists winner_id uuid references players(id) on delete set null;

-- ── 2. Intel rotation: add active flag to rumors ─────────────────────────────

alter table rumors add column if not exists active boolean not null default true;

-- Realtime already subscribed; nothing else needed.

-- ── 3. 20-item market template ───────────────────────────────────────────────

create or replace function _market_template()
returns table(id text, name text, tier text, base_price numeric, is_illegal boolean)
language sql immutable as $$
  values
    -- common (6)
    ('batteries',    'Batteries',       'common',    120, false),
    ('electronics',  'Electronics',     'common',    340, false),
    ('gold',         'Gold',            'common',   1000, false),
    ('fuel',         'Fuel Cells',      'common',    280, false),
    ('medicine',     'Medicine',        'common',    200, false),
    ('oil_drums',    'Oil Drums',       'common',    160, false),
    -- rare (7)
    ('ancient_coins','Ancient Coins',   'rare',     2800, false),
    ('crypto_keys',  'Crypto Keys',     'rare',     4200, false),
    ('lost_docs',    'Lost Documents',  'rare',     3600, false),
    ('data_drives',  'Data Drives',     'rare',     3800, false),
    ('rare_earth',   'Rare Earth',      'rare',     4600, false),
    ('bio_sample',   'Bio Sample',      'rare',     5100, true ),
    ('weapons_cache','Weapons Cache',   'rare',     7200, true ),
    -- legendary (7)
    ('red_diamond',  'Red Diamond',     'legendary',18000, false),
    ('gov_secrets',  'Gov. Secrets',    'legendary',22000, true ),
    ('quantum_chip', 'Quantum Chip',    'legendary',31000, false),
    ('prototype_ai', 'Prototype AI',    'legendary',35000, false),
    ('dark_matter',  'Dark Matter',     'legendary',42000, false),
    ('stolen_art',   'Stolen Art',      'legendary',26000, true ),
    ('neural_implant','Neural Implant', 'legendary',29000, false);
$$;

-- ── 4. 15-rumor pool (8 active at a time, rotated by tick) ───────────────────

create or replace function _rumor_template()
returns table(id text, text text, credibility text, cost numeric)
language sql immutable as $$
  values
    ('r1',  'Red Diamond reserves discovered in Sector 7. Price may collapse 60%.','???', 500),
    ('r2',  'Government raid on illegal electronics scheduled next phase.','HOT',1200),
    ('r3',  'Quantum Chip shortage — three suppliers went dark overnight.','COLD', 800),
    ('r4',  'Broker alliance coordinating a Gold pump. Insiders say buy now.','???', 600),
    ('r5',  'Ancient Coins are all counterfeits. Seller running a long con.','HOT', 950),
    ('r6',  'Market Collapse event triggers in 8 minutes. Prepare.','???',2000),
    ('r7',  'Dark Matter extraction process leaked. Supply flooding in 5 minutes.','HOT',1800),
    ('r8',  'Prototype AI units seized at border. Price spike imminent.','COLD',1400),
    ('r9',  'Weapons Cache supplier got raided. Only 3 units remain.','HOT',2200),
    ('r10', 'Rare Earth price manipulated by cartel. Sell before they dump.','???', 900),
    ('r11', 'Stolen Art authentication confirmed. Buyer offering 2x market rate.','COLD',1600),
    ('r12', 'Oil Drums contaminated. Health inspectors moving in. Sell now.','HOT', 700),
    ('r13', 'Bio Sample ban lifted in Sector 9. Demand about to spike.','COLD',1100),
    ('r14', 'Data Drives contain classified files. Government paying premium.','???',1300),
    ('r15', 'Medicine shortage declared. Emergency pricing now in effect.','HOT', 850);
$$;

-- ── 5. Updated _seed_room: 20 items, 15 rumors (8 active), shorter auction ───

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
  i int := 0;
begin
  for item in select * from _market_template() loop
    insert into market_items (game_id, id, name, tier, price, base_price, is_illegal, history)
    values (p_game_id, item.id, item.name, item.tier, item.base_price, item.base_price, item.is_illegal, _init_history(item.base_price));
  end loop;

  -- Seed all 15 rumors; only first 8 are active.
  for rumor in select * from _rumor_template() loop
    i := i + 1;
    insert into rumors (game_id, id, text, credibility, cost, active)
    values (p_game_id, rumor.id, rumor.text, rumor.credibility, rumor.cost, i <= 8);
  end loop;

  insert into auctions (game_id, name, icon, current_bid, bid_count, ends_at)
  values (p_game_id, 'Golden Passport', '🛂', 8500, 6, now() + interval '45 seconds');

  for contract in select * from _contract_template() order by random() limit 5 loop
    insert into contracts (game_id, author, demand, reward, risk, is_illegal, item_id, qty_required, expires_at)
    values (p_game_id, contract.author, contract.demand, contract.reward, contract.risk,
            contract.is_illegal, contract.item_id, contract.qty_required,
            now() + (contract.ttl_seconds || ' seconds')::interval);
  end loop;

  insert into events (game_id, type, text) values (p_game_id, 'neutral', 'THE BLACK MARKET is now open. 15 minutes. Make it count.');
end;
$$;

-- ── 6. Harsher _apply_event ──────────────────────────────────────────────────

create or replace function _apply_event(p_game_id uuid, p_type text, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into events (game_id, type, text) values (p_game_id, p_type, p_text);

  if p_type = 'crash' then
    -- Wipe 50-80% off ALL items (was 40% off random half)
    update market_items
    set price = greatest(round(base_price * 0.15), round(price * (0.2 + random() * 0.3))),
        change = round(price * 0.3) - price,
        change_percent = -70,
        trend = 'down'
    where game_id = p_game_id;

  elsif p_type = 'tax' then
    -- Top 8 players lose 25% (was top 5 lose 15%)
    update players
    set cash = round(cash * 0.75)
    where id in (
      select id from players where game_id = p_game_id and is_admin = false
      order by net_worth desc limit 8
    );

  elsif p_type = 'blackout' then
    update games set blackout_until = now() + interval '90 seconds' where id = p_game_id;

  elsif p_type = 'raid' then
    -- Raid: illegal items lose 80% of value right now
    update market_items
    set price = greatest(round(base_price * 0.1), round(price * 0.2)),
        change_percent = -80,
        trend = 'down'
    where game_id = p_game_id and is_illegal = true;
  end if;

  perform _recompute_net_worth_all(p_game_id);
end;
$$;

-- ── 7. Updated market_tick: faster, harder, rumor rotation, winner on end ────

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
  open_contract_count int;
  contract_tmpl record;
  event_interval int;
  top_player players;
  inactive_rumor record;
  active_rumor_id text;
begin
  select pg_try_advisory_xact_lock(hashtext(p_game_id::text)) into got_lock;
  if not got_lock then return; end if;

  select * into g from games where id = p_game_id for update;
  if g.id is null or g.status <> 'playing' then return; end if;

  elapsed := extract(epoch from (now() - g.tick_at));
  ticks := least(floor(elapsed / 2), 30);
  if ticks < 1 then return; end if;

  -- ── Price simulation: higher volatility, phase-scaled ─────────────────────

  for i in 1..ticks loop
    for it in select * from market_items where game_id = p_game_id loop
      vol := case it.tier
               when 'legendary' then 0.10  -- was 0.06
               when 'rare'      then 0.07  -- was 0.045
               else                   0.04  -- was 0.03
             end;
      drift := random() * 2 - 1;
      pct := drift * vol * (
        case g.phase
          when 'COLLAPSE'     then 5.0   -- was 3x
          when 'FINAL PHASE'  then 2.0
          else                     1.0
        end
      );
      new_price := greatest(
        round(it.base_price * 0.10),  -- floor: 10% of base (was 20%)
        least(round(it.base_price * 8), round(it.price * (1 + pct)))  -- ceiling: 8x base (was 5x)
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

  -- ── Auctions ───────────────────────────────────────────────────────────────

  update auctions
  set current_bid = case when random() > 0.75 then current_bid + round(random()*800+300) else current_bid end,
      bid_count   = case when random() > 0.75 then bid_count + 1 else bid_count end
  where game_id = p_game_id and settled = false and ends_at > now();

  for it in select * from auctions where game_id = p_game_id and settled = false and ends_at <= now() loop
    if it.current_bidder_id is not null then
      insert into inventory (player_id, item_id, qty, avg_buy)
      values (it.current_bidder_id, 'auction:' || it.name, 1, it.current_bid)
      on conflict (player_id, item_id) do update set qty = inventory.qty + 1;
    end if;
    update auctions set settled = true where id = it.id;
    insert into events (game_id, type, text)
    values (p_game_id, 'neutral',
      case when it.current_bidder_id is not null
           then 'AUCTION CLOSED — ' || it.name || ' sold for ' || it.current_bid
           else 'AUCTION CLOSED — ' || it.name || ' had no bids'
      end);
    -- Next auction: 45-second windows (shorter = more pressure)
    insert into auctions (game_id, name, icon, current_bid, bid_count, ends_at)
    values (p_game_id, it.name, it.icon, round(it.current_bid * 0.3), 0,
            now() + interval '45 seconds');
  end loop;

  -- ── Contracts ──────────────────────────────────────────────────────────────

  update contracts set status = 'expired'
  where game_id = p_game_id and status = 'open' and expires_at <= now();

  select count(*) into open_contract_count
  from contracts where game_id = p_game_id and status in ('open','accepted');

  if open_contract_count < 5 and random() > 0.5 then
    select * into contract_tmpl from _contract_template() order by random() limit 1;
    insert into contracts (game_id, author, demand, reward, risk, is_illegal, item_id, qty_required, expires_at)
    values (p_game_id, contract_tmpl.author, contract_tmpl.demand, contract_tmpl.reward, contract_tmpl.risk,
            contract_tmpl.is_illegal, contract_tmpl.item_id, contract_tmpl.qty_required,
            now() + (contract_tmpl.ttl_seconds || ' seconds')::interval);
  end if;

  -- ── Intel rotation: every ~120s, swap one inactive rumor in ──────────────

  if extract(epoch from (now() - g.last_event_at)) >= 120 or
     (select count(*) from rumors where game_id = p_game_id and active = true) < 5 then
    -- Deactivate a random active rumor no one has bought yet
    select r.id into active_rumor_id
    from rumors r
    where r.game_id = p_game_id and r.active = true
      and r.id not in (select rumor_id from rumor_purchases where game_id = p_game_id)
    order by random() limit 1;

    if active_rumor_id is not null then
      update rumors set active = false where game_id = p_game_id and id = active_rumor_id;
    end if;

    -- Activate a random inactive rumor
    select r.id into active_rumor_id
    from rumors r
    where r.game_id = p_game_id and r.active = false
    order by random() limit 1;

    if active_rumor_id is not null then
      update rumors set active = true where game_id = p_game_id and id = active_rumor_id;
    end if;
  end if;

  -- ── Random world events — frequency scales with phase ────────────────────

  event_interval := case g.phase
                      when 'COLLAPSE'    then 5
                      when 'FINAL PHASE' then 10
                      else                    20
                    end;

  if extract(epoch from (now() - g.last_event_at)) >= event_interval then
    if g.phase = 'COLLAPSE' then
      -- Only brutal events in COLLAPSE
      select * into random_event from (values
        ('crash','TOTAL MARKET CRASH — panic selling across all sectors'),
        ('tax','EMERGENCY TAXATION — authorities seizing assets from top traders'),
        ('raid','MASS RAID — all illegal goods flagged and seized'),
        ('blackout','COMMS BLACKOUT — price data cut for 90 seconds')
      ) as t(type, text) order by random() limit 1;
    elsif g.phase = 'FINAL PHASE' then
      -- Mix of bad and neutral
      select * into random_event from (values
        ('crash','MARKET CRASH — sell-off triggered by false reserve reports'),
        ('raid','GOVERNMENT RAID — illegal shipment intercepted'),
        ('tax','TAX SWEEP — the top 8 operators just lost 25%'),
        ('blackout','SIGNAL JAM — price feeds disrupted for 90 seconds'),
        ('neutral','FINAL PHASE — the market is entering its last chapter'),
        ('leak','INTELLIGENCE LEAK — a player''s full inventory is now public')
      ) as t(type, text) order by random() limit 1;
    else
      select * into random_event from (values
        ('crash','MARKET CRASH — false reserve report triggers a sell-off'),
        ('raid','GOVERNMENT RAID — illegal goods seized from an unknown seller'),
        ('leak','INFORMATION LEAK — a player''s inventory has been exposed'),
        ('tax','TAX COLLECTION — the wealthiest operators just lost 25%'),
        ('blackout','BLACKOUT EVENT — all price data hidden for 90 seconds'),
        ('neutral','NEW CONTRACT — a buyer is offering a premium for rare goods'),
        ('neutral','RUMOUR MILL — new intel circulating. Check the Intel tab.')
      ) as t(type, text) order by random() limit 1;
    end if;

    perform _apply_event(p_game_id, random_event.type, random_event.text);
    update games set last_event_at = now() where id = p_game_id;
  end if;

  -- ── Phase transitions (15-min game) ──────────────────────────────────────

  end_remaining := g.duration_seconds - extract(epoch from (now() - g.started_at));

  -- On game end: find winner, broadcast, mark ended
  if end_remaining <= 0 and g.status = 'playing' then
    select * into top_player
    from players
    where game_id = p_game_id and is_admin = false
    order by net_worth desc limit 1;

    insert into events (game_id, type, text)
    values (p_game_id, 'neutral',
      case when top_player.id is not null
           then '🏆 GAME OVER — ' || top_player.handle || ' wins with ' || top_player.net_worth::text
           else '🏆 GAME OVER — The market has closed.'
      end);

    update games
    set status = 'ended',
        phase  = 'COLLAPSE',
        winner_id = top_player.id
    where id = p_game_id;

  else
    update games
    set phase = case
          when end_remaining <= 90  then 'COLLAPSE'     -- last 90s
          when end_remaining <= 240 then 'FINAL PHASE'  -- last 4 min
          else 'OPEN'
        end,
        tick_at = g.tick_at + (ticks * interval '2 seconds')
    where id = p_game_id;
  end if;

  perform _recompute_net_worth_all(p_game_id);
end;
$$;

-- ── 8. buy_item: add 3% transaction fee + busted check ───────────────────────

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
  fee numeric;
  inv inventory;
begin
  if p_qty is null or p_qty <= 0 then raise exception 'INVALID_QTY'; end if;

  select * into me from players where game_id = p_game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;

  -- Busted check: net worth below ₦1500 = locked out of trading
  if me.net_worth < 1500 then raise exception 'ACCOUNT_FROZEN'; end if;

  select * into mkt from market_items where game_id = p_game_id and id = p_item_id;
  if mkt.id is null then raise exception 'UNKNOWN_ITEM'; end if;

  total := mkt.price * p_qty;
  fee   := greatest(1, round(total * 0.03));  -- 3% transaction fee, minimum ₦1

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
      rep = least(100, rep + 1)
  where id = me.id
  returning * into me;

  insert into trades (game_id, player_id, item_id, side, qty, price)
  values (p_game_id, me.id, p_item_id, 'buy', p_qty, mkt.price);

  perform _recompute_net_worth(me.id);
  select * into me from players where id = me.id;
  return me;
end;
$$;

-- ── 9. sell_item: rep penalty if selling at a loss ───────────────────────────

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
  rep_change int;
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

  -- Selling at a loss hits your reputation harder
  rep_change := case
    when mkt.price >= inv.avg_buy then 2    -- profit: +2 rep
    when mkt.price >= inv.avg_buy * 0.8 then -1  -- small loss: -1 rep
    else -4                                  -- big loss (>20%): -4 rep
  end;

  if sell_qty = inv.qty then
    delete from inventory where player_id = me.id and item_id = p_item_id;
  else
    update inventory set qty = qty - sell_qty where player_id = me.id and item_id = p_item_id;
  end if;

  update players
  set cash = cash + earned,
      trade_count = trade_count + 1,
      rep = greatest(0, least(100, rep + rep_change))
  where id = me.id
  returning * into me;

  insert into trades (game_id, player_id, item_id, side, qty, price)
  values (p_game_id, me.id, p_item_id, 'sell', sell_qty, mkt.price);

  perform _recompute_net_worth(me.id);
  select * into me from players where id = me.id;
  return me;
end;
$$;

-- ── 10. Add ACCOUNT_FROZEN error and update read policy for active rumors ─────

-- Updated RLS: rumors — only show active ones to players in their room
drop policy if exists "read rumors in my rooms" on rumors;
drop policy if exists "read rumors" on rumors;
create policy "read active rumors in my rooms" on rumors
  for select using (game_id in (select _my_game_ids()) and active = true);

alter publication supabase_realtime add table rumors;
