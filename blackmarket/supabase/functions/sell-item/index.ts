// supabase/functions/sell-item/index.ts
//
// Input: { gameId, itemKey }
// Sells the player's entire stack of itemKey at the current live price.

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerPlayer } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId, itemKey } = await req.json();
    if (!gameId || !itemKey) return errorResponse("gameId and itemKey are required");

    const db = adminClient();
    const player = await getCallerPlayer(db, req, gameId);

    const { data: invItem, error: invErr } = await db
      .from("inventory")
      .select("*")
      .eq("player_id", player.id)
      .eq("item_key", itemKey)
      .maybeSingle();
    if (invErr) throw invErr;
    if (!invItem) return errorResponse("You don't own that item", 404);

    const { data: mktItem, error: mktErr } = await db
      .from("market_items")
      .select("price, name")
      .eq("game_id", gameId)
      .eq("item_key", itemKey)
      .maybeSingle();
    if (mktErr) throw mktErr;
    if (!mktItem) return errorResponse("Item not found in market", 404);

    const earned = mktItem.price * invItem.qty;

    await db.from("inventory").delete().eq("id", invItem.id);
    await db
      .from("players")
      .update({ cash: player.cash + earned, trade_count: player.trade_count + 1, rep: Math.min(100, player.rep + 2) })
      .eq("id", player.id);

    return jsonResponse({ ok: true, earned, qty: invItem.qty, name: mktItem.name });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
