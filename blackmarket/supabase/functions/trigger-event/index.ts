// supabase/functions/trigger-event/index.ts
//
// Input:  { gameId, type: 'crash'|'raid'|'leak'|'tax'|'blackout'|'neutral', text?: string }
// Admin only. Applies real server-side effects, then broadcasts the event.

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient, getCallerPlayer } from "../_shared/db.ts";

const DEFAULT_TEXT: Record<string, string> = {
  crash: "ADMIN EVENT — Market Crash triggered. All prices drop 50%.",
  raid: "ADMIN EVENT — Government Raid. Illegal items seized from random players.",
  blackout: "ADMIN EVENT — Blackout. All price data hidden for 60 seconds.",
  tax: "ADMIN EVENT — Tax Collection. Top players lose 15% of cash.",
  leak: "ADMIN EVENT — Information Leak. A player's inventory is now public.",
  neutral: "ADMIN EVENT — The Final Phase has begun. Market collapse imminent.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId, type, text } = await req.json();
    if (!gameId || !type) return errorResponse("gameId and type are required");
    if (!(type in DEFAULT_TEXT)) return errorResponse("Invalid event type");

    const db = adminClient();
    await getCallerPlayer(db, req, gameId, { requireAdmin: true });

    switch (type) {
      case "crash": {
        const { data: items } = await db.from("market_items").select("*").eq("game_id", gameId);
        for (const it of items ?? []) {
          if (Math.random() > 0.5) {
            const newPrice = Math.max(1, Math.round(it.price * 0.5));
            await db.from("market_items").update({
              price: newPrice,
              change: newPrice - it.price,
              change_percent: -50,
              trend: "down",
              history: [...(it.history ?? []).slice(-59), newPrice],
            }).eq("id", it.id);
          }
        }
        break;
      }
      case "raid": {
        const { data: invRows } = await db
          .from("inventory")
          .select("id, player_id, item_key, qty")
          .eq("game_id", gameId);
        const { data: illegalItems } = await db
          .from("market_items")
          .select("item_key")
          .eq("game_id", gameId)
          .eq("is_illegal", true);
        const illegalKeys = new Set((illegalItems ?? []).map((i) => i.item_key));
        const seizable = (invRows ?? []).filter((r) => illegalKeys.has(r.item_key));
        if (seizable.length > 0) {
          const victim = seizable[Math.floor(Math.random() * seizable.length)];
          await db.from("inventory").delete().eq("id", victim.id);
        }
        break;
      }
      case "tax": {
        const { data: players } = await db
          .from("players")
          .select("id, cash")
          .eq("game_id", gameId)
          .order("cash", { ascending: false })
          .limit(5);
        for (const p of players ?? []) {
          await db.from("players").update({ cash: Math.round(p.cash * 0.85) }).eq("id", p.id);
        }
        break;
      }
      case "blackout": {
        await db
          .from("games")
          .update({ blackout_until: new Date(Date.now() + 60_000).toISOString() })
          .eq("id", gameId);
        break;
      }
      case "leak":
      case "neutral":
        // No state mutation beyond the broadcast event itself.
        break;
    }

    const { data: event, error } = await db
      .from("events")
      .insert({ game_id: gameId, type, text: text || DEFAULT_TEXT[type] })
      .select()
      .single();
    if (error) throw error;

    return jsonResponse({ ok: true, event });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
