// supabase/functions/add-npc/index.ts
//
// Input:  { gameId }
// Admin only. Adds a bot player with a randomized starting cash/rep so the
// leaderboard has some life; market-tick gives NPCs a small random walk.

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerPlayer } from "../_shared/db.ts";

const HANDLES = ["PHANTOM_X", "DARKPOOL", "VOID_TRADER", "ANON_7", "MARKET_GHOST", "THE_ORACLE", "ZERO_DAY", "CIPHER_X", "NightOwl", "The_Broker", "GhostTrade", "MarketKing", "Viper_7", "ShadowDealer", "Madame_X"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId } = await req.json();
    if (!gameId) return errorResponse("gameId is required");

    const db = adminClient();
    await getCallerPlayer(db, req, gameId, { requireAdmin: true });

    const { data: existing } = await db.from("players").select("handle").eq("game_id", gameId);
    const used = new Set((existing ?? []).map((p) => p.handle));
    const available = HANDLES.filter((h) => !used.has(h));
    const handle = available[Math.floor(Math.random() * available.length)] ?? `NPC_${Math.floor(Math.random() * 999)}`;

    // NPCs need a row in auth.users to satisfy the FK; we create a
    // service-managed user with no password/email so it can never log in.
    const { data: authUser, error: authErr } = await db.auth.admin.createUser({
      email: `npc-${crypto.randomUUID()}@bots.blackmarket.local`,
      email_confirm: true,
    });
    if (authErr) throw authErr;

    const { data: player, error } = await db
      .from("players")
      .insert({
        game_id: gameId,
        user_id: authUser.user.id,
        handle,
        is_npc: true,
        cash: 8_000 + Math.floor(Math.random() * 55_000),
        rep: 30 + Math.floor(Math.random() * 65),
        trade_count: Math.floor(Math.random() * 40),
      })
      .select()
      .single();
    if (error) throw error;

    return jsonResponse({ ok: true, player });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
