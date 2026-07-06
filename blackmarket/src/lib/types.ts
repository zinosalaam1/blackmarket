// Mirrors the Supabase schema (supabase/migrations/0001_init.sql).

export type GameStatus = "lobby" | "playing" | "ended";
export type GamePhase = "OPEN" | "FINAL PHASE" | "COLLAPSE";

export interface GameRow {
  id: string;
  code: string;
  status: GameStatus;
  phase: GamePhase;
  duration_seconds: number;
  started_at: string | null;
  tick_at: string;
  last_event_at: string;
  blackout_until: string | null;
  winner_id: string | null;
  is_public: boolean;
  player_count: number;
  room_name: string | null;
  created_at: string;
}

export interface PublicRoomRow {
  id: string;
  code: string;
  room_name: string | null;
  status: GameStatus;
  phase: GamePhase;
  player_count: number;
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
  wanted_level: number;
  frozen_until: string | null;
  player_blackout_until: string | null;
  total_debt: number;
  objective_completed: boolean | null;
  objective_score: string | null;
  crash_triggers: number;
  illegal_trade_count: number;
  ops_actions_count: number;
  npc_strategy: string;
  peak_rank: number | null;
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
  pump_until: string | null;
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
  active: boolean;
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
  is_final: boolean;
  created_at: string;
}

export interface BountyRow {
  id: string;
  game_id: string;
  placer_id: string;
  target_id: string;
  amount: number;
  triggers_remaining: number;
  status: "active" | "expired";
  created_at: string;
}

export type LoanStatus = "active" | "repaid" | "defaulted";

export interface LoanRow {
  id: string;
  game_id: string;
  player_id: string;
  principal: number;
  total_owed: number;
  due_at: string;
  status: LoanStatus;
  taken_at: string;
}

export interface ProfileRow {
  user_id: string;
  handle: string;
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
