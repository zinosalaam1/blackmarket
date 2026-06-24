// supabase/functions/place-bid/index.ts
//
// Input: { gameId, auctionId, amount }

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerPlayer } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId, auctionId, amount } = await req.json();
    const bidAmount = Math.floor(Number(amount));
    if (!gameId || !auctionId || !Number.isFinite(bidAmount) || bidAmount <= 0) {
      return errorResponse("gameId, auctionId, and a positive amount are required");
    }

    const db = adminClient();
    const player = await getCallerPlayer(db, req, gameId);

    const { data: auction, error: aucErr } = await db
      .from("auctions")
      .select("*")
      .eq("id", auctionId)
      .eq("game_id", gameId)
      .maybeSingle();
    if (aucErr) throw aucErr;
    if (!auction) return errorResponse("Auction not found", 404);
    if (auction.status !== "open" || new Date(auction.ends_at).getTime() <= Date.now()) {
      return errorResponse("This auction has closed", 409);
    }
    if (bidAmount <= auction.current_bid) return errorResponse("Bid must exceed the current bid", 422);
    if (bidAmount > player.cash) return errorResponse("Insufficient funds", 402);

    await db
      .from("auctions")
      .update({ current_bid: bidAmount, current_bidder_id: player.id, bid_count: auction.bid_count + 1 })
      .eq("id", auctionId);

    await db.from("bids").insert({ auction_id: auctionId, player_id: player.id, amount: bidAmount });

    return jsonResponse({ ok: true, amount: bidAmount });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
