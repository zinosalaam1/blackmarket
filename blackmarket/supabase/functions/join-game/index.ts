// supabase/functions/join-game/index.ts
//
// Input:  { code: string, handle: string }
// Output: { gameId, playerId, handle }

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerUserId } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { code, handle } = await req.json();
    if (!code || !handle) return errorResponse("code and handle are required");

    const cleaned = String(handle).trim().replace(/\s+/g, "_").toUpperCase().slice(0, 16);
    if (cleaned.length < 3) return errorResponse("Handle must be at least 3 characters");
    if (!/^[A-Z0-9_]+$/.test(cleaned)) return errorResponse("Only letters, numbers, and underscores allowed");

    const userId = await getCallerUserId(req);
    const db = adminClient();

    const { data: game, error: gameErr } = await db
      .from("games")
      .select("*")
      .eq("code", String(code).toUpperCase())
      .maybeSingle();
    if (gameErr) throw gameErr;
    if (!game) return errorResponse("Game not found", 404);
    if (game.status !== "lobby") return errorResponse("This game has already started", 409);

    // Already joined? (reconnect case)
    const { data: existing } = await db
      .from("players")
      .select("*")
      .eq("game_id", game.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (existing) {
      await db.from("players").update({ online: true }).eq("id", existing.id);
      return jsonResponse({ gameId: game.id, playerId: existing.id, handle: existing.handle });
    }

    const { data: player, error: playerErr } = await db
      .from("players")
      .insert({ game_id: game.id, user_id: userId, handle: cleaned, cash: game.starting_cash })
      .select()
      .single();

    if (playerErr) {
      if (playerErr.code === "23505") return errorResponse("That handle is already taken in this game", 409);
      throw playerErr;
    }

    return jsonResponse({ gameId: game.id, playerId: player.id, handle: player.handle });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
