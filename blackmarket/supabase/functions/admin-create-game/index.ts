// supabase/functions/admin-create-game/index.ts
//
// Input:  { adminCode: string, handle: string }
// Output: { gameId, code, playerId }
//
// Validates a shared admin access code (set via the ADMIN_CODE function
// secret), creates a new game row, seeds market items / rumors / an
// auction, and registers the caller as the admin player for that game.

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, generateGameCode, getCallerUserId } from "../_shared/db.ts";
import { AUCTION_CATALOG, MARKET_CATALOG, RUMOR_CATALOG, initHistory } from "../_shared/catalog.ts";

const ADMIN_CODE = Deno.env.get("ADMIN_CODE") ?? "BLACKMARKET";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { adminCode, handle } = await req.json();
    if (!adminCode || String(adminCode).toUpperCase() !== ADMIN_CODE) {
      return errorResponse("Invalid access code", 401);
    }

    const cleanHandle = String(handle ?? "ADMIN").trim().toUpperCase().slice(0, 16) || "ADMIN";

    const userId = await getCallerUserId(req);
    const db = adminClient();

    const code = generateGameCode();

    const { data: game, error: gameErr } = await db
      .from("games")
      .insert({ code })
      .select()
      .single();
    if (gameErr) throw gameErr;

    const { data: player, error: playerErr } = await db
      .from("players")
      .insert({
        game_id: game.id,
        user_id: userId,
        handle: cleanHandle,
        is_admin: true,
        cash: game.starting_cash,
      })
      .select()
      .single();
    if (playerErr) throw playerErr;

    // Seed market
    const items = MARKET_CATALOG.map((m) => ({
      game_id: game.id,
      item_key: m.item_key,
      name: m.name,
      tier: m.tier,
      icon: m.icon,
      is_illegal: m.is_illegal,
      base_price: m.base_price,
      price: m.base_price,
      history: initHistory(m.base_price),
    }));
    const { error: itemsErr } = await db.from("market_items").insert(items);
    if (itemsErr) throw itemsErr;

    // Seed rumors
    const rumors = RUMOR_CATALOG.map((r) => ({ game_id: game.id, ...r }));
    const { error: rumorsErr } = await db.from("rumors").insert(rumors);
    if (rumorsErr) throw rumorsErr;

    // Seed first auction
    const pick = AUCTION_CATALOG[Math.floor(Math.random() * AUCTION_CATALOG.length)];
    const { error: auctionErr } = await db.from("auctions").insert({
      game_id: game.id,
      name: pick.name,
      icon: pick.icon,
      current_bid: 8500,
      bid_count: 0,
      ends_at: new Date(Date.now() + 90_000).toISOString(),
    });
    if (auctionErr) throw auctionErr;

    // Welcome event
    await db.from("events").insert({
      game_id: game.id,
      type: "neutral",
      text: "THE BLACK MARKET is now open. Waiting for players to join.",
    });

    return jsonResponse({ gameId: game.id, code: game.code, playerId: player.id });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
