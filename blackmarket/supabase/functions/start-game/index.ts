// supabase/functions/start-game/index.ts
//
// Input:  { gameId: string, durationMinutes?: number }
// Admin only. Assigns a random objective to any player without one, moves
// the game to "playing", and sets the end time.

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerPlayer } from "../_shared/db.ts";
import { ALL_OBJECTIVES } from "../_shared/catalog.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId, durationMinutes } = await req.json();
    if (!gameId) return errorResponse("gameId is required");

    const db = adminClient();
    await getCallerPlayer(db, req, gameId, { requireAdmin: true });

    const { data: players, error: playersErr } = await db
      .from("players")
      .select("id, objective_id, is_admin")
      .eq("game_id", gameId);
    if (playersErr) throw playersErr;

    const unassigned = (players ?? []).filter((p) => !p.is_admin && !p.objective_id);
    for (const p of unassigned) {
      const random = ALL_OBJECTIVES[Math.floor(Math.random() * ALL_OBJECTIVES.length)];
      await db.from("players").update({ objective_id: random.id }).eq("id", p.id);
    }

    const minutes = Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 90;
    const endsAt = new Date(Date.now() + minutes * 60_000).toISOString();

    const { error: gameErr } = await db
      .from("games")
      .update({ status: "playing", phase: "OPEN", started_at: new Date().toISOString(), ends_at: endsAt })
      .eq("id", gameId);
    if (gameErr) throw gameErr;

    await db.from("events").insert({
      game_id: gameId,
      type: "neutral",
      text: "THE BLACK MARKET has opened. Trading is live.",
    });

    return jsonResponse({ ok: true, endsAt });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
