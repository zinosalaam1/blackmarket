-- ============================================================================
-- THE BLACK MARKET — Contracts + accurate net worth
-- (Presence/online status is handled client-side via Supabase Realtime
--  Presence — no schema changes needed for that part.)
-- ============================================================================

-- ── Net worth: a denormalized, publicly-readable column so the leaderboard
--    can rank everyone accurately without exposing anyone's private
--    inventory contents (which stay RLS-protected). ───────────────────────
alter table players add column if not exists net_worth numeric not null default 10000;
update players set net_worth = cash where net_worth is null;

create or replace function _recompute_net_worth(p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  nw numeric;
begin
  select pl.cash + coalesce(sum(i.qty * coalesce(m.price, i.avg_buy)), 0)
  into nw
  from players pl
  left join inventory i on i.player_id = pl.id
  left join market_items m on m.game_id = pl.game_id and m.id = i.item_id
  where pl.id = p_player_id
  group by pl.id, pl.cash;

  update players set net_worth = coalesce(nw, cash) where id = p_player_id;
end;
$$;

create or replace function _recompute_net_worth_all(p_game_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update players p
  set net_worth = p.cash + coalesce(inv.val, 0)
  from (
    select pl.id as player_id, sum(i.qty * coalesce(m.price, i.avg_buy)) as val
    from players pl
    left join inventory i on i.player_id = pl.id
    left join market_items m on m.game_id = pl.game_id and m.id = i.item_id
    where pl.game_id = p_game_id
    group by pl.id
  ) inv
  where p.id = inv.player_id and p.game_id = p_game_id;
end;
$$;

-- Recompute net worth right after every action that changes cash/inventory,
-- so it's instant for the acting player (not just on the next ~2s tick).

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
  if p_qty is null or p_qty <= 0 then raise exception 'INVALID_QTY'; end if;

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

  perform _recompute_net_worth(me.id);
  select * into me from players where id = me.id;
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

  perform _recompute_net_worth(me.id);
  select * into me from players where id = me.id;
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
    perform _recompute_net_worth(a.current_bidder_id);
  end if;

  update players set cash = cash - p_amount where id = me.id;
  perform _recompute_net_worth(me.id);

  update auctions
  set current_bid = p_amount, current_bidder_id = me.id, bid_count = bid_count + 1
  where id = p_auction_id
  returning * into a;

  return a;
end;
$$;

-- ── Contracts ────────────────────────────────────────────────────────────────

create table if not exists contracts (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references games(id) on delete cascade,
  author       text not null,
  demand       text not null,
  reward       numeric not null,
  risk         text not null check (risk in ('LOW','MED','HIGH','EXTREME')),
  is_illegal   boolean not null default false,
  item_id      text,
  qty_required int not null default 1,
  status       text not null default 'open' check (status in ('open','accepted','completed','expired','cancelled')),
  accepted_by  uuid references players(id),
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_contracts_game on contracts(game_id, status);

alter table contracts enable row level security;
create policy "read contracts" on contracts for select using (true);

create or replace function _contract_template()
returns table(author text, demand text, reward numeric, risk text, is_illegal boolean, item_id text, qty_required int, ttl_seconds int)
language sql
immutable
as $$
  values
    ('The_Broker','Deliver 1× Quantum Chip',50000,'HIGH',false,'quantum_chip',1,900),
    ('CIPHER_X','Deliver 3× Ancient Coins',12000,'MED',false,'ancient_coins',3,600),
    ('Madame_X','Deliver 2× Gold',8000,'LOW',false,'gold',2,1200),
    ('ShadowDealer','Deliver 1× Gov. Secrets — no questions asked',25000,'EXTREME',true,'gov_secrets',1,500),
    ('NightOwl','Deliver 2× Bio Sample',18000,'EXTREME',true,'bio_sample',2,500),
    ('The_Cartel','Deliver 1× Red Diamond',30000,'HIGH',false,'red_diamond',1,700),
    ('Anon_Buyer','Deliver 5× Batteries',4000,'LOW',false,'batteries',5,900),
    ('Mr_Fixit','Deliver 2× Crypto Keys',15000,'MED',false,'crypto_keys',2,800),
    ('Q','Deliver 4× Fuel Cells',6000,'LOW',false,'fuel',4,1000),
    ('The_Archivist','Deliver 1× Lost Document',9000,'MED',false,'lost_docs',1,800);
$$;

-- Add contract seeding to lobby creation.
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
  contract record;
  i int := 0;
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

  for contract in select * from _contract_template() order by random() limit 4 loop
    insert into contracts (game_id, author, demand, reward, risk, is_illegal, item_id, qty_required, expires_at)
    values (g.id, contract.author, contract.demand, contract.reward, contract.risk, contract.is_illegal, contract.item_id, contract.qty_required, now() + (contract.ttl_seconds || ' seconds')::interval);
  end loop;

  insert into events (game_id, type, text)
  values (g.id, 'neutral', 'THE BLACK MARKET is now open.');

  return g;
end;
$$;

create or replace function accept_contract(p_contract_id uuid)
returns contracts
language plpgsql
security definer
set search_path = public
as $$
declare
  c contracts;
  me players;
begin
  select * into c from contracts where id = p_contract_id for update;
  if c.id is null or c.status <> 'open' or c.expires_at <= now() then
    raise exception 'CONTRACT_UNAVAILABLE';
  end if;

  select * into me from players where game_id = c.game_id and user_id = auth.uid();
  if me.id is null then raise exception 'NOT_A_PLAYER'; end if;

  update contracts set status = 'accepted', accepted_by = me.id where id = p_contract_id returning * into c;
  return c;
end;
$$;

create or replace function cancel_contract(p_contract_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c contracts;
  me players;
begin
  select * into c from contracts where id = p_contract_id for update;
  if c.id is null then raise exception 'UNKNOWN_CONTRACT'; end if;

  select * into me from players where game_id = c.game_id and user_id = auth.uid();
  if me.id is null or c.accepted_by is distinct from me.id then raise exception 'NOT_YOUR_CONTRACT'; end if;

  update contracts set status = 'open', accepted_by = null where id = p_contract_id;
end;
$$;

create or replace function complete_contract(p_contract_id uuid)
returns players
language plpgsql
security definer
set search_path = public
as $$
declare
  c contracts;
  me players;
  inv inventory;
begin
  select * into c from contracts where id = p_contract_id for update;
  if c.id is null or c.status <> 'accepted' then raise exception 'CONTRACT_NOT_ACCEPTED'; end if;

  select * into me from players where game_id = c.game_id and user_id = auth.uid();
  if me.id is null or c.accepted_by is distinct from me.id then raise exception 'NOT_YOUR_CONTRACT'; end if;

  if c.item_id is not null then
    select * into inv from inventory where player_id = me.id and item_id = c.item_id;
    if inv.player_id is null or inv.qty < c.qty_required then
      raise exception 'MISSING_GOODS';
    end if;
    if inv.qty = c.qty_required then
      delete from inventory where player_id = me.id and item_id = c.item_id;
    else
      update inventory set qty = qty - c.qty_required where player_id = me.id and item_id = c.item_id;
    end if;
  end if;

  update players
  set cash = cash + c.reward, rep = least(100, rep + 3), trade_count = trade_count + 1
  where id = me.id
  returning * into me;

  update contracts set status = 'completed' where id = p_contract_id;

  insert into events (game_id, type, text)
  values (c.game_id, 'neutral', me.handle || ' fulfilled a contract for ' || c.reward::text);

  perform _recompute_net_worth(me.id);
  select * into me from players where id = me.id;
  return me;
end;
$$;

-- ── Fold contract expiry/spawn + net-worth-all into the existing tick ──────

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
  contract_tmpl record;
  open_contract_count int;
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

  -- contracts: expire stale ones, spawn fresh ones to keep the board alive
  update contracts set status = 'expired' where game_id = p_game_id and status = 'open' and expires_at <= now();

  select count(*) into open_contract_count from contracts where game_id = p_game_id and status in ('open','accepted');
  if open_contract_count < 4 and random() > 0.6 then
    select * into contract_tmpl from _contract_template() order by random() limit 1;
    insert into contracts (game_id, author, demand, reward, risk, is_illegal, item_id, qty_required, expires_at)
    values (p_game_id, contract_tmpl.author, contract_tmpl.demand, contract_tmpl.reward, contract_tmpl.risk,
            contract_tmpl.is_illegal, contract_tmpl.item_id, contract_tmpl.qty_required, now() + (contract_tmpl.ttl_seconds || ' seconds')::interval);
  end if;

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

  -- prices (and possibly contracts/auctions) just moved everyone's portfolio value
  perform _recompute_net_worth_all(p_game_id);
end;
$$;

-- tax events also move cash directly — keep net worth in sync immediately
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

  perform _recompute_net_worth_all(p_game_id);
end;
$$;

grant execute on function
  accept_contract(uuid), cancel_contract(uuid), complete_contract(uuid)
to authenticated, anon;

alter publication supabase_realtime add table contracts;
