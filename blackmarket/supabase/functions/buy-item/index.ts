// supabase/functions/buy-item/index.ts
//
// Input:  { gameId, itemKey, qty }
// Price is always read fresh from the DB — the client never gets to
// dictate the price it pays.

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerPlayer } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId, itemKey, qty } = await req.json();
    const quantity = Math.floor(Number(qty));
    if (!gameId || !itemKey || !Number.isFinite(quantity) || quantity <= 0) {
      return errorResponse("gameId, itemKey, and a positive qty are required");
    }

    const db = adminClient();
    const player = await getCallerPlayer(db, req, gameId);

    const { data: item, error: itemErr } = await db
      .from("market_items")
      .select("*")
      .eq("game_id", gameId)
      .eq("item_key", itemKey)
      .maybeSingle();
    if (itemErr) throw itemErr;
    if (!item) return errorResponse("Item not found", 404);

    const total = item.price * quantity;
    if (total > player.cash) return errorResponse("Insufficient funds", 402);

    const { data: existingInv } = await db
      .from("inventory")
      .select("*")
      .eq("player_id", player.id)
      .eq("item_key", itemKey)
      .maybeSingle();

    if (existingInv) {
      const newQty = existingInv.qty + quantity;
      const newAvg = Math.round((existingInv.avg_buy * existingInv.qty + item.price * quantity) / newQty);
      await db.from("inventory").update({ qty: newQty, avg_buy: newAvg }).eq("id", existingInv.id);
    } else {
      await db.from("inventory").insert({
        game_id: gameId,
        player_id: player.id,
        item_key: itemKey,
        qty: quantity,
        avg_buy: item.price,
      });
    }

    await db
      .from("players")
      .update({ cash: player.cash - total, trade_count: player.trade_count + 1, rep: Math.min(100, player.rep + 1) })
      .eq("id", player.id);

    return jsonResponse({ ok: true, spent: total, price: item.price });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
