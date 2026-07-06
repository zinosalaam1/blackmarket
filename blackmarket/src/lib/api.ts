import { supabase } from "./supabase";
import type {
  AuctionRow, BountyRow, ContractRow, EventRow, GameRow, InventoryRow,
  LoanRow, MarketItemRow, PlayerRow, ProfileRow, RumorRow,
} from "./types";

// Friendly error messages for the exceptions raised by the RPC functions in
// supabase/migrations/0001_init.sql. Anything not in this map falls back to
// a generic message.
const ERROR_MESSAGES: Record<string, string> = {
  NOT_AUTHENTICATED: "You're not signed in — log in and try again.",
  INVALID_HANDLE: "Handle must be 3-16 characters: letters, numbers, underscores only.",
  HANDLE_TAKEN: "That handle is already taken.",
  PROFILE_REQUIRED: "Finish setting up your profile first.",
  ROOM_NOT_FOUND: "No active room with that code. Double-check it, or host a new game.",
  CODE_GEN_FAILED: "Couldn't generate a room code — try again in a moment.",
  ADMIN_ONLY: "Admin access required.",
  NOT_A_PLAYER: "You're not registered in this room yet.",
  UNKNOWN_ITEM: "Unknown item.",
  UNKNOWN_RUMOR: "Unknown rumor.",
  INVALID_QTY: "Invalid quantity.",
  INSUFFICIENT_FUNDS: "Insufficient funds.",
  NOTHING_TO_SELL: "You don't hold any of that item.",
  ALREADY_PURCHASED: "You already bought that intel.",
  ACCOUNT_FROZEN: "Your account is frozen — net worth is too low to trade.",
  PLAYER_FROZEN: "Your account has been frozen. You cannot trade right now.",
  UNKNOWN_TARGET: "Unknown target player.",
  CANT_TARGET_SELF: "You can't target yourself.",
  CANT_TARGET_ADMIN: "You can't target the admin.",
  TARGET_ALREADY_FROZEN: "That player is already frozen.",
  ALREADY_PUMPED: "That item is already being pumped.",
  EXISTING_LOAN: "You already have an active loan. Repay it first.",
  INVALID_LOAN_AMOUNT: "Loan must be between ₦1,000 and ₦25,000.",
  LOAN_PERIOD_CLOSED: "Loans are closed in the last 2 minutes of the game.",
  NO_ACTIVE_LOAN: "You have no active loan to repay.",
  BOUNTY_TOO_LOW: "Minimum bounty is ₦2,000.",
  BID_TOO_LOW: "Your bid must exceed the current bid.",
  CONTRACT_UNAVAILABLE: "That contract is no longer available.",
  CONTRACT_NOT_ACCEPTED: "You need to accept this contract before completing it.",
  NOT_YOUR_CONTRACT: "That contract belongs to someone else.",
  MISSING_GOODS: "You don't hold enough of the required goods to fulfill this contract.",
  UNKNOWN_CONTRACT: "Unknown contract.",
};

function friendlyError(err: unknown): Error & { code?: string } {
  const raw = (err as { message?: string })?.message ?? String(err);
  const code = Object.keys(ERROR_MESSAGES).find((k) => raw.includes(k));
  const out = new Error(code ? ERROR_MESSAGES[code] : raw) as Error & { code?: string };
  out.code = code;
  return out;
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw friendlyError(error);
  return data as T;
}

// ── Lobby / session ─────────────────────────────────────────────────────────

// ── Auth & profile ────────────────────────────────────────────────────────────

export async function signUp(email: string, password: string) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw friendlyError(error);
  return { session: data.session, needsConfirmation: !data.session };
}

export async function signIn(email: string, password: string) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw friendlyError(error);
  return data;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw friendlyError(error);
}

export async function requestPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  if (error) throw friendlyError(error);
}

export async function updatePassword(password: string) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw friendlyError(error);
}

export async function resendConfirmation(email: string) {
  const { error } = await supabase.auth.resend({ type: "signup", email });
  if (error) throw friendlyError(error);
}

export async function fetchMyProfile() {
  const { data, error } = await supabase.from("profiles").select("*").maybeSingle();
  if (error) throw friendlyError(error);
  return data as ProfileRow | null;
}

export const createProfile = (handle: string) => rpc<ProfileRow>("create_profile", { p_handle: handle });

// ── Rooms ────────────────────────────────────────────────────────────────────

export const createRoom = (isPublic = false, roomName?: string) =>
  rpc<GameRow>("create_room", { p_is_public: isPublic, p_room_name: roomName ?? null });
export const joinRoom = (code: string) => rpc<PlayerRow>("join_room", { p_code: code });
export const leaveGame = (gameId: string) => rpc<void>("leave_game", { p_game_id: gameId });

export async function listPublicRooms() {
  const { data, error } = await supabase.rpc("list_public_rooms");
  if (error) throw friendlyError(error);
  return (data ?? []) as import("./types").PublicRoomRow[];
}

export async function registerPushToken(token: string, platform: "android" | "ios" | "web") {
  const user = (await supabase.auth.getUser()).data.user;
  if (!user) return;
  await supabase.from("device_tokens").upsert(
    { user_id: user.id, token, platform, updated_at: new Date().toISOString() },
    { onConflict: "user_id,platform" }
  );
}

// ── Admin actions ────────────────────────────────────────────────────────────

export const adminUpdatePlayerObjective = (playerId: string, objectiveId: string) =>
  rpc<void>("admin_update_player", { p_player_id: playerId, p_objective_id: objectiveId });
export const adminRemovePlayer = (playerId: string) =>
  rpc<void>("admin_remove_player", { p_player_id: playerId });
export const adminAddNpc = (gameId: string) => rpc<PlayerRow>("admin_add_npc", { p_game_id: gameId });
export const adminAutoAssignObjectives = (gameId: string) =>
  rpc<void>("admin_auto_assign_objectives", { p_game_id: gameId });
export const adminStartGame = (gameId: string) => rpc<GameRow>("admin_start_game", { p_game_id: gameId });
export const adminResetGame = (gameId: string) => rpc<GameRow>("admin_reset_game", { p_game_id: gameId });
export const adminTriggerEvent = (gameId: string, type: string, text: string) =>
  rpc<void>("admin_trigger_event", { p_game_id: gameId, p_type: type, p_text: text });

// ── Market simulation (safe to call repeatedly from any client) ────────────

export const marketTick = (gameId: string) => rpc<void>("market_tick", { p_game_id: gameId });

// ── Trading ──────────────────────────────────────────────────────────────────

export const buyItem = (gameId: string, itemId: string, qty: number) =>
  rpc<PlayerRow>("buy_item", { p_game_id: gameId, p_item_id: itemId, p_qty: qty });
export const sellItem = (gameId: string, itemId: string, qty?: number) =>
  rpc<PlayerRow>("sell_item", { p_game_id: gameId, p_item_id: itemId, p_qty: qty ?? null });
export const buyRumor = (gameId: string, rumorId: string) =>
  rpc<PlayerRow>("buy_rumor", { p_game_id: gameId, p_rumor_id: rumorId });
export const placeBid = (auctionId: string, amount: number) =>
  rpc<AuctionRow>("place_bid", { p_auction_id: auctionId, p_amount: amount });

// ── Operations ────────────────────────────────────────────────────────────────

export const placeBounty = (gameId: string, targetId: string, amount: number) =>
  rpc<BountyRow>("place_bounty", { p_game_id: gameId, p_target_id: targetId, p_amount: amount });

export const targetBlackout = (gameId: string, targetId: string) =>
  rpc<void>("target_blackout", { p_game_id: gameId, p_target_id: targetId });

export const pumpItem = (gameId: string, itemId: string) =>
  rpc<MarketItemRow>("pump_item", { p_game_id: gameId, p_item_id: itemId });

export const takeLoan = (gameId: string, amount: number) =>
  rpc<LoanRow>("take_loan", { p_game_id: gameId, p_amount: amount });

export const repayLoan = (gameId: string) =>
  rpc<PlayerRow>("repay_loan", { p_game_id: gameId });

export const assassinatePlayer = (gameId: string, targetId: string) =>
  rpc<void>("assassinate_player", { p_game_id: gameId, p_target_id: targetId });

export async function fetchBounties(gameId: string) {
  const { data, error } = await supabase
    .from("bounties").select("*").eq("game_id", gameId).order("created_at", { ascending: false });
  if (error) throw friendlyError(error);
  return data as BountyRow[];
}

export async function fetchMyLoan(playerId: string, gameId: string) {
  const { data, error } = await supabase
    .from("loans").select("*").eq("player_id", playerId).eq("game_id", gameId)
    .eq("status", "active").maybeSingle();
  if (error) throw friendlyError(error);
  return data as LoanRow | null;
}

// ── Contracts ────────────────────────────────────────────────────────────────

export const acceptContract = (contractId: string) => rpc<ContractRow>("accept_contract", { p_contract_id: contractId });
export const cancelContract = (contractId: string) => rpc<void>("cancel_contract", { p_contract_id: contractId });
export const completeContract = (contractId: string) => rpc<PlayerRow>("complete_contract", { p_contract_id: contractId });

export async function fetchContracts(gameId: string) {
  const { data, error } = await supabase
    .from("contracts").select("*").eq("game_id", gameId)
    .order("created_at", { ascending: false });
  if (error) throw friendlyError(error);
  return data as ContractRow[];
}

// ── Plain reads (initial load — realtime keeps things fresh afterwards) ───

export async function fetchGame(gameId: string) {
  const { data, error } = await supabase.from("games").select("*").eq("id", gameId).single();
  if (error) throw friendlyError(error);
  return data as GameRow;
}

export async function fetchPlayers(gameId: string) {
  const { data, error } = await supabase.from("players").select("*").eq("game_id", gameId).order("joined_at");
  if (error) throw friendlyError(error);
  return data as PlayerRow[];
}

export async function fetchMarketItems(gameId: string) {
  const { data, error } = await supabase.from("market_items").select("*").eq("game_id", gameId);
  if (error) throw friendlyError(error);
  return data as MarketItemRow[];
}

export async function fetchRumors(gameId: string) {
  const { data, error } = await supabase
    .from("rumors").select("*").eq("game_id", gameId).eq("active", true);
  if (error) throw friendlyError(error);
  return data as RumorRow[];
}

export async function fetchPurchasedRumorIds(playerId: string) {
  const { data, error } = await supabase.from("rumor_purchases").select("rumor_id").eq("player_id", playerId);
  if (error) throw friendlyError(error);
  return (data ?? []).map((r) => r.rumor_id as string);
}

export async function fetchEvents(gameId: string, limit = 20) {
  const { data, error } = await supabase
    .from("events").select("*").eq("game_id", gameId)
    .order("created_at", { ascending: false }).limit(limit);
  if (error) throw friendlyError(error);
  return data as EventRow[];
}

export async function fetchActiveAuction(gameId: string) {
  const { data, error } = await supabase
    .from("auctions").select("*").eq("game_id", gameId).eq("settled", false)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw friendlyError(error);
  return data as AuctionRow | null;
}

export async function fetchInventory(playerId: string) {
  const { data, error } = await supabase.from("inventory").select("*").eq("player_id", playerId);
  if (error) throw friendlyError(error);
  return data as InventoryRow[];
}
