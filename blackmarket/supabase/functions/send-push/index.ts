/**
 * Supabase Edge Function: send-push
 *
 * Called by database webhooks when key game events fire.
 * Sends FCM push notifications to affected players' registered devices.
 *
 * Required Supabase secrets (set via `supabase secrets set`):
 *   FIREBASE_SERVER_KEY   — FCM server key (Firebase Console → Project Settings → Cloud Messaging)
 *   SUPABASE_SERVICE_ROLE_KEY — auto-available in edge functions
 *   SUPABASE_URL              — auto-available in edge functions
 *
 * Set up database webhooks in Supabase Dashboard → Database → Webhooks:
 *   1. games   UPDATE  → this function URL
 *   2. bounties INSERT → this function URL
 *   3. players UPDATE  → this function URL (watches frozen_until changes)
 *   4. loans   INSERT  → this function URL
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const FCM_URL = "https://fcm.googleapis.com/fcm/send";
const FCM_KEY = Deno.env.get("FIREBASE_SERVER_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

interface Notification { title: string; body: string; }

async function getTokensForUser(userId: string): Promise<string[]> {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data } = await sb
    .from("device_tokens")
    .select("token")
    .eq("user_id", userId);
  return (data ?? []).map((r: { token: string }) => r.token);
}

async function getTokensForGame(gameId: string, excludeUserId?: string): Promise<string[]> {
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { data: players } = await sb
    .from("players")
    .select("user_id")
    .eq("game_id", gameId)
    .not("user_id", "is", null);

  const userIds = (players ?? [])
    .map((p: { user_id: string }) => p.user_id)
    .filter((id: string) => id !== excludeUserId);

  if (userIds.length === 0) return [];

  const { data: tokens } = await sb
    .from("device_tokens")
    .select("token")
    .in("user_id", userIds);

  return (tokens ?? []).map((r: { token: string }) => r.token);
}

async function sendFCM(tokens: string[], notification: Notification) {
  if (!FCM_KEY || tokens.length === 0) return;
  await fetch(FCM_URL, {
    method: "POST",
    headers: {
      "Authorization": `key=${FCM_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      registration_ids: tokens,
      notification: {
        title: notification.title,
        body: notification.body,
        sound: "default",
      },
      android: { priority: "high" },
    }),
  });
}

serve(async (req) => {
  try {
    const payload = await req.json();
    const { table, type, record, old_record } = payload;

    let notification: Notification | null = null;
    let tokens: string[] = [];

    // ── Game status/phase changes ─────────────────────────────────────────
    if (table === "games" && type === "UPDATE") {
      const old = old_record ?? {};
      if (old.status === "lobby" && record.status === "playing") {
        notification = { title: "🏪 THE MARKET IS OPEN", body: "15 minutes. Trade hard. Trust no one." };
        tokens = await getTokensForGame(record.id);
      } else if (old.phase !== "COLLAPSE" && record.phase === "COLLAPSE") {
        notification = { title: "🔥 COLLAPSE PHASE", body: "Last 90 seconds! The market is imploding." };
        tokens = await getTokensForGame(record.id);
      } else if (old.phase !== "FINAL PHASE" && record.phase === "FINAL PHASE") {
        notification = { title: "⚠️ FINAL PHASE", body: "4 minutes left. Make your moves." };
        tokens = await getTokensForGame(record.id);
      } else if (old.status !== "ended" && record.status === "ended") {
        notification = { title: "🏆 GAME OVER", body: "The market has closed. Check the results." };
        tokens = await getTokensForGame(record.id);
      }
    }

    // ── Bounty placed ─────────────────────────────────────────────────────
    if (table === "bounties" && type === "INSERT") {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const { data: target } = await sb
        .from("players")
        .select("user_id")
        .eq("id", record.target_id)
        .single();
      if (target?.user_id) {
        notification = {
          title: "🎯 BOUNTY ON YOUR HEAD",
          body: `Someone placed a ₦${record.amount} bounty on your holdings.`,
        };
        tokens = await getTokensForUser(target.user_id);
      }
    }

    // ── Player frozen (assassination) ─────────────────────────────────────
    if (table === "players" && type === "UPDATE") {
      const wasNotFrozen = !old_record?.frozen_until;
      const isNowFrozen = record.frozen_until && record.user_id;
      if (wasNotFrozen && isNowFrozen) {
        notification = {
          title: "☠️ YOU'VE BEEN ASSASSINATED",
          body: "Your account is frozen for 90 seconds. You cannot trade.",
        };
        tokens = await getTokensForUser(record.user_id);
      }
    }

    // ── Loan taken ────────────────────────────────────────────────────────
    if (table === "loans" && type === "INSERT") {
      const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
      const { data: player } = await sb
        .from("players")
        .select("user_id")
        .eq("id", record.player_id)
        .single();
      if (player?.user_id) {
        const dueIn = Math.round((new Date(record.due_at).getTime() - Date.now()) / 1000);
        notification = {
          title: "💸 LOAN ACTIVE",
          body: `You owe ₦${record.total_owed} in ${dueIn} seconds. Don't default.`,
        };
        tokens = await getTokensForUser(player.user_id);
      }
    }

    if (notification && tokens.length > 0) {
      await sendFCM(tokens, notification);
    }

    return new Response(JSON.stringify({ sent: tokens.length }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
