import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import * as api from "./api";
import type {
  AuctionRow, ContractRow, EventRow, GameRow, InventoryRow, MarketItemRow, PlayerRow, ProfileRow, RumorRow,
} from "./types";

const ROOM_CODE_KEY = "bm_room_code";

/**
 * Owns the live connection to the Supabase backend in three layers:
 *  1. Auth — a real Supabase session (email+password). No session => show
 *     the sign-up/log-in screen, full stop.
 *  2. Profile — your permanent handle, tied to your account. No profile
 *     row yet => show the "choose your handle" screen.
 *  3. Room — once authed with a profile, host a room or join one by code.
 *     The current room's code is remembered (URL ?room=CODE and
 *     localStorage) so reloading silently reattaches you.
 */
export function useGameConnection() {
  const [authReady, setAuthReady] = useState(false);
  const [session, setSession] = useState<{ userId: string } | null>(null);
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prefillCode, setPrefillCode] = useState<string | null>(null);

  const [game, setGame] = useState<GameRow | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [marketItems, setMarketItems] = useState<MarketItemRow[]>([]);
  const [rumors, setRumors] = useState<RumorRow[]>([]);
  const [purchasedRumorIds, setPurchasedRumorIds] = useState<string[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [auction, setAuction] = useState<AuctionRow | null>(null);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [onlinePlayerIds, setOnlinePlayerIds] = useState<Set<string>>(new Set());

  const gameIdRef = useRef<string | null>(null);

  const rawMe = players.find((p) => p.user_id === session?.userId) ?? null;

  const loadRoom = useCallback(async (gameId: string) => {
    gameIdRef.current = gameId;
    const [g, pl, mkt, rum, ev, au, ct] = await Promise.all([
      api.fetchGame(gameId),
      api.fetchPlayers(gameId),
      api.fetchMarketItems(gameId),
      api.fetchRumors(gameId),
      api.fetchEvents(gameId),
      api.fetchActiveAuction(gameId),
      api.fetchContracts(gameId),
    ]);
    setGame(g);
    setPlayers(pl);
    setMarketItems(mkt);
    setRumors(rum);
    setEvents(ev);
    setAuction(au);
    setContracts(ct);
  }, []);

  // ── 1) Auth bootstrap + keep session in sync ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session ? { userId: data.session.user.id } : null);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess ? { userId: sess.user.id } : null);
      if (!sess) {
        // Signed out — clear all room state.
        setProfile(null);
        setGame(null);
        setPlayers([]);
        gameIdRef.current = null;
        localStorage.removeItem(ROOM_CODE_KEY);
      }
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, []);

  // ── 2) Profile bootstrap, then try to silently reattach to a remembered
  //    room (URL ?room=CODE takes priority over localStorage). ─────────────
  useEffect(() => {
    if (!authReady || !session) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await api.fetchMyProfile();
        if (cancelled) return;
        setProfile(p);
        if (!p) return; // landing on the "choose a handle" screen next

        const urlCode = new URLSearchParams(window.location.search).get("room");
        const storedCode = localStorage.getItem(ROOM_CODE_KEY);
        const code = (urlCode || storedCode || "").toUpperCase().trim();
        if (!code) return;

        setPrefillCode(code);
        try {
          const player = await api.joinRoom(code); // silent reattach; needs an existing seat
          if (cancelled) return;
          localStorage.setItem(ROOM_CODE_KEY, code);
          await loadRoom(player.game_id);
        } catch {
          // Not in that room — fall through to the room gate.
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [authReady, session?.userId, loadRoom]);

  // ── Realtime subscriptions (scoped to the current room) ──────────────────
  useEffect(() => {
    const gameId = game?.id;
    if (!gameId) return;

    const channel = supabase
      .channel(`game:${gameId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "games", filter: `id=eq.${gameId}` },
        (payload) => setGame(payload.new as GameRow))
      .on("postgres_changes", { event: "*", schema: "public", table: "players", filter: `game_id=eq.${gameId}` },
        (payload) => {
          setPlayers((prev) => {
            if (payload.eventType === "DELETE") return prev.filter((p) => p.id !== (payload.old as PlayerRow).id);
            const row = payload.new as PlayerRow;
            const exists = prev.some((p) => p.id === row.id);
            return exists ? prev.map((p) => (p.id === row.id ? row : p)) : [...prev, row];
          });
        })
      .on("postgres_changes", { event: "*", schema: "public", table: "market_items", filter: `game_id=eq.${gameId}` },
        (payload) => {
          const row = payload.new as MarketItemRow;
          setMarketItems((prev) => prev.map((it) => (it.id === row.id ? row : it)));
        })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events", filter: `game_id=eq.${gameId}` },
        (payload) => setEvents((prev) => [payload.new as EventRow, ...prev].slice(0, 20)))
      .on("postgres_changes", { event: "*", schema: "public", table: "auctions", filter: `game_id=eq.${gameId}` },
        (payload) => {
          const row = payload.new as AuctionRow;
          setAuction((prev) => (row.settled && prev?.id === row.id ? prev : row));
        })
      .on("postgres_changes", { event: "*", schema: "public", table: "contracts", filter: `game_id=eq.${gameId}` },
        (payload) => {
          setContracts((prev) => {
            if (payload.eventType === "DELETE") return prev.filter((c) => c.id !== (payload.old as ContractRow).id);
            const row = payload.new as ContractRow;
            const exists = prev.some((c) => c.id === row.id);
            return exists ? prev.map((c) => (c.id === row.id ? row : c)) : [row, ...prev];
          });
        })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [game?.id]);

  // Inventory/rumor-purchases are private (RLS scoped to `me`).
  useEffect(() => {
    if (!rawMe) return;
    (async () => {
      const [inv, purchased] = await Promise.all([
        api.fetchInventory(rawMe.id),
        api.fetchPurchasedRumorIds(rawMe.id),
      ]);
      setInventory(inv);
      setPurchasedRumorIds(purchased);
    })();

    const channel = supabase
      .channel(`player:${rawMe.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "inventory", filter: `player_id=eq.${rawMe.id}` },
        (payload) => {
          setInventory((prev) => {
            if (payload.eventType === "DELETE") {
              const old = payload.old as InventoryRow;
              return prev.filter((i) => i.item_id !== old.item_id);
            }
            const row = payload.new as InventoryRow;
            const exists = prev.some((i) => i.item_id === row.item_id);
            return exists ? prev.map((i) => (i.item_id === row.item_id ? row : i)) : [...prev, row];
          });
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [rawMe?.id]);

  // ── Presence, scoped per room ──────────────────────────────────────────────
  useEffect(() => {
    if (!rawMe) return;
    const channel = supabase.channel(`presence:${rawMe.game_id}`, {
      config: { presence: { key: rawMe.id } },
    });
    channel.on("presence", { event: "sync" }, () => {
      setOnlinePlayerIds(new Set(Object.keys(channel.presenceState())));
    });
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") await channel.track({ online_at: new Date().toISOString() });
    });
    return () => { supabase.removeChannel(channel); };
  }, [rawMe?.id, rawMe?.game_id]);

  const players_ = useMemo(
    () => players.map((p) => ({ ...p, online: p.is_npc ? p.online : onlinePlayerIds.has(p.id) })),
    [players, onlinePlayerIds]
  );
  const me = players_.find((p) => p.user_id === session?.userId) ?? null;

  // ── Drive the market simulation for the current room. ─────────────────────
  useEffect(() => {
    if (game?.status !== "playing") return;
    const id = game.id;
    const t = setInterval(() => { api.marketTick(id).catch(() => {}); }, 2000);
    return () => clearInterval(t);
  }, [game?.id, game?.status]);

  // ── Auth actions ─────────────────────────────────────────────────────────

  const signUp = useCallback(async (email: string, password: string) => {
    const data = await api.signUp(email, password);
    if (data.session) setSession({ userId: data.session.user.id });
    return !!data.session; // false => email confirmation required before login works
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const data = await api.signIn(email, password);
    if (data.session) setSession({ userId: data.session.user.id });
  }, []);

  const signOut = useCallback(async () => {
    await api.signOut();
  }, []);

  const completeProfile = useCallback(async (handle: string) => {
    const p = await api.createProfile(handle);
    setProfile(p);
    return p;
  }, []);

  // ── Room actions ─────────────────────────────────────────────────────────

  const hostRoom = useCallback(async () => {
    const g = await api.createRoom();
    localStorage.setItem(ROOM_CODE_KEY, g.code);
    await loadRoom(g.id);
    return g;
  }, [loadRoom]);

  const enterRoom = useCallback(async (code: string) => {
    const p = await api.joinRoom(code);
    localStorage.setItem(ROOM_CODE_KEY, code.toUpperCase().trim());
    await loadRoom(p.game_id);
    return p;
  }, [loadRoom]);

  const leaveGame = useCallback(async () => {
    if (!game) return;
    try { await api.leaveGame(game.id); } finally {
      localStorage.removeItem(ROOM_CODE_KEY);
      window.location.href = window.location.pathname;
    }
  }, [game?.id]);

  const resetGame = useCallback(async () => {
    if (!game) return;
    const g = await api.adminResetGame(game.id);
    localStorage.setItem(ROOM_CODE_KEY, g.code);
    window.location.href = window.location.pathname;
  }, [game?.id]);

  // ── Admin / gameplay actions ──────────────────────────────────────────────

  const startGame = useCallback(async () => {
    if (!game) return;
    const g = await api.adminStartGame(game.id);
    setGame(g);
  }, [game?.id]);

  const addNpc = useCallback(async () => {
    if (!game) return;
    await api.adminAddNpc(game.id);
  }, [game?.id]);

  const updatePlayerObjective = useCallback(async (playerId: string, objectiveId: string) => {
    await api.adminUpdatePlayerObjective(playerId, objectiveId);
    setPlayers((prev) => prev.map((p) => (p.id === playerId ? { ...p, objective_id: objectiveId } : p)));
  }, []);

  const removePlayer = useCallback(async (playerId: string) => {
    await api.adminRemovePlayer(playerId);
    setPlayers((prev) => prev.filter((p) => p.id !== playerId));
  }, []);

  const autoAssignObjectives = useCallback(async () => {
    if (!game) return;
    await api.adminAutoAssignObjectives(game.id);
  }, [game?.id]);

  const triggerEvent = useCallback(async (type: string, text: string) => {
    if (!game) return;
    await api.adminTriggerEvent(game.id, type, text);
  }, [game?.id]);

  const buy = useCallback(async (itemId: string, qty: number) => {
    if (!game) throw new Error("No active game");
    const p = await api.buyItem(game.id, itemId, qty);
    setPlayers((prev) => prev.map((x) => (x.id === p.id ? p : x)));
    return p;
  }, [game?.id]);

  const sell = useCallback(async (itemId: string, qty?: number) => {
    if (!game) throw new Error("No active game");
    const p = await api.sellItem(game.id, itemId, qty);
    setPlayers((prev) => prev.map((x) => (x.id === p.id ? p : x)));
    return p;
  }, [game?.id]);

  const buyRumor = useCallback(async (rumorId: string) => {
    if (!game) throw new Error("No active game");
    const p = await api.buyRumor(game.id, rumorId);
    setPlayers((prev) => prev.map((x) => (x.id === p.id ? p : x)));
    setPurchasedRumorIds((prev) => [...prev, rumorId]);
    return p;
  }, [game?.id]);

  const bid = useCallback(async (amount: number) => {
    if (!auction) throw new Error("No active auction");
    const a = await api.placeBid(auction.id, amount);
    setAuction(a);
    return a;
  }, [auction?.id]);

  const acceptContract = useCallback(async (contractId: string) => {
    const c = await api.acceptContract(contractId);
    setContracts((prev) => prev.map((x) => (x.id === c.id ? c : x)));
    return c;
  }, []);

  const cancelContract = useCallback(async (contractId: string) => {
    await api.cancelContract(contractId);
    setContracts((prev) => prev.map((x) => (x.id === contractId ? { ...x, status: "open", accepted_by: null } : x)));
  }, []);

  const completeContract = useCallback(async (contractId: string) => {
    const p = await api.completeContract(contractId);
    setPlayers((prev) => prev.map((x) => (x.id === p.id ? p : x)));
    setContracts((prev) => prev.map((x) => (x.id === contractId ? { ...x, status: "completed" } : x)));
    return p;
  }, []);

  return {
    authReady, session, profile, error, prefillCode,
    game, players: players_, marketItems, rumors, purchasedRumorIds, events, auction, inventory, contracts, me,
    signUp, signIn, signOut, completeProfile,
    hostRoom, enterRoom, leaveGame, resetGame,
    startGame, addNpc, updatePlayerObjective, removePlayer,
    autoAssignObjectives, triggerEvent, buy, sell, buyRumor, bid,
    acceptContract, cancelContract, completeContract,
  };
}
