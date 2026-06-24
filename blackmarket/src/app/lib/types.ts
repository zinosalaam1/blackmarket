export interface GameRow {
  id: string;
  code: string;
  status: "lobby" | "playing" | "ended";
  phase: "OPEN" | "FINAL PHASE" | "COLLAPSE";
  blackout_until: string | null;
  starting_cash: number;
  started_at: string | null;
  ends_at: string | null;
  last_tick_at: string;
  created_at: string;
}

export interface PlayerRow {
  id: string;
  game_id: string;
  user_id: string;
  handle: string;
  is_admin: boolean;
  is_npc: boolean;
  objective_id: string | null;
  cash: number;
  rep: number;
  trade_count: number;
  online: boolean;
  flag: string | null;
  joined_at: string;
}

export interface MarketItemRow {
  id: string;
  game_id: string;
  item_key: string;
  name: string;
  tier: "common" | "rare" | "legendary";
  icon: string;
  is_illegal: boolean;
  base_price: number;
  price: number;
  change: number;
  change_percent: number;
  trend: "up" | "down" | "stable";
  history: number[];
  updated_at: string;
}

export interface InventoryRow {
  id: string;
  game_id: string;
  player_id: string;
  item_key: string;
  qty: number;
  avg_buy: number;
}

export interface RumorRow {
  id: string;
  game_id: string;
  text: string;
  credibility: "HOT" | "COLD" | "???";
  cost: number;
}

export interface PlayerRumorRow {
  player_id: string;
  rumor_id: string;
  purchased_at: string;
}

export interface EventRow {
  id: string;
  game_id: string;
  type: "crash" | "raid" | "leak" | "tax" | "blackout" | "neutral";
  text: string;
  created_at: string;
}

export interface AuctionRow {
  id: string;
  game_id: string;
  name: string;
  icon: string;
  current_bid: number;
  current_bidder_id: string | null;
  bid_count: number;
  status: "open" | "closed";
  ends_at: string;
  created_at: string;
}

export interface SecretObjective {
  id: string;
  role: string;
  goal: string;
  hint: string;
  color: string;
  icon: string;
}
