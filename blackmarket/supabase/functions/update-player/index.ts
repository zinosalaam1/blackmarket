// supabase/functions/update-player/index.ts
//
// Input:  { gameId, targetPlayerId, objectiveId?: string|null, remove?: boolean }
// Admin only.

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerPlayer } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId, targetPlayerId, objectiveId, remove } = await req.json();
    if (!gameId || !targetPlayerId) return errorResponse("gameId and targetPlayerId are required");

    const db = adminClient();
    await getCallerPlayer(db, req, gameId, { requireAdmin: true });

    const { data: target, error: targetErr } = await db
      .from("players")
      .select("id, game_id")
      .eq("id", targetPlayerId)
      .eq("game_id", gameId)
      .maybeSingle();
    if (targetErr) throw targetErr;
    if (!target) return errorResponse("Player not found in this game", 404);

    if (remove) {
      const { error } = await db.from("players").delete().eq("id", targetPlayerId);
      if (error) throw error;
      return jsonResponse({ ok: true, removed: true });
    }

    if (objectiveId !== undefined) {
      const { error } = await db
        .from("players")
        .update({ objective_id: objectiveId })
        .eq("id", targetPlayerId);
      if (error) throw error;
    }

    return jsonResponse({ ok: true });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
