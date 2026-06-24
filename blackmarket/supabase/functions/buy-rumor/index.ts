// supabase/functions/buy-rumor/index.ts
//
// Input: { gameId, rumorId }

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerPlayer } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId, rumorId } = await req.json();
    if (!gameId || !rumorId) return errorResponse("gameId and rumorId are required");

    const db = adminClient();
    const player = await getCallerPlayer(db, req, gameId);

    const { data: rumor, error: rumorErr } = await db
      .from("rumors")
      .select("*")
      .eq("id", rumorId)
      .eq("game_id", gameId)
      .maybeSingle();
    if (rumorErr) throw rumorErr;
    if (!rumor) return errorResponse("Rumor not found", 404);

    const { data: already } = await db
      .from("player_rumors")
      .select("rumor_id")
      .eq("player_id", player.id)
      .eq("rumor_id", rumorId)
      .maybeSingle();
    if (already) return errorResponse("Already purchased", 409);

    if (rumor.cost > player.cash) return errorResponse("Insufficient funds", 402);

    await db.from("player_rumors").insert({ player_id: player.id, rumor_id: rumorId });
    await db.from("players").update({ cash: player.cash - rumor.cost }).eq("id", player.id);

    return jsonResponse({ ok: true, rumor });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
