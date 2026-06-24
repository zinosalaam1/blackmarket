import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, ensureAnonSession } from "./supabase";
import * as api from "./api";
import type {
  AuctionRow, ContractRow, EventRow, GameRow, InventoryRow, MarketItemRow, PlayerRow, RumorRow,
} from "./types";

/**
 * Single hook that owns the live connection to the Supabase backend:
 * - bootstraps an anonymous auth session
 * - loads/creates the shared lobby
 * - subscribes to Realtime changes for every table the game needs
 * - tracks live presence so "online" reflects who's actually connected
 * - drives the market simulation by calling market_tick() every ~2s
 * - exposes thin wrappers around every server-authoritative RPC
 */
export function useGameConnection() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [game, setGame] = useState<GameRow | null>(null);
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [marketItems, setMarketItems] = useState<MarketItemRow[]>([]);
  const [rumors, setRumors] = useState<RumorRow[]>([]);
  const [purchasedRumorIds, setPurchasedRumorIds] = useState<string[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [auction, setAuction] = useState<AuctionRow | null>(null);
  const [inventory, setInventory] = useState<InventoryRow[]>([]);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [myUserId, setMyUserId] = useState<string | null>(null);
  const [onlinePlayerIds, setOnlinePlayerIds] = useState<Set<string>>(new Set());

  const gameIdRef = useRef<string | null>(null);

  const rawMe = players.find((p) => p.user_id === myUserId) ?? null;

  // ── Bootstrap: anon auth + load/create lobby + initial reads ─────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await ensureAnonSession();
        if (cancelled) return;
        setMyUserId(session?.user.id ?? null);

        const g = await api.getOrCreateLobby();
        if (cancelled) return;
        gameIdRef.current = g.id;
        setGame(g);

        const [pl, mkt, rum, ev, au, ct] = await Promise.all([
          api.fetchPlayers(g.id),
          api.fetchMarketItems(g.id),
          api.fetchRumors(g.id),
          api.fetchEvents(g.id),
          api.fetchActiveAuction(g.id),
          api.fetchContracts(g.id),
        ]);
        if (cancelled) return;
        setPlayers(pl);
        setMarketItems(mkt);
        setRumors(rum);
        setEvents(ev);
        setAuction(au);
        setContracts(ct);
        setReady(true);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Once we know who "me" is, load my private rows (inventory, rumors) ──
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
  }, [rawMe?.id]);

  // ── Realtime subscriptions (public tables) ────────────────────────────────
  useEffect(() => {
    if (!ready || !gameIdRef.current) return;
    const gameId = gameIdRef.current;

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
  }, [ready]);

  // Inventory/rumor-purchases are private (RLS scoped to `me`), so subscribe
  // to them separately once we know our player id.
  useEffect(() => {
    if (!rawMe) return;
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

  // ── Presence: who's actually got a live connection right now. ────────────
  // Each browser tracks itself under a presence key equal to its own player
  // id; `presenceState()`'s keys are exactly the set of currently-connected
  // real players. NPCs (no user_id) can't have presence, so they keep
  // whatever static `online` flag the server gave them.
  useEffect(() => {
    if (!rawMe) return;
    const channel = supabase.channel(`presence:${rawMe.game_id}`, {
      config: { presence: { key: rawMe.id } },
    });
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      setOnlinePlayerIds(new Set(Object.keys(state)));
    });
    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await channel.track({ online_at: new Date().toISOString() });
      }
    });
    return () => { supabase.removeChannel(channel); };
  }, [rawMe?.id, rawMe?.game_id]);

  const players_ = useMemo(
    () => players.map((p) => ({ ...p, online: p.is_npc ? p.online : onlinePlayerIds.has(p.id) })),
    [players, onlinePlayerIds]
  );
  const me = players_.find((p) => p.user_id === myUserId) ?? null;

  // ── Drive the market simulation. Any open client nudges the tick forward;
  //    the DB-side advisory lock + elapsed-time check keeps it consistent
  //    even with many tabs open at once. ─────────────────────────────────────
  useEffect(() => {
    if (!ready || !gameIdRef.current || game?.status !== "playing") return;
    const id = gameIdRef.current;
    const t = setInterval(() => { api.marketTick(id).catch(() => {}); }, 2000);
    return () => clearInterval(t);
  }, [ready, game?.status]);

  // ── Actions ──────────────────────────────────────────────────────────────

  const join = useCallback(async (handle: string) => {
    const p = await api.joinGame(handle);
    setPlayers((prev) => (prev.some((x) => x.id === p.id) ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]));
    return p;
  }, []);

  const adminLogin = useCallback(async (code: string) => {
    const p = await api.adminLogin(code);
    setPlayers((prev) => (prev.some((x) => x.id === p.id) ? prev.map((x) => (x.id === p.id ? p : x)) : [...prev, p]));
    return p;
  }, []);

  const startGame = useCallback(async () => {
    if (!game) return;
    const g = await api.adminStartGame(game.id);
    setGame(g);
  }, [game?.id]);

  const resetGame = useCallback(async () => {
    if (!game) return;
    await api.adminResetGame(game.id);
    // Simplest correct way to pick up the new game_id everywhere (state,
    // realtime filters, etc.) is to just reload — the admin's player row
    // in the new lobby was already created server-side by admin_reset_game.
    window.location.reload();
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
    ready, error,
    game, players: players_, marketItems, rumors, purchasedRumorIds, events, auction, inventory, contracts, me,
    join, adminLogin, startGame, resetGame, addNpc, updatePlayerObjective, removePlayer,
    autoAssignObjectives, triggerEvent, buy, sell, buyRumor, bid,
    acceptContract, cancelContract, completeContract,
  };
}
