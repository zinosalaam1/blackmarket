// Mirrors the Supabase schema (supabase/migrations/0001_init.sql).

export type GameStatus = "lobby" | "playing" | "ended";
export type GamePhase = "OPEN" | "FINAL PHASE" | "COLLAPSE";

export interface GameRow {
  id: string;
  status: GameStatus;
  phase: GamePhase;
  duration_seconds: number;
  started_at: string | null;
  tick_at: string;
  last_event_at: string;
  blackout_until: string | null;
  created_at: string;
}

export interface PlayerRow {
  id: string;
  game_id: string;
  user_id: string | null;
  handle: string;
  is_admin: boolean;
  is_npc: boolean;
  objective_id: string | null;
  cash: number;
  net_worth: number;
  rep: number;
  trade_count: number;
  online: boolean;
  joined_at: string;
}

export interface MarketItemRow {
  game_id: string;
  id: string;
  name: string;
  tier: "common" | "rare" | "legendary";
  price: number;
  base_price: number;
  change: number;
  change_percent: number;
  trend: "up" | "down" | "stable";
  is_illegal: boolean;
  history: number[];
}

export interface InventoryRow {
  player_id: string;
  item_id: string;
  qty: number;
  avg_buy: number;
}

export interface RumorRow {
  game_id: string;
  id: string;
  text: string;
  credibility: "HOT" | "COLD" | "???";
  cost: number;
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
  ends_at: string;
  settled: boolean;
  created_at: string;
}

export type ContractStatus = "open" | "accepted" | "completed" | "expired" | "cancelled";
export type ContractRisk = "LOW" | "MED" | "HIGH" | "EXTREME";

export interface ContractRow {
  id: string;
  game_id: string;
  author: string;
  demand: string;
  reward: number;
  risk: ContractRisk;
  is_illegal: boolean;
  item_id: string | null;
  qty_required: number;
  status: ContractStatus;
  accepted_by: string | null;
  expires_at: string;
  created_at: string;
}
