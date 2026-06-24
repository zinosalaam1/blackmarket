// supabase/functions/market-tick/index.ts
//
// Input: { gameId }
//
// This is the server's "clock". It has no privileged caller requirement —
// any connected player's client can invoke it — but it is debounced via
// games.last_tick_at so concurrent calls from 30 clients don't all apply
// drift simultaneously. The actual random-number generation happens here,
// server-side, so no client can predict or influence prices.
//
// Clients should call this roughly every 2 seconds while on the Game
// screen (see src/app/hooks/useGameTicker.ts). For production-grade
// reliability with zero connected clients, you can additionally schedule
// this function with Supabase Cron (pg_cron + pg_net) — see SETUP.md.

import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/db.ts";
import { AUCTION_CATALOG, LIVE_EVENTS_POOL } from "../_shared/catalog.ts";

const MIN_TICK_MS = 1800;
const EVENT_PROBABILITY_PER_TICK = 0.11; // ~ once every 16-18s on a 2s cadence

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { gameId } = await req.json();
    if (!gameId) return errorResponse("gameId is required");

    const db = adminClient();

    const { data: game, error: gameErr } = await db.from("games").select("*").eq("id", gameId).maybeSingle();
    if (gameErr) throw gameErr;
    if (!game) return errorResponse("Game not found", 404);
    if (game.status !== "playing") return jsonResponse({ ok: true, skipped: "not playing" });

    const lastTickMs = new Date(game.last_tick_at).getTime();
    if (Date.now() - lastTickMs < MIN_TICK_MS) {
      return jsonResponse({ ok: true, skipped: "debounced" });
    }

    // Debounce lock: only proceed if we win the conditional update.
    const { data: locked, error: lockErr } = await db
      .from("games")
      .update({ last_tick_at: new Date().toISOString() })
      .eq("id", gameId)
      .eq("last_tick_at", game.last_tick_at)
      .select()
      .maybeSingle();
    if (lockErr) throw lockErr;
    if (!locked) return jsonResponse({ ok: true, skipped: "lost debounce race" });

    const remainingMs = game.ends_at ? new Date(game.ends_at).getTime() - Date.now() : Infinity;
    let phase: "OPEN" | "FINAL PHASE" | "COLLAPSE" = "OPEN";
    if (remainingMs <= 60_000) phase = "COLLAPSE";
    else if (remainingMs <= 300_000) phase = "FINAL PHASE";

    const updates: Record<string, unknown> = {};
    if (phase !== game.phase) updates.phase = phase;
    if (game.ends_at && remainingMs <= 0) updates.status = "ended";
    if (Object.keys(updates).length > 0) {
      await db.from("games").update(updates).eq("id", gameId);
    }

    // ── price drift ──────────────────────────────────────────────────
    const { data: items } = await db.from("market_items").select("*").eq("game_id", gameId);
    for (const item of items ?? []) {
      const volatility = item.tier === "legendary" ? 0.06 : item.tier === "rare" ? 0.045 : 0.03;
      const drift = Math.random() * 2 - 1;
      const pct = drift * volatility * (phase === "COLLAPSE" ? 3 : 1);
      const newPrice = clamp(Math.round(item.price * (1 + pct)), Math.round(item.base_price * 0.2), Math.round(item.base_price * 5));
      const change = newPrice - item.price;
      const changePercent = item.price ? (change / item.price) * 100 : 0;
      await db.from("market_items").update({
        price: newPrice,
        change,
        change_percent: changePercent,
        trend: change > 0 ? "up" : change < 0 ? "down" : "stable",
        history: [...(item.history ?? []).slice(-59), newPrice],
        updated_at: new Date().toISOString(),
      }).eq("id", item.id);
    }

    // ── NPC random walk (keeps the leaderboard feeling alive) ────────
    const { data: npcs } = await db.from("players").select("id, cash, rep").eq("game_id", gameId).eq("is_npc", true);
    for (const npc of npcs ?? []) {
      const cashDelta = Math.round(npc.cash * (Math.random() * 0.06 - 0.03));
      const repDelta = Math.round(Math.random() * 4 - 2);
      await db.from("players").update({
        cash: Math.max(0, npc.cash + cashDelta),
        rep: clamp(npc.rep + repDelta, 0, 100),
      }).eq("id", npc.id);
    }

    // ── random world event ───────────────────────────────────────────
    if (Math.random() < EVENT_PROBABILITY_PER_TICK) {
      const ev = LIVE_EVENTS_POOL[Math.floor(Math.random() * LIVE_EVENTS_POOL.length)];
      await db.from("events").insert({ game_id: gameId, type: ev.type, text: ev.text });

      if (ev.type === "crash") {
        const { data: freshItems } = await db.from("market_items").select("*").eq("game_id", gameId);
        for (const it of freshItems ?? []) {
          if (Math.random() > 0.5) {
            const newPrice = Math.max(1, Math.round(it.price * 0.6));
            await db.from("market_items").update({
              price: newPrice,
              change: newPrice - it.price,
              change_percent: -40,
              trend: "down",
              history: [...(it.history ?? []).slice(-59), newPrice],
            }).eq("id", it.id);
          }
        }
      }
      if (ev.type === "blackout") {
        await db.from("games").update({ blackout_until: new Date(Date.now() + 8_000).toISOString() }).eq("id", gameId);
      }
      if (ev.type === "tax") {
        const { data: top } = await db.from("players").select("id, cash").eq("game_id", gameId).order("cash", { ascending: false }).limit(5);
        for (const p of top ?? []) {
          await db.from("players").update({ cash: Math.round(p.cash * 0.85) }).eq("id", p.id);
        }
      }
    }

    // ── auction lifecycle ────────────────────────────────────────────
    const { data: openAuction } = await db
      .from("auctions")
      .select("*")
      .eq("game_id", gameId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (openAuction && new Date(openAuction.ends_at).getTime() <= Date.now()) {
      await db.from("auctions").update({ status: "closed" }).eq("id", openAuction.id);

      if (openAuction.current_bidder_id) {
        const { data: winner } = await db.from("players").select("handle").eq("id", openAuction.current_bidder_id).maybeSingle();
        await db.from("events").insert({
          game_id: gameId,
          type: "neutral",
          text: `AUCTION CLOSED — ${winner?.handle ?? "a trader"} won "${openAuction.name}" for ${openAuction.current_bid.toLocaleString()}.`,
        });
      } else {
        await db.from("events").insert({
          game_id: gameId,
          type: "neutral",
          text: `AUCTION CLOSED — "${openAuction.name}" went unsold.`,
        });
      }

      const pick = AUCTION_CATALOG[Math.floor(Math.random() * AUCTION_CATALOG.length)];
      await db.from("auctions").insert({
        game_id: gameId,
        name: pick.name,
        icon: pick.icon,
        current_bid: 1500 + Math.floor(Math.random() * 8000),
        bid_count: 0,
        ends_at: new Date(Date.now() + 90_000).toISOString(),
      });
    }

    return jsonResponse({ ok: true, phase });
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "Unknown error", 400);
  }
});
