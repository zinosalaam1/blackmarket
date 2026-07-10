import { useState, useEffect, useCallback, useRef } from "react";
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip,
} from "recharts";
import {
  TrendingUp, TrendingDown, Minus, AlertTriangle, Eye, EyeOff, Radio, Package,
  Users, FileText, ShoppingCart, Clock, ChevronUp, ChevronDown, Lock, Gavel,
  Settings, Play, UserPlus, Send, Trash2, RefreshCw, Crown, Loader2,
} from "lucide-react";
import { useGameConnection } from "../lib/useGameConnection";
import type { ContractRow, MarketItemRow, PlayerRow, PublicRoomRow, RumorRow } from "../lib/types";
import * as Sounds from "../lib/sounds";
import React from "react";

// ─── Error Boundary ─────────────────────────────────────────────────────────
// Catches render-time crashes anywhere below it and shows a readable error
// screen instead of a blank white/black screen (the previous failure mode
// on mobile WebViews, which have no visible dev console).

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("Render crash caught by ErrorBoundary:", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="size-full flex items-center justify-center bg-background p-6" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
          <div className="max-w-md text-center">
            <div className="text-4xl mb-3">⚠️</div>
            <div className="font-mono text-[13px] text-[#ff3333] mb-2 tracking-widest">SOMETHING WENT WRONG</div>
            <div className="font-mono text-[10px] text-[#5c6878] mb-4 break-words">{this.state.error.message}</div>
            <button
              onClick={() => { this.setState({ error: null }); window.location.href = window.location.pathname; }}
              className="px-4 py-2 border border-[#f0a500]/40 text-[#f0a500] font-mono text-[11px] tracking-widest hover:bg-[#f0a500]/10 transition-colors"
            >
              RELOAD
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── Static, purely-cosmetic catalog (icons + secret-objective flavor text).
// Gameplay-relevant numbers (price, tier, cash, etc.) always come from the
// server — this just maps stable ids to emoji/labels for display. ──────────

const ITEM_META: Record<string, { icon: string }> = {
  batteries:     { icon: "🔋" }, electronics:  { icon: "📱" }, gold:         { icon: "🥇" },
  fuel:          { icon: "⚗️"  }, medicine:     { icon: "💊" }, oil_drums:    { icon: "🛢️" },
  ancient_coins: { icon: "🪙" }, crypto_keys:  { icon: "🔑" }, lost_docs:    { icon: "📄" },
  data_drives:   { icon: "💾" }, rare_earth:    { icon: "🪨" }, bio_sample:   { icon: "🧬" },
  weapons_cache: { icon: "🔫" }, red_diamond:   { icon: "💎" }, gov_secrets:  { icon: "🗂️" },
  quantum_chip:  { icon: "⚡" }, prototype_ai:  { icon: "🤖" }, dark_matter:  { icon: "🌑" },
  stolen_art:    { icon: "🖼️" }, neural_implant:{ icon: "🧠" },
};

interface SecretObjective { id: string; role: string; goal: string; hint: string; color: string; icon: string; }

const ALL_OBJECTIVES: SecretObjective[] = [
  { id: "tycoon", role: "THE TYCOON", goal: "Finish with the highest net worth among all players.", hint: "Accumulate. Everything.", color: "#f0a500", icon: "💰" },
  { id: "collector", role: "THE COLLECTOR", goal: "Acquire 5 rare or legendary artifacts. Wealth doesn't matter.", hint: "It's about the collection, not the cash.", color: "#06b6d4", icon: "🏺" },
  { id: "broker", role: "THE BROKER", goal: "Complete the most trades — minimum 50 total.", hint: "Volume is your victory.", color: "#8b5cf6", icon: "🤝" },
  { id: "saboteur", role: "THE SABOTEUR", goal: "Trigger 3 market crashes before the final phase.", hint: "Burn it all down.", color: "#ef4444", icon: "💣" },
  { id: "smuggler", role: "THE SMUGGLER", goal: "Move 3 illegal items without getting caught or investigated.", hint: "Stay clean. Stay quiet.", color: "#f97316", icon: "🕵️" },
  { id: "informant", role: "THE INFORMANT", goal: "Discover the secret objectives of at least 5 other players.", hint: "Everyone has a price.", color: "#eab308", icon: "📡" },
  { id: "kingmaker", role: "THE KINGMAKER", goal: "Help a specific assigned player win. They don't know you exist.", hint: "Your victory is invisible.", color: "#ec4899", icon: "👑" },
  { id: "ghost", role: "THE GHOST", goal: "Never enter the top 10 wealthiest. Never get investigated.", hint: "Stay invisible. Win quietly.", color: "#a78bfa", icon: "👻" },
  { id: "chaos", role: "THE CHAOS AGENT", goal: "Create maximum instability. Spread rumors. Manipulate prices. Trigger panic.", hint: "There is no plan. There is only fire.", color: "#ff3333", icon: "🔥" },
];

const MANUAL_EVENTS: { label: string; type: string; text: string }[] = [
  { label: "Market Crash", type: "crash", text: "ADMIN EVENT — Market Crash triggered. Prices drop sharply." },
  { label: "Government Raid", type: "raid", text: "ADMIN EVENT — Government Raid. Illegal items under scrutiny." },
  { label: "Blackout", type: "blackout", text: "ADMIN EVENT — Blackout. All price data hidden for 60 seconds." },
  { label: "Tax Collection", type: "tax", text: "ADMIN EVENT — Tax Collection. Top players lose 15% of cash." },
  { label: "Information Leak", type: "leak", text: "ADMIN EVENT — Information Leak. A player's inventory is now public." },
  { label: "Final Phase", type: "neutral", text: "ADMIN EVENT — The Final Phase has begun. Market collapse imminent." },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `₦${(n / 1_000).toFixed(1)}K`;
  return `₦${Math.round(n).toLocaleString()}`;
}

// ─── Small shared components ────────────────────────────────────────────────

function TierBadge({ tier }: { tier: MarketItemRow["tier"] }) {
  const cfg = {
    common: { label: "COM", color: "text-[#5c6878] border-[#2a3444]" },
    rare: { label: "RARE", color: "text-[#06b6d4] border-[#06b6d4]/30" },
    legendary: { label: "LEG", color: "text-[#f0a500] border-[#f0a500]/40" },
  }[tier];
  return <span className={`font-mono text-[9px] font-bold border px-1 py-0 leading-tight ${cfg.color}`}>{cfg.label}</span>;
}

function RepBar({ value }: { value: number }) {
  const color = value >= 70 ? "#00e676" : value >= 40 ? "#f0a500" : "#ff3333";
  return (
    <div className="w-full h-1 bg-[#1a2434] rounded-none overflow-hidden">
      <div className="h-full transition-all duration-500" style={{ width: `${value}%`, background: color }} />
    </div>
  );
}

function PriceTicker({ change, changePercent }: { change: number; changePercent: number }) {
  if (change === 0)
    return <span className="font-mono text-[10px] text-[#5c6878] flex items-center gap-0.5"><Minus size={8} /> 0.0%</span>;
  const up = change > 0;
  return (
    <span className={`font-mono text-[10px] flex items-center gap-0.5 ${up ? "text-[#00e676]" : "text-[#ff3333]"}`}>
      {up ? <ChevronUp size={9} /> : <ChevronDown size={9} />}
      {up ? "+" : ""}{changePercent.toFixed(1)}%
    </span>
  );
}

const CustomTooltip = ({ active, payload }: { active?: boolean; payload?: { value: number }[] }) => {
  if (!active || !payload?.length) return null;
  return <div className="bg-[#0d1117] border border-[#f0a500]/30 px-2 py-1 font-mono text-[11px] text-[#f0a500]">{fmt(payload[0].value)}</div>;
};

function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="size-full flex flex-col items-center justify-center bg-background gap-3" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <Loader2 className="animate-spin text-[#f0a500]" size={28} />
      <span className="font-mono text-[11px] text-[#5c6878] tracking-widest">{label}</span>
    </div>
  );
}

// ─── Signup Screen ────────────────────────────────────────────────────────────

// ─── Signup Screen ────────────────────────────────────────────────────────────

function formatCode(code: string | null | undefined) {
  if (!code) return "------";
  return code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}

function CopyLink({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}${window.location.pathname}?room=${code}`;
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable — code is still shown for manual sharing */ }
  }
  return (
    <button onClick={copy} className="flex items-center gap-1.5 font-mono text-[9px] tracking-widest text-[#06b6d4] border border-[#06b6d4]/30 px-2.5 py-1.5 hover:bg-[#06b6d4]/10 transition-colors">
      {copied ? "✓ COPIED" : "COPY INVITE LINK"}
    </button>
  );
}

// ─── Game Over Screen ─────────────────────────────────────────────────────────

function GameOverScreen({
  players, me, onLeave, onNewGame, isAdmin,
}: {
  players: PlayerRow[];
  me: PlayerRow;
  onLeave: () => void;
  onNewGame: () => void;
  isAdmin: boolean;
}) {
  const sorted = [...players].filter((p) => !p.is_admin).sort(
    (a, b) => b.net_worth - a.net_worth || b.trade_count - a.trade_count
  );
  const top3 = sorted.slice(0, 3);
  const myRank = sorted.findIndex((p) => p.id === me.id) + 1;
  const medals = ["🥇", "🥈", "🥉"];
  const medalColors = ["#f0a500", "#9ca3af", "#b45309"];
  const obj = ALL_OBJECTIVES.find((o) => o.id === me.objective_id);

  // Play game-over fanfare once on mount
  useEffect(() => { Sounds.playGameOver(); }, []);

  return (
    <div className="size-full flex flex-col items-center justify-center bg-background relative overflow-hidden" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <div className="absolute inset-0 opacity-[0.04] pointer-events-none" style={{
        backgroundImage: "linear-gradient(#f0a500 1px, transparent 1px), linear-gradient(90deg, #f0a500 1px, transparent 1px)", backgroundSize: "40px 40px",
      }} />

      <div className="relative z-10 w-full max-w-lg px-6 overflow-y-auto max-h-screen py-6">
        <div className="text-center mb-8">
          <div className="font-mono text-[11px] tracking-[0.4em] text-[#5c6878] mb-2">SESSION CLOSED</div>
          <h1 className="text-[52px] font-black tracking-[-0.01em] leading-none text-[#f0a500]">GAME OVER</h1>
          <div className="font-mono text-[11px] text-[#5c6878] mt-2 tracking-widest">THE MARKET HAS COLLAPSED</div>
        </div>

        {/* Top 3 podium */}
        <div className="mb-4">
          <div className="font-mono text-[9px] tracking-[0.3em] text-[#5c6878] mb-3 text-center">FINAL STANDINGS</div>
          <div className="space-y-2">
            {top3.map((p, i) => {
              const isMe = p.id === me.id;
              const pObj = ALL_OBJECTIVES.find((o) => o.id === p.objective_id);
              return (
                <div key={p.id} className="flex items-center gap-3 px-4 py-3 border" style={{
                  borderColor: medalColors[i] + "40", background: medalColors[i] + "08",
                }}>
                  <span className="text-2xl shrink-0">{medals[i]}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[14px] font-black text-[#d8d0c4]">{p.handle}</span>
                      {isMe && <span className="font-mono text-[8px] border border-[#f0a500]/40 text-[#f0a500] px-1">YOU</span>}
                    </div>
                    {pObj && (
                      <div className="font-mono text-[9px] mt-0.5 flex items-center gap-1" style={{ color: pObj.color }}>
                        {pObj.icon} {pObj.role}
                        {p.objective_completed === true && <span className="text-[#00e676] ml-1">✓ COMPLETE</span>}
                        {p.objective_completed === false && <span className="text-[#ff3333] ml-1">✗ FAILED</span>}
                      </div>
                    )}
                    {p.objective_score && <div className="font-mono text-[8px] text-[#5c6878] mt-0.5">{p.objective_score}</div>}
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-[16px] font-black tabular-nums" style={{ color: medalColors[i] }}>{fmt(p.net_worth)}</div>
                    <div className="font-mono text-[9px] text-[#5c6878]">NET WORTH</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Your result if outside top 3 */}
        {myRank > 3 && !me.is_admin && (
          <div className="mb-4 px-4 py-3 border border-[#2a3444] bg-[#0d1117]">
            <div className="font-mono text-[9px] text-[#5c6878] tracking-widest mb-2">YOUR RESULT</div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <div className="font-mono text-[13px] font-bold text-[#d8d0c4]">#{myRank} — {me.handle}</div>
                {obj && (
                  <div className="font-mono text-[9px] mt-0.5 flex items-center gap-1" style={{ color: obj.color }}>
                    {obj.icon} {obj.role}
                    {me.objective_completed === true && <span className="text-[#00e676] ml-1">✓ COMPLETE</span>}
                    {me.objective_completed === false && <span className="text-[#ff3333] ml-1">✗ FAILED</span>}
                  </div>
                )}
                {me.objective_score && <div className="font-mono text-[8px] text-[#5c6878] mt-0.5">{me.objective_score}</div>}
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono text-[16px] font-black text-[#f0a500] tabular-nums">{fmt(me.net_worth)}</div>
                <div className="font-mono text-[9px] text-[#5c6878]">FINAL NET WORTH</div>
              </div>
            </div>
          </div>
        )}

        {/* Full leaderboard */}
        {sorted.length > 3 && (
          <div className="mb-4 border border-border max-h-36 overflow-y-auto">
            {sorted.slice(3).map((p, i) => (
              <div key={p.id} className="flex items-center px-3 py-2 border-b border-border last:border-0">
                <span className="font-mono text-[10px] text-[#5c6878] w-6">#{i + 4}</span>
                <span className="font-mono text-[11px] font-bold text-[#d8d0c4] flex-1">{p.handle}{p.id === me.id ? " (you)" : ""}</span>
                {p.objective_completed === true && <span className="text-[#00e676] text-[9px] mr-2">✓</span>}
                {p.objective_completed === false && <span className="text-[#ff3333] text-[9px] mr-2">✗</span>}
                <span className="font-mono text-[11px] tabular-nums text-[#f0a500]">{fmt(p.net_worth)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-3">
          {isAdmin && (
            <button onClick={onNewGame} className="w-full py-3.5 bg-[#00e676]/10 border border-[#00e676]/40 text-[#00e676] font-black text-[14px] tracking-[0.2em] hover:bg-[#00e676]/20 transition-colors" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
              HOST NEW GAME
            </button>
          )}
          <button onClick={onLeave} className="w-full py-3 border border-border text-[#5c6878] font-mono text-[11px] tracking-widest hover:text-[#d8d0c4] hover:border-[#5c6878] transition-colors">
            {isAdmin ? "LEAVE ROOM" : "JOIN ANOTHER ROOM"}
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── Onboarding (first-time only, localStorage gated) ────────────────────────

const ONBOARDING_KEY = "bm_onboarding_v1";

const ONBOARDING_STEPS = [
  {
    icon: "🏪", title: "WELCOME TO THE BLACK MARKET",
    body: "An underground trading simulation. You have 15 minutes, ₦10,000 starting cash, and a secret objective nobody else knows about. Buy low, sell high — or burn it all down.",
  },
  {
    icon: "📈", title: "TRADING",
    body: "20 market items across three tiers: common, rare, and legendary. Prices fluctuate every 2 seconds. Every buy costs a 3% fee. Selling at a loss hurts your reputation. Mistakes are expensive.",
  },
  {
    icon: "📡", title: "INTEL & CONTRACTS",
    body: "Buy rumors in the INTEL tab to get tips on upcoming price moves. Accept contracts in CONTRACTS to earn big payouts — but you need to physically hold the goods to fulfill them.",
  },
  {
    icon: "☠️", title: "COVERT OPS",
    body: "The OPS tab lets you go dark: place bounties on rivals, blind their price feed, pump & dump an item, take a loan at 50% interest, or spend ₦75,000 to freeze someone's account for 90 seconds.",
  },
  {
    icon: "🎭", title: "SECRET OBJECTIVES",
    body: "You'll be assigned a hidden role — Tycoon, Ghost, Saboteur, Kingmaker, and more. Each has a unique win condition revealed only at the end. Play your objective, or ignore it entirely. Nobody knows.",
  },
];

function OnboardingScreen({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const current = ONBOARDING_STEPS[step];
  const isLast = step === ONBOARDING_STEPS.length - 1;

  function finish() {
    localStorage.setItem(ONBOARDING_KEY, "1");
    onComplete();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <div className="w-full max-w-md bg-[#0d1117] border border-[#f0a500]/30 p-6">
        <div className="flex gap-1 mb-6">
          {ONBOARDING_STEPS.map((_, i) => (
            <div key={i} className="flex-1 h-0.5 rounded-full transition-colors" style={{ background: i <= step ? "#f0a500" : "#2a3444" }} />
          ))}
        </div>
        <div className="text-center mb-6">
          <div className="text-5xl mb-4">{current.icon}</div>
          <div className="font-mono text-[11px] tracking-[0.3em] text-[#f0a500] mb-2">{step + 1} OF {ONBOARDING_STEPS.length}</div>
          <div className="text-[22px] font-black text-[#d8d0c4] mb-3">{current.title}</div>
          <div className="font-mono text-[12px] text-[#5c6878] leading-relaxed">{current.body}</div>
        </div>
        <div className="flex gap-3">
          <button onClick={finish} className="flex-1 py-2 font-mono text-[10px] tracking-widest text-[#2a3444] hover:text-[#5c6878] transition-colors">SKIP</button>
          <button onClick={isLast ? finish : () => setStep(s => s + 1)}
            className="flex-1 py-2.5 bg-[#f0a500] text-black font-black text-[13px] tracking-[0.2em] hover:bg-[#f0b800] transition-colors">
            {isLast ? "LET'S PLAY" : "NEXT →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Check Email (after signup when confirmation required) ────────────────────

function CheckEmailScreen({ email, onResend, onBack }: {
  email: string; onResend: () => Promise<void>; onBack: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function resend() {
    setBusy(true);
    try { await onResend(); setSent(true); } finally { setBusy(false); }
  }

  return (
    <div className="size-full flex items-center justify-center bg-background" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <div className="max-w-sm px-6 text-center">
        <div className="text-5xl mb-4">📧</div>
        <div className="text-[28px] font-black text-[#d8d0c4] mb-2">CHECK YOUR EMAIL</div>
        <div className="font-mono text-[11px] text-[#5c6878] mb-6 leading-relaxed">
          We sent a confirmation link to <span className="text-[#f0a500]">{email}</span>. Open it to activate your account, then come back and log in.
        </div>
        {sent && <div className="font-mono text-[10px] text-[#00e676] mb-3">✓ Resent successfully</div>}
        <div className="flex flex-col gap-3">
          <button onClick={resend} disabled={busy || sent}
            className="w-full py-2.5 border border-[#f0a500]/40 text-[#f0a500] font-mono text-[11px] tracking-widest hover:bg-[#f0a500]/10 transition-colors disabled:opacity-40">
            {busy ? "SENDING..." : sent ? "EMAIL SENT ✓" : "RESEND EMAIL"}
          </button>
          <button onClick={onBack} className="font-mono text-[10px] text-[#2a3444] hover:text-[#5c6878] transition-colors">← BACK TO LOGIN</button>
        </div>
      </div>
    </div>
  );
}

// ─── Reset Password ────────────────────────────────────────────────────────────

function ResetPasswordScreen({ onReset }: { onReset: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setBusy(true);
    try { await onReset(password); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="size-full flex items-center justify-center bg-background" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <div className="w-full max-w-md px-6">
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🔐</div>
          <div className="text-[32px] font-black text-[#f0a500]">SET NEW PASSWORD</div>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] block mb-2">NEW PASSWORD</label>
            <input type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(""); }} required minLength={6} autoFocus
              className="w-full bg-[#0d1117] border border-border text-[#d8d0c4] font-mono text-[14px] px-4 py-3 focus:outline-none focus:border-[#f0a500]/60" />
          </div>
          <div>
            <label className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] block mb-2">CONFIRM PASSWORD</label>
            <input type="password" value={confirm} onChange={(e) => { setConfirm(e.target.value); setError(""); }} required
              className="w-full bg-[#0d1117] border border-border text-[#d8d0c4] font-mono text-[14px] px-4 py-3 focus:outline-none focus:border-[#f0a500]/60" />
            {error && <p className="font-mono text-[10px] text-[#ff3333] mt-1.5">{error}</p>}
          </div>
          <button type="submit" disabled={busy}
            className="w-full py-3.5 bg-[#f0a500] text-black font-black text-[14px] tracking-[0.2em] hover:bg-[#f0b800] transition-colors disabled:opacity-50">
            {busy ? "SAVING..." : "UPDATE PASSWORD"}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Room Browser (replaces RoomGate) ────────────────────────────────────────

function RoomBrowserScreen({
  prefillCode, publicRooms, onHost, onJoin, onSignOut, onRefreshRooms,
}: {
  prefillCode: string | null;
  publicRooms: import("../lib/types").PublicRoomRow[];
  onHost: (isPublic: boolean, name?: string) => Promise<void>;
  onJoin: (code: string) => Promise<void>;
  onSignOut: () => Promise<void>;
  onRefreshRooms: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"browse" | "join" | "host">(prefillCode ? "join" : "browse");
  const [code, setCode] = useState(prefillCode ?? "");
  const [isPublic, setIsPublic] = useState(false);
  const [roomName, setRoomName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { onRefreshRooms(); }, []);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await onJoin(code); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function handleHost(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await onHost(isPublic, roomName.trim() || undefined); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function handleJoinPublic(roomCode: string) {
    setBusy(true); setError("");
    try { await onJoin(roomCode); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const phaseColor = (p: string) => p === "COLLAPSE" ? "#ff3333" : p === "FINAL PHASE" ? "#f0a500" : "#00e676";

  return (
    <div className="size-full flex flex-col items-center justify-center bg-background relative overflow-hidden" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <div className="absolute inset-0 opacity-[0.04] pointer-events-none" style={{
        backgroundImage: "linear-gradient(#f0a500 1px, transparent 1px), linear-gradient(90deg, #f0a500 1px, transparent 1px)", backgroundSize: "40px 40px",
      }} />

      <div className="relative z-10 w-full max-w-md px-6">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-[#f0a500] animate-pulse" />
            <span className="font-mono text-[10px] tracking-[0.4em] text-[#5c6878]">TOUR ARCADE</span>
          </div>
          <h1 className="text-[48px] font-black leading-none text-[#f0a500]">THE BLACK MARKET</h1>
        </div>

        <div className="flex border border-border mb-6">
          {(["browse", "join", "host"] as const).map((m) => (
            <button key={m} onClick={() => { setMode(m); setError(""); }}
              className={`flex-1 py-2.5 font-mono text-[10px] tracking-widest transition-colors border-r border-border last:border-0 ${mode === m ? "bg-[#f0a500]/10 text-[#f0a500]" : "text-[#5c6878] hover:text-[#d8d0c4]"}`}>
              {m === "browse" ? "BROWSE" : m === "join" ? "JOIN CODE" : "HOST GAME"}
            </button>
          ))}
        </div>

        {mode === "browse" && (
          <div>
            <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-3 flex items-center justify-between">
              <span>PUBLIC ROOMS</span>
              <button onClick={onRefreshRooms} className="text-[#f0a500] hover:text-[#f0b800] transition-colors">↻ REFRESH</button>
            </div>
            {publicRooms.length === 0 ? (
              <div className="border border-dashed border-[#2a3444] p-6 text-center font-mono text-[11px] text-[#5c6878] mb-4">
                NO PUBLIC ROOMS OPEN — HOST ONE OR JOIN BY CODE
              </div>
            ) : (
              <div className="border border-border mb-4 max-h-64 overflow-y-auto">
                {publicRooms.map((room) => (
                  <div key={room.id} className="flex items-center gap-3 px-4 py-3 border-b border-border last:border-0 hover:bg-[#141b24] transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-[12px] font-bold text-[#d8d0c4]">{room.room_name || formatCode(room.code)}</div>
                      <div className="font-mono text-[9px] text-[#5c6878] flex items-center gap-2">
                        <span className="font-mono tracking-widest" style={{ color: phaseColor(room.phase) }}>{room.phase}</span>
                        <span>·</span>
                        <span>{room.player_count} players</span>
                        <span>·</span>
                        <span>{formatCode(room.code)}</span>
                      </div>
                    </div>
                    <button onClick={() => !busy && handleJoinPublic(room.code)} disabled={busy}
                      className="font-mono text-[10px] tracking-widest text-[#00e676] border border-[#00e676]/40 px-3 py-1.5 hover:bg-[#00e676]/10 transition-colors disabled:opacity-40">
                      JOIN
                    </button>
                  </div>
                ))}
              </div>
            )}
            {error && <p className="font-mono text-[10px] text-[#ff3333] mb-3">{error}</p>}
          </div>
        )}

        {mode === "join" && (
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] block mb-2">ROOM CODE</label>
              <input type="text" value={code} onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(""); }}
                placeholder="e.g. AB3-XY9" maxLength={7} autoFocus={!!prefillCode}
                className="w-full bg-[#0d1117] border border-border text-[#f0a500] font-mono text-[18px] px-4 py-3 focus:outline-none focus:border-[#f0a500]/60 placeholder-[#2a3444] tracking-[0.2em] text-center" />
              {error && <p className="font-mono text-[10px] text-[#ff3333] mt-1.5">{error}</p>}
            </div>
            <button type="submit" disabled={busy}
              className="w-full py-3.5 bg-[#f0a500] text-black font-black text-[14px] tracking-[0.2em] hover:bg-[#f0b800] transition-colors disabled:opacity-50">
              {busy ? "CONNECTING..." : "ENTER THE MARKET"}
            </button>
          </form>
        )}

        {mode === "host" && (
          <form onSubmit={handleHost} className="space-y-4">
            <div>
              <label className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] block mb-2">ROOM NAME (OPTIONAL)</label>
              <input type="text" value={roomName} onChange={(e) => setRoomName(e.target.value)}
                placeholder="e.g. Friday Night Session" maxLength={30}
                className="w-full bg-[#0d1117] border border-border text-[#d8d0c4] font-mono text-[13px] px-4 py-3 focus:outline-none focus:border-[#f0a500]/60 placeholder-[#2a3444]" />
            </div>
            <div className="flex items-center gap-3 px-4 py-3 border border-border bg-[#0d1117] cursor-pointer" onClick={() => setIsPublic(!isPublic)}>
              <div className={`w-4 h-4 border flex items-center justify-center transition-colors ${isPublic ? "border-[#f0a500] bg-[#f0a500]" : "border-border"}`}>
                {isPublic && <div className="w-2 h-2 bg-black" />}
              </div>
              <div>
                <div className="font-mono text-[11px] text-[#d8d0c4]">LIST IN PUBLIC ROOM BROWSER</div>
                <div className="font-mono text-[9px] text-[#5c6878]">Anyone can find and join this room without a code</div>
              </div>
            </div>
            {error && <p className="font-mono text-[10px] text-[#ff3333]">{error}</p>}
            <button type="submit" disabled={busy}
              className="w-full py-3.5 bg-[#ff3333]/10 border border-[#ff3333]/40 text-[#ff3333] font-black text-[13px] tracking-[0.2em] hover:bg-[#ff3333]/20 transition-colors disabled:opacity-50">
              {busy ? "OPENING ROOM..." : "HOST A NEW GAME"}
            </button>
          </form>
        )}

        <div className="text-center mt-6">
          <button onClick={onSignOut} className="font-mono text-[9px] tracking-widest text-[#2a3444] hover:text-[#5c6878] transition-colors">SIGN OUT</button>
        </div>
      </div>
    </div>
  );
}

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="size-full flex flex-col items-center justify-center bg-background relative overflow-hidden" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <div className="absolute inset-0 opacity-[0.04] pointer-events-none" style={{
        backgroundImage: "linear-gradient(#f0a500 1px, transparent 1px), linear-gradient(90deg, #f0a500 1px, transparent 1px)", backgroundSize: "40px 40px",
      }} />
      <div className="absolute inset-0 pointer-events-none" style={{ background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.04) 2px, rgba(0,0,0,0.04) 4px)" }} />
      <div className="relative z-10 w-full max-w-md px-6">
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-[#f0a500] animate-pulse" />
            <span className="font-mono text-[10px] tracking-[0.4em] text-[#5c6878]">TOUR ARCADE</span>
          </div>
          <h1 className="text-[48px] font-black tracking-[-0.01em] leading-none text-[#f0a500]" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>THE BLACK MARKET</h1>
          <p className="font-mono text-[11px] text-[#5c6878] mt-2 tracking-widest">UNDERGROUND TRADING · HIDDEN AGENDAS · NOBODY CAN BE TRUSTED</p>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Auth: sign up / log in ─────────────────────────────────────────────────────

function AuthScreen({
  onSignUp, onSignIn, onForgotPassword, pendingEmail, onResendConfirmation,
}: {
  onSignUp: (email: string, password: string) => Promise<boolean>;
  onSignIn: (email: string, password: string) => Promise<void>;
  onForgotPassword: (email: string) => Promise<void>;
  pendingEmail: string | null;
  onResendConfirmation: (email: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<"signup" | "login" | "forgot">(pendingEmail ? "login" : "signup");
  const [email, setEmail] = useState(pendingEmail ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [checkEmail, setCheckEmail] = useState(!!pendingEmail);
  const [pendingConfirmEmail, setPendingConfirmEmail] = useState(pendingEmail ?? "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      if (mode === "signup") {
        const loggedIn = await onSignUp(email, password);
        if (!loggedIn) {
          localStorage.setItem("bm_pending_confirm", email);
          setPendingConfirmEmail(email);
          setCheckEmail(true);
        }
      } else {
        await onSignIn(email, password);
        localStorage.removeItem("bm_pending_confirm");
      }
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await onForgotPassword(email); setForgotSent(true); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (checkEmail) {
    return (
      <CheckEmailScreen
        email={pendingConfirmEmail}
        onResend={() => onResendConfirmation(pendingConfirmEmail)}
        onBack={() => { setCheckEmail(false); setMode("login"); localStorage.removeItem("bm_pending_confirm"); }}
      />
    );
  }

  return (
    <AuthShell>
      {mode !== "forgot" && (
        <div className="flex border border-border mb-6">
          <button onClick={() => { setMode("signup"); setError(""); }} className={`flex-1 py-2.5 font-mono text-[10px] tracking-widest transition-colors border-r border-border ${mode === "signup" ? "bg-[#f0a500]/10 text-[#f0a500] border-[#f0a500]/20" : "text-[#5c6878] hover:text-[#d8d0c4]"}`}>
            <UserPlus size={10} className="inline mr-1.5" />SIGN UP
          </button>
          <button onClick={() => { setMode("login"); setError(""); }} className={`flex-1 py-2.5 font-mono text-[10px] tracking-widest transition-colors ${mode === "login" ? "bg-[#06b6d4]/10 text-[#06b6d4]" : "text-[#5c6878] hover:text-[#d8d0c4]"}`}>
            <Settings size={10} className="inline mr-1.5" />LOG IN
          </button>
        </div>
      )}

      {mode === "forgot" ? (
        <form onSubmit={handleForgot} className="space-y-4">
          <div className="text-center mb-2">
            <div className="font-mono text-[11px] tracking-[0.3em] text-[#f0a500] mb-1">FORGOT PASSWORD</div>
            <div className="font-mono text-[10px] text-[#5c6878]">Enter your email and we'll send a reset link.</div>
          </div>
          <div>
            <label className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] block mb-2">EMAIL</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus
              className="w-full bg-[#0d1117] border border-border text-[#d8d0c4] font-mono text-[14px] px-4 py-3 focus:outline-none focus:border-[#f0a500]/60" />
            {error && <p className="font-mono text-[10px] text-[#ff3333] mt-1.5">{error}</p>}
            {forgotSent && <p className="font-mono text-[10px] text-[#00e676] mt-1.5">✓ Reset email sent — check your inbox</p>}
          </div>
          <button type="submit" disabled={busy || forgotSent}
            className="w-full py-3.5 bg-[#f0a500] text-black font-black text-[14px] tracking-[0.2em] hover:bg-[#f0b800] transition-colors disabled:opacity-50">
            {busy ? "SENDING..." : forgotSent ? "EMAIL SENT ✓" : "SEND RESET EMAIL"}
          </button>
          <button type="button" onClick={() => { setMode("login"); setError(""); setForgotSent(false); }}
            className="w-full font-mono text-[10px] text-[#2a3444] hover:text-[#5c6878] transition-colors">
            ← BACK TO LOGIN
          </button>
        </form>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] block mb-2">EMAIL</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus
              className="w-full bg-[#0d1117] border border-border text-[#d8d0c4] font-mono text-[14px] px-4 py-3 focus:outline-none focus:border-[#f0a500]/60" />
          </div>
          <div>
            <label className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] block mb-2">PASSWORD</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6}
              className="w-full bg-[#0d1117] border border-border text-[#d8d0c4] font-mono text-[14px] px-4 py-3 focus:outline-none focus:border-[#f0a500]/60" />
            {error && <p className="font-mono text-[10px] text-[#ff3333] mt-1.5">{error}</p>}
          </div>
          <button type="submit" disabled={busy}
            className="w-full py-3.5 bg-[#f0a500] text-black font-black text-[14px] tracking-[0.2em] hover:bg-[#f0b800] transition-colors disabled:opacity-50" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            {busy ? "..." : mode === "signup" ? "CREATE ACCOUNT" : "LOG IN"}
          </button>
          {mode === "login" && (
            <button type="button" onClick={() => { setMode("forgot"); setError(""); }}
              className="w-full font-mono text-[10px] text-[#2a3444] hover:text-[#5c6878] transition-colors">
              FORGOT PASSWORD?
            </button>
          )}
        </form>
      )}
    </AuthShell>
  );
}

// ─── Profile setup: choose your permanent handle ────────────────────────────────

function ProfileSetupScreen({ onComplete }: { onComplete: (handle: string) => Promise<void> }) {
  const [handle, setHandle] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await onComplete(handle); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] block mb-2">CHOOSE YOUR HANDLE</label>
          <input type="text" value={handle} onChange={(e) => { setHandle(e.target.value); setError(""); }}
            placeholder="e.g. SHADOW_DEALER" maxLength={16} autoFocus
            className="w-full bg-[#0d1117] border border-border text-[#d8d0c4] font-mono text-[14px] px-4 py-3 focus:outline-none focus:border-[#f0a500]/60 placeholder-[#2a3444] tracking-wider" />
          {error && <p className="font-mono text-[10px] text-[#ff3333] mt-1.5">{error}</p>}
        </div>
        <p className="font-mono text-[9px] text-[#2a3444] text-center tracking-widest">THIS IS YOUR PERMANENT HANDLE ACROSS EVERY ROOM</p>
        <button type="submit" disabled={busy} className="w-full py-3.5 bg-[#f0a500] text-black font-black text-[14px] tracking-[0.2em] hover:bg-[#f0b800] transition-colors disabled:opacity-50" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
          {busy ? "SAVING..." : "CONTINUE"}
        </button>
      </form>
    </AuthShell>
  );
}

// ─── Lobby Screen ─────────────────────────────────────────────────────────────

function LobbyScreen({ code, handle, players, onLeave, onSignOut }: { code: string; handle: string; players: PlayerRow[]; onLeave: () => void; onSignOut: () => Promise<void> }) {
  const [dots, setDots] = useState(".");
  useEffect(() => { const t = setInterval(() => setDots((d) => (d.length >= 3 ? "." : d + ".")), 600); return () => clearInterval(t); }, []);

  return (
    <div className="size-full flex flex-col items-center justify-center bg-background" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <div className="w-full max-w-lg px-6">
        <div className="text-center mb-6">
          <div className="font-mono text-[10px] tracking-[0.4em] text-[#5c6878] mb-1">ROOM CODE</div>
          <div className="text-[40px] font-black tracking-[0.1em] text-[#f0a500] leading-none">{formatCode(code)}</div>
          <div className="flex justify-center mt-2"><CopyLink code={code} /></div>
        </div>

        <div className="text-center mb-8">
          <div className="font-mono text-[10px] tracking-[0.4em] text-[#f0a500] mb-1">CONNECTED AS</div>
          <div className="text-[36px] font-black tracking-wider text-[#d8d0c4]">{handle}</div>
          <div className="flex items-center justify-center gap-2 mt-3">
            <div className="w-2 h-2 rounded-full bg-[#f0a500] animate-pulse" />
            <span className="font-mono text-[11px] text-[#5c6878] tracking-widest">WAITING FOR HOST TO START{dots}</span>
          </div>
        </div>

        <div className="border border-border bg-[#0d1117]">
          <div className="px-4 py-2.5 border-b border-border">
            <span className="font-mono text-[9px] tracking-[0.3em] text-[#5c6878]">OPERATORS IN LOBBY — {players.length} CONNECTED</span>
          </div>
          <div className="divide-y divide-border max-h-64 overflow-y-auto">
            {players.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${p.online ? "bg-[#00e676] animate-pulse" : "bg-[#2a3444]"}`} />
                  <span className="font-mono text-[12px] font-bold text-[#d8d0c4]">{p.handle}</span>
                  {p.is_admin && <span className="font-mono text-[8px] border border-[#ff3333]/40 text-[#ff3333] px-1">HOST</span>}
                  {p.handle === handle && <span className="font-mono text-[8px] border border-[#f0a500]/40 text-[#f0a500] px-1">YOU</span>}
                </div>
                <span className="font-mono text-[9px] text-[#2a3444]">
                  {p.objective_id ? <span className="text-[#00e676]">OBJECTIVE ASSIGNED</span> : "PENDING"}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 text-center">
          <p className="font-mono text-[10px] text-[#2a3444] tracking-widest mb-3">YOUR SECRET OBJECTIVE WILL BE REVEALED WHEN THE GAME STARTS</p>
          <div className="flex items-center justify-center gap-3">
            <button onClick={onLeave} className="font-mono text-[10px] tracking-widest text-[#5c6878] border border-[#2a3444] px-4 py-2 hover:text-[#d8d0c4] hover:border-[#5c6878] transition-colors">LEAVE ROOM</button>
            <button onClick={onSignOut} className="font-mono text-[10px] tracking-widest text-[#2a3444] hover:text-[#ff3333] transition-colors">SIGN OUT</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Admin Panel ──────────────────────────────────────────────────────────────

type AdminTab = "ROSTER" | "OBJECTIVES" | "EVENTS" | "OVERVIEW";

function AdminPanel({
  code, registeredPlayers, onUpdatePlayerObjective, onRemovePlayer, onStartGame, onResetGame, onLeave, onSignOut, onTriggerEvent, onAddNpc, onAutoAssign, gameStatus,
}: {
  code: string;
  registeredPlayers: PlayerRow[];
  onUpdatePlayerObjective: (id: string, objectiveId: string) => void;
  onRemovePlayer: (id: string) => void;
  onStartGame: () => void;
  onResetGame: () => void;
  onLeave: () => void;
  onSignOut: () => Promise<void>;
  onTriggerEvent: (type: string, text: string) => void;
  onAddNpc: () => void;
  onAutoAssign: () => void;
  gameStatus: string;
}) {
  const [adminTab, setAdminTab] = useState<AdminTab>("ROSTER");
  const [autoAssigning, setAutoAssigning] = useState(false);

  function autoAssignObjectives() {
    setAutoAssigning(true);
    onAutoAssign();
    setTimeout(() => setAutoAssigning(false), 800);
  }

  const assignedCount = registeredPlayers.filter((p) => p.objective_id).length;
  const nonAdminCount = registeredPlayers.filter((p) => !p.is_admin).length;

  return (
    <div className="size-full flex flex-col bg-background overflow-hidden" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
      <header className="flex items-center gap-4 px-5 py-3 bg-[#0d1117] border-b border-[#ff3333]/30">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#ff3333] animate-pulse" />
          <span className="font-bold text-[14px] tracking-[0.2em] text-[#ff3333]">ADMIN PANEL</span>
        </div>
        <div className="flex items-center gap-1.5 border border-[#f0a500]/30 px-2 py-1">
          <span className="font-mono text-[9px] text-[#5c6878]">ROOM</span>
          <span className="font-mono text-[13px] font-bold text-[#f0a500] tracking-[0.15em]">{formatCode(code)}</span>
        </div>
        <CopyLink code={code} />
        <div className="flex-1" />
        <div className="flex items-center gap-2 font-mono text-[10px] text-[#5c6878]">
          <span>{registeredPlayers.length} PLAYERS</span><span className="text-[#2a3444]">·</span>
          <span className={assignedCount === nonAdminCount && nonAdminCount > 0 ? "text-[#00e676]" : "text-[#f0a500]"}>{assignedCount}/{nonAdminCount} OBJECTIVES ASSIGNED</span>
        </div>
        {gameStatus === "lobby" ? (
          <button onClick={onStartGame} disabled={nonAdminCount === 0}
            className="flex items-center gap-2 px-4 py-2 bg-[#00e676]/10 border border-[#00e676]/40 text-[#00e676] font-mono text-[11px] tracking-widest hover:bg-[#00e676]/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">
            <Play size={10} />START GAME
          </button>
        ) : (
          <button onClick={() => { if (window.confirm("End the current game and open a fresh lobby for a new round?")) onResetGame(); }}
            className="flex items-center gap-2 px-4 py-2 bg-[#f0a500]/10 border border-[#f0a500]/40 text-[#f0a500] font-mono text-[11px] tracking-widest hover:bg-[#f0a500]/20 transition-colors">
            <RefreshCw size={10} />NEW GAME
          </button>
        )}
        <button onClick={onLeave} className="px-3 py-2 border-l border-border font-mono text-[9px] text-[#5c6878] hover:text-[#d8d0c4] transition-colors tracking-widest">LEAVE</button>
        <button onClick={onSignOut} className="px-3 py-2 border-l border-border font-mono text-[9px] text-[#5c6878] hover:text-[#ff3333] transition-colors tracking-widest">SIGN OUT</button>
      </header>

      <div className="flex border-b border-border bg-[#0d1117]">
        {(["ROSTER", "OBJECTIVES", "EVENTS", "OVERVIEW"] as AdminTab[]).map((t) => (
          <button key={t} onClick={() => setAdminTab(t)} className={`px-5 py-2.5 font-mono text-[10px] tracking-widest border-r border-border transition-colors ${adminTab === t ? "text-[#ff3333] border-b-2 border-b-[#ff3333] bg-[#ff3333]/5" : "text-[#5c6878] hover:text-[#d8d0c4] border-b-2 border-b-transparent"}`}>{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-5">
        {adminTab === "ROSTER" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em]">REGISTERED PLAYERS</div>
              <button onClick={onAddNpc} className="flex items-center gap-1.5 font-mono text-[9px] tracking-widest text-[#06b6d4] border border-[#06b6d4]/30 px-3 py-1.5 hover:bg-[#06b6d4]/10 transition-colors">+ ADD TEST PLAYER</button>
            </div>
            {registeredPlayers.length === 0 ? (
              <div className="border border-dashed border-[#2a3444] p-8 text-center font-mono text-[11px] text-[#5c6878]">NO PLAYERS YET — SHARE THE SIGNUP LINK</div>
            ) : (
              <div className="border border-border overflow-hidden">
                <div className="grid grid-cols-5 bg-[#0d1117] border-b border-border px-4 py-2">
                  {["HANDLE", "ROLE", "OBJECTIVE", "JOINED", ""].map((h) => <div key={h} className="font-mono text-[9px] text-[#5c6878] tracking-widest">{h}</div>)}
                </div>
                {registeredPlayers.map((p) => {
                  const obj = ALL_OBJECTIVES.find((o) => o.id === p.objective_id);
                  return (
                    <div key={p.id} className="grid grid-cols-5 items-center px-4 py-3 border-b border-border hover:bg-[#141b24] transition-colors">
                      <div className="flex items-center gap-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${p.online ? "bg-[#00e676] animate-pulse" : "bg-[#2a3444]"}`} />
                        <span className="font-mono text-[11px] font-bold text-[#d8d0c4]">{p.handle}</span>
                      </div>
                      <div>{p.is_admin ? <span className="font-mono text-[9px] border border-[#ff3333]/40 text-[#ff3333] px-1.5 py-0.5">ADMIN</span> : <span className="font-mono text-[9px] border border-[#2a3444] text-[#5c6878] px-1.5 py-0.5">PLAYER</span>}</div>
                      <div>{obj ? <span className="font-mono text-[9px] font-bold" style={{ color: obj.color }}>{obj.icon} {obj.role}</span> : <span className="font-mono text-[9px] text-[#2a3444]">NOT ASSIGNED</span>}</div>
                      <div className="font-mono text-[9px] text-[#5c6878]">{new Date(p.joined_at).toLocaleTimeString()}</div>
                      <div className="flex gap-1 justify-end">
                        <button onClick={() => onRemovePlayer(p.id)} className="p-1.5 text-[#5c6878] hover:text-[#ff3333] transition-colors"><Trash2 size={12} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {adminTab === "OBJECTIVES" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em]">ASSIGN SECRET OBJECTIVES</div>
              <button onClick={autoAssignObjectives} disabled={autoAssigning || nonAdminCount === 0}
                className="flex items-center gap-1.5 font-mono text-[9px] tracking-widest text-[#f0a500] border border-[#f0a500]/40 px-3 py-1.5 hover:bg-[#f0a500]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                <RefreshCw size={9} className={autoAssigning ? "animate-spin" : ""} />AUTO-ASSIGN ALL
              </button>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-6">
              {ALL_OBJECTIVES.map((obj) => {
                const assigned = registeredPlayers.filter((p) => p.objective_id === obj.id);
                return (
                  <div key={obj.id} className="border border-border p-3 bg-[#0d1117]" style={{ borderColor: obj.color + "20" }}>
                    <div className="flex items-center gap-2 mb-1.5"><span className="text-lg">{obj.icon}</span><span className="font-mono text-[11px] font-bold" style={{ color: obj.color }}>{obj.role}</span></div>
                    <p className="font-mono text-[10px] text-[#5c6878] leading-relaxed mb-2">{obj.goal}</p>
                    <div className="font-mono text-[9px] text-[#2a3444]">{assigned.length > 0 ? <span style={{ color: obj.color }}>Assigned to: {assigned.map((p) => p.handle).join(", ")}</span> : "Not assigned"}</div>
                  </div>
                );
              })}
            </div>
            <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-3">MANUAL ASSIGNMENT — PER PLAYER</div>
            <div className="space-y-2">
              {registeredPlayers.filter((p) => !p.is_admin).map((p) => {
                const obj = ALL_OBJECTIVES.find((o) => o.id === p.objective_id);
                return (
                  <div key={p.id} className="flex items-center gap-3 border border-border px-4 py-3 bg-[#0d1117]">
                    <div className="w-32 font-mono text-[11px] font-bold text-[#d8d0c4] shrink-0">{p.handle}</div>
                    <select value={p.objective_id ?? ""} onChange={(e) => e.target.value && onUpdatePlayerObjective(p.id, e.target.value)}
                      className="flex-1 bg-[#141b24] border border-border text-[#d8d0c4] font-mono text-[10px] px-2 py-1.5 focus:outline-none focus:border-[#f0a500]/60" style={{ color: obj?.color ?? "#5c6878" }}>
                      <option value="" className="text-[#5c6878] bg-[#141b24]">— SELECT OBJECTIVE —</option>
                      {ALL_OBJECTIVES.map((o) => <option key={o.id} value={o.id} className="bg-[#141b24] text-[#d8d0c4]">{o.icon} {o.role}</option>)}
                    </select>
                    {obj && <div className="font-mono text-[9px] shrink-0" style={{ color: obj.color }}>{obj.hint}</div>}
                  </div>
                );
              })}
              {nonAdminCount === 0 && <div className="border border-dashed border-[#2a3444] p-6 text-center font-mono text-[11px] text-[#5c6878]">NO PLAYERS REGISTERED YET</div>}
            </div>
          </div>
        )}

        {adminTab === "EVENTS" && (
          <div>
            <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-4">TRIGGER GAME EVENTS — BROADCAST TO ALL PLAYERS INSTANTLY</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {MANUAL_EVENTS.map(({ label, type, text }) => {
                const colorMap: Record<string, string> = { crash: "#ff3333", raid: "#ef4444", tax: "#f0a500", leak: "#06b6d4", blackout: "#8b5cf6", neutral: "#00e676" };
                const color = colorMap[type];
                return (
                  <button key={label} onClick={() => onTriggerEvent(type, text)} className="flex items-start gap-3 p-4 border text-left transition-all hover:scale-[1.01]" style={{ borderColor: color + "30", background: color + "08" }}>
                    <div className="w-2 h-2 rounded-full mt-1 shrink-0" style={{ background: color }} />
                    <div><div className="font-mono text-[12px] font-bold mb-1" style={{ color }}>{label.toUpperCase()}</div><div className="font-mono text-[10px] text-[#5c6878] leading-relaxed">{text}</div></div>
                    <Send size={12} className="ml-auto shrink-0 mt-0.5" style={{ color }} />
                  </button>
                );
              })}
            </div>
            <div className="mt-6 border border-border p-4">
              <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-3">CUSTOM BROADCAST MESSAGE</div>
              <CustomBroadcast onTriggerEvent={onTriggerEvent} />
            </div>
          </div>
        )}

        {adminTab === "OVERVIEW" && (
          <div>
            <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-4">LIVE OVERVIEW — ALL OBJECTIVES VISIBLE TO ADMIN ONLY</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {registeredPlayers.filter((p) => !p.is_admin).map((p) => {
                const obj = ALL_OBJECTIVES.find((o) => o.id === p.objective_id);
                return (
                  <div key={p.id} className="border border-border p-4 bg-[#0d1117]" style={{ borderColor: obj ? obj.color + "25" : undefined }}>
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2"><div className={`w-1.5 h-1.5 rounded-full ${p.online ? "bg-[#00e676] animate-pulse" : "bg-[#2a3444]"}`} /><span className="font-mono text-[13px] font-bold text-[#d8d0c4]">{p.handle}</span></div>
                      <Crown size={12} className="text-[#2a3444]" />
                    </div>
                    {obj ? <div className="flex items-center gap-2 mt-1"><span className="text-base">{obj.icon}</span><div><div className="font-mono text-[10px] font-bold" style={{ color: obj.color }}>{obj.role}</div><div className="font-mono text-[9px] text-[#5c6878] mt-0.5">{obj.goal}</div></div></div> : <div className="font-mono text-[10px] text-[#2a3444] mt-1">No objective assigned</div>}
                  </div>
                );
              })}
              {nonAdminCount === 0 && <div className="col-span-2 border border-dashed border-[#2a3444] p-8 text-center font-mono text-[11px] text-[#5c6878]">NO PLAYERS IN LOBBY</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CustomBroadcast({ onTriggerEvent }: { onTriggerEvent: (type: string, text: string) => void }) {
  const [text, setText] = useState("");
  const [type, setType] = useState("neutral");
  function send() { if (!text.trim()) return; onTriggerEvent(type, text.trim()); setText(""); }
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap">
        {["neutral", "crash", "raid", "tax", "leak", "blackout"].map((t) => (
          <button key={t} onClick={() => setType(t)} className={`font-mono text-[9px] px-2 py-1 border tracking-widest transition-colors ${type === t ? "border-[#f0a500]/60 text-[#f0a500] bg-[#f0a500]/10" : "border-border text-[#5c6878] hover:border-[#5c6878]"}`}>{t.toUpperCase()}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Type broadcast message..." className="flex-1 bg-[#141b24] border border-border text-[#d8d0c4] font-mono text-[11px] px-3 py-2 focus:outline-none focus:border-[#f0a500]/60 placeholder-[#2a3444]" />
        <button onClick={send} disabled={!text.trim()} className="px-4 py-2 bg-[#f0a500]/10 border border-[#f0a500]/40 text-[#f0a500] font-mono text-[10px] tracking-widest hover:bg-[#f0a500]/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">SEND</button>
      </div>
    </div>
  );
}

// ─── Main Game ────────────────────────────────────────────────────────────────

type Tab = "MARKET" | "INTEL" | "INVENTORY" | "CONTRACTS" | "PLAYERS" | "OPS";

// ─── Ops Tab ─────────────────────────────────────────────────────────────────

function OpsTab({
  me, players, marketItems, bounties, myLoan, gameId, now,
  onPlaceBounty, onTargetBlackout, onPumpItem, onTakeLoan, onRepayLoan, onAssassinate,
}: {
  me: PlayerRow; players: PlayerRow[]; marketItems: MarketItemRow[];
  bounties: import("../lib/types").BountyRow[];
  myLoan: import("../lib/types").LoanRow | null;
  gameId: string; now: number;
  onPlaceBounty: (targetId: string, amount: number) => void;
  onTargetBlackout: (targetId: string) => void;
  onPumpItem: (itemId: string) => void;
  onTakeLoan: (amount: number) => void;
  onRepayLoan: () => void;
  onAssassinate: (targetId: string) => void;
}) {
  const [bountyTarget, setBountyTarget] = useState(players[0]?.id ?? "");
  const [bountyAmount, setBountyAmount] = useState(2000);
  const [blackoutTarget, setBlackoutTarget] = useState(players[0]?.id ?? "");
  const [pumpItemId, setPumpItemId] = useState(marketItems[0]?.id ?? "");
  const [loanAmount, setLoanAmount] = useState(5000);
  const [assassinTarget, setAssassinTarget] = useState(players[0]?.id ?? "");
  const [confirmAssassin, setConfirmAssassin] = useState(false);

  const pumpCost = (id: string) => {
    const item = marketItems.find((m) => m.id === id);
    return item ? (item.tier === "legendary" ? 25000 : item.tier === "rare" ? 10000 : 3000) : 0;
  };

  const loanDueIn = myLoan ? Math.max(0, Math.round((new Date(myLoan.due_at).getTime() - now) / 1000)) : 0;

  const SectionHeader = ({ label, color = "#ff3333" }: { label: string; color?: string }) => (
    <div className="font-mono text-[9px] tracking-[0.3em] mb-3 pb-2 border-b border-border flex items-center gap-2" style={{ color }}>
      <div className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {label}
    </div>
  );

  const PlayerSelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="flex-1 bg-[#141b24] border border-border text-[#d8d0c4] font-mono text-[11px] px-2 py-1.5 focus:outline-none focus:border-[#ff3333]/60">
      {players.map((p) => (
        <option key={p.id} value={p.id} className="bg-[#141b24]">
          {p.handle}{p.frozen_until && new Date(p.frozen_until).getTime() > now ? " 🧊" : ""}
          {bounties.some((b) => b.target_id === p.id && b.status === "active") ? " 🎯" : ""}
        </option>
      ))}
    </select>
  );

  const OpsBtn = ({ onClick, label, cost, color = "#ff3333", disabled }: { onClick: () => void; label: string; cost?: string; color?: string; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled}
      className="px-4 py-2 font-mono text-[10px] font-bold tracking-widest border transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      style={{ color, borderColor: color + "40", background: color + "10" }}
      onMouseEnter={(e) => !disabled && ((e.target as HTMLElement).style.background = color + "20")}
      onMouseLeave={(e) => !disabled && ((e.target as HTMLElement).style.background = color + "10")}>
      {label}{cost ? ` — ${cost}` : ""}
    </button>
  );

  if (players.length === 0) {
    return (
      <div className="p-4">
        <div className="border border-dashed border-[#2a3444] p-8 text-center font-mono text-[11px] text-[#5c6878]">
          NO OTHER OPERATORS IN THIS ROOM
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6 max-w-2xl">

      {/* ── Bounties ──────────────────────────────────────────────────────── */}
      <div>
        <SectionHeader label="BOUNTIES — PLACE A HIT ON ANOTHER OPERATOR'S HOLDINGS" color="#ef4444" />
        <div className="bg-[#0d1117] border border-[#ef4444]/20 p-3 mb-3">
          <div className="font-mono text-[9px] text-[#5c6878] mb-3">PAYING A BOUNTY TRIGGERS 3 HOSTILE MARKET EVENTS ON THEIR INVENTORY OVER 90 SECONDS — MINIMUM ₦2,000</div>
          <div className="flex gap-2 flex-wrap items-end">
            <div className="flex-1 min-w-[120px]">
              <div className="font-mono text-[8px] text-[#5c6878] tracking-widest mb-1">TARGET</div>
              <PlayerSelect value={bountyTarget} onChange={setBountyTarget} />
            </div>
            <div className="w-28">
              <div className="font-mono text-[8px] text-[#5c6878] tracking-widest mb-1">AMOUNT</div>
              <input type="number" value={bountyAmount} min={2000} step={500}
                onChange={(e) => setBountyAmount(parseInt(e.target.value) || 2000)}
                className="w-full bg-[#141b24] border border-border text-[#d8d0c4] font-mono text-[11px] px-2 py-1.5 focus:outline-none focus:border-[#ef4444]/60" />
            </div>
            <OpsBtn label="PLACE BOUNTY" cost={fmt(bountyAmount)} color="#ef4444"
              disabled={bountyAmount < 2000 || bountyAmount > me.cash}
              onClick={() => onPlaceBounty(bountyTarget, bountyAmount)} />
          </div>
        </div>
        {bounties.filter((b) => b.status === "active").length > 0 && (
          <div className="border border-border">
            <div className="px-3 py-1.5 bg-[#0d1117] border-b border-border font-mono text-[8px] text-[#5c6878] tracking-widest">ACTIVE BOUNTIES</div>
            {bounties.filter((b) => b.status === "active").map((b) => {
              const target = players.find((p) => p.id === b.target_id);
              const placer = [...players, me].find((p) => p.id === b.placer_id);
              return (
                <div key={b.id} className="flex items-center justify-between px-3 py-2 border-b border-border last:border-0">
                  <div className="font-mono text-[10px] text-[#d8d0c4]">🎯 <span className="text-[#ef4444]">{target?.handle ?? "?"}</span> — placed by {placer?.handle ?? "?"}</div>
                  <div className="flex items-center gap-2">
                    <div className="font-mono text-[9px] text-[#ef4444]">{b.triggers_remaining} hits left</div>
                    <div className="font-mono text-[9px] text-[#f0a500]">{fmt(b.amount)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Pump & Dump ───────────────────────────────────────────────────── */}
      <div>
        <SectionHeader label="PUMP & DUMP — SPIKE AN ITEM 60%, THEN IT CRASHES 60% AFTER 60s" color="#8b5cf6" />
        <div className="bg-[#0d1117] border border-[#8b5cf6]/20 p-3">
          <div className="font-mono text-[9px] text-[#5c6878] mb-3">BUY BEFORE PUMPING. SELL BEFORE THE DUMP. TIMING IS EVERYTHING.</div>
          <div className="flex gap-2 flex-wrap items-end">
            <div className="flex-1 min-w-[140px]">
              <div className="font-mono text-[8px] text-[#5c6878] tracking-widest mb-1">TARGET ITEM</div>
              <select value={pumpItemId} onChange={(e) => setPumpItemId(e.target.value)}
                className="w-full bg-[#141b24] border border-border text-[#d8d0c4] font-mono text-[11px] px-2 py-1.5 focus:outline-none focus:border-[#8b5cf6]/60">
                {marketItems.map((m) => (
                  <option key={m.id} value={m.id} className="bg-[#141b24]">
                    {m.name} — {fmt(m.price)}{m.pump_until && new Date(m.pump_until).getTime() > now ? " [PUMPED]" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="font-mono text-[10px] text-[#8b5cf6] border border-[#8b5cf6]/30 px-3 py-1.5">
              COST: {fmt(pumpCost(pumpItemId))}
            </div>
            <OpsBtn label="PUMP IT" color="#8b5cf6"
              disabled={pumpCost(pumpItemId) > me.cash || !!(marketItems.find(m=>m.id===pumpItemId)?.pump_until && new Date(marketItems.find(m=>m.id===pumpItemId)!.pump_until!).getTime() > now)}
              onClick={() => onPumpItem(pumpItemId)} />
          </div>
        </div>
      </div>

      {/* ── Covert Ops ────────────────────────────────────────────────────── */}
      <div>
        <SectionHeader label="COVERT OPS — BLIND OR ELIMINATE AN OPERATOR" color="#06b6d4" />
        <div className="bg-[#0d1117] border border-[#06b6d4]/20 p-3 space-y-3">
          <div className="mb-2">
            <div className="font-mono text-[8px] text-[#5c6878] tracking-widest mb-1">TARGET OPERATOR</div>
            <PlayerSelect value={blackoutTarget} onChange={(v) => { setBlackoutTarget(v); setAssassinTarget(v); }} />
          </div>
          <div className="flex gap-2 flex-wrap">
            <div className="flex-1 border border-[#06b6d4]/20 p-3">
              <div className="font-mono text-[10px] font-bold text-[#06b6d4] mb-1">📡 PERSONAL BLACKOUT</div>
              <div className="font-mono text-[9px] text-[#5c6878] mb-2">Blinds their price feed for 90 seconds. They trade blind.</div>
              <OpsBtn label="EXECUTE" cost="₦5,000" color="#06b6d4"
                disabled={5000 > me.cash}
                onClick={() => onTargetBlackout(blackoutTarget)} />
            </div>
            <div className="flex-1 border border-[#ff3333]/30 p-3">
              <div className="font-mono text-[10px] font-bold text-[#ff3333] mb-1">☠️ ASSASSINATION</div>
              <div className="font-mono text-[9px] text-[#5c6878] mb-2">Freezes their entire account for 90s. They cannot trade at all.</div>
              <div className="font-mono text-[9px] text-[#ff3333] mb-2 tracking-widest">COST: ₦75,000 — NO REFUNDS</div>
              {!confirmAssassin ? (
                <OpsBtn label="INITIATE" color="#ff3333"
                  disabled={75000 > me.cash}
                  onClick={() => setConfirmAssassin(true)} />
              ) : (
                <div className="flex gap-2">
                  <button onClick={() => { onAssassinate(assassinTarget); setConfirmAssassin(false); }}
                    className="flex-1 py-1.5 bg-[#ff3333] text-black font-mono text-[9px] font-black tracking-widest hover:bg-[#ff5555] transition-colors">
                    CONFIRM ☠️
                  </button>
                  <button onClick={() => setConfirmAssassin(false)}
                    className="px-3 py-1.5 border border-border text-[#5c6878] font-mono text-[9px] hover:text-[#d8d0c4] transition-colors">
                    CANCEL
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Debt Market ───────────────────────────────────────────────────── */}
      <div>
        <SectionHeader label="DEBT MARKET — BORROW FAST, PAY 50% INTEREST IN 90 SECONDS" color="#f0a500" />
        <div className="bg-[#0d1117] border border-[#f0a500]/20 p-3">
          {myLoan ? (
            <div>
              <div className="font-mono text-[9px] text-[#5c6878] tracking-widest mb-3">ACTIVE LOAN</div>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div><div className="font-mono text-[8px] text-[#5c6878]">BORROWED</div><div className="font-mono text-[14px] font-bold text-[#d8d0c4]">{fmt(myLoan.principal)}</div></div>
                <div><div className="font-mono text-[8px] text-[#5c6878]">NOW OWED</div><div className="font-mono text-[14px] font-bold text-[#ff3333]">{fmt(myLoan.total_owed)}</div></div>
                <div><div className="font-mono text-[8px] text-[#5c6878]">DUE IN</div><div className={`font-mono text-[14px] font-bold tabular-nums ${loanDueIn < 20 ? "text-[#ff3333] animate-pulse" : "text-[#f0a500]"}`}>{loanDueIn}s</div></div>
              </div>
              {loanDueIn === 0 && <div className="font-mono text-[9px] text-[#ff3333] mb-2 animate-pulse">⚠️ OVERDUE — INVENTORY SEIZURE IMMINENT</div>}
              <OpsBtn label="REPAY NOW" cost={fmt(myLoan.total_owed)} color="#00e676"
                disabled={myLoan.total_owed > me.cash}
                onClick={onRepayLoan} />
            </div>
          ) : (
            <div>
              <div className="font-mono text-[9px] text-[#5c6878] mb-3">BORROW UP TO ₦25,000 — REPAY ×1.5 IN 90 SECONDS OR INVENTORY GETS SEIZED</div>
              <div className="flex gap-2 flex-wrap items-end">
                <div className="flex-1">
                  <div className="font-mono text-[8px] text-[#5c6878] tracking-widest mb-1">AMOUNT (₦1,000 – ₦25,000)</div>
                  <input type="range" min={1000} max={25000} step={1000} value={loanAmount}
                    onChange={(e) => setLoanAmount(parseInt(e.target.value))}
                    className="w-full accent-[#f0a500]" />
                  <div className="flex justify-between mt-1">
                    <span className="font-mono text-[9px] text-[#5c6878]">BORROW: {fmt(loanAmount)}</span>
                    <span className="font-mono text-[9px] text-[#ff3333]">OWE: {fmt(Math.round(loanAmount * 1.5))}</span>
                  </div>
                </div>
                <OpsBtn label="BORROW" cost={fmt(loanAmount)} color="#f0a500"
                  onClick={() => onTakeLoan(loanAmount)} />
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

function Game({ conn, onLogout, soundsOn, onToggleSounds }: {
  conn: ReturnType<typeof useGameConnection>;
  onLogout: () => void;
  soundsOn: boolean;
  onToggleSounds: () => void;
}) {
  const { game, players, marketItems, rumors, purchasedRumorIds, events, auction, inventory, contracts, bounties, myLoan, me, buy, sell, buyRumor, bid, acceptContract, cancelContract, completeContract, placeBounty, targetBlackout, pumpItem, takeLoan, repayLoan, assassinatePlayer } = conn;
  const [tab, setTab] = useState<Tab>("MARKET");
  const [selectedId, setSelectedId] = useState<string>("gold");
  const [bidInput, setBidInput] = useState("");
  const [showObjective, setShowObjective] = useState(false);
  const [buyQty, setBuyQty] = useState(1);
  const [notification, setNotification] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const notifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Computed before the early-return guard below (hooks can't follow a
  // conditional return), and again re-derived after it once `game` is
  // known non-null — this first pass only needs to exist so the
  // COLLAPSE-tick effect's dependency array has something defined to read.
  const phase = game?.phase;

  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // COLLAPSE tick sound — fires every second during the last 90s
  useEffect(() => {
    if (phase !== "COLLAPSE") return;
    Sounds.playCollapseTick();
    const t = setInterval(() => Sounds.playCollapseTick(), 2000);
    return () => clearInterval(t);
  }, [phase]);

  const notify = useCallback((msg: string) => {
    setNotification(msg);
    if (notifTimerRef.current) clearTimeout(notifTimerRef.current);
    notifTimerRef.current = setTimeout(() => setNotification(null), 3000);
  }, []);

  if (!me || !game) return <LoadingScreen label="LOADING MARKET DATA..." />;

  const objective = ALL_OBJECTIVES.find((o) => o.id === me.objective_id) ?? ALL_OBJECTIVES[0];
  const blackout = !!(game.blackout_until && new Date(game.blackout_until).getTime() > now)
    || !!(me.player_blackout_until && new Date(me.player_blackout_until).getTime() > now);
  const frozen = !!(me.frozen_until && new Date(me.frozen_until).getTime() > now);
  const frozenSecsLeft = frozen ? Math.ceil((new Date(me.frozen_until!).getTime() - now) / 1000) : 0;
  const startedAtMs = game.started_at ? new Date(game.started_at).getTime() : now;
  const remainingSec = Math.max(0, Math.round(game.duration_seconds - (now - startedAtMs) / 1000));
  const mins = Math.floor(remainingSec / 60);
  const secs = remainingSec % 60;
  const phaseColor = phase === "COLLAPSE" ? "#ff3333" : phase === "FINAL PHASE" ? "#f0a500" : "#00e676";

  const selectedItem = marketItems.find((i) => i.id === selectedId) ?? marketItems[0];
  const cash = me.cash;
  const rep = me.rep;
  const tradeCount = me.trade_count;

  async function handleBuy() {
    if (!selectedItem) return;
    try { await buy(selectedItem.id, buyQty); Sounds.playBuy(); notify(`✓ PURCHASED ${buyQty}× ${selectedItem.name} for ${fmt(selectedItem.price * buyQty)}`); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleSell(itemId: string) {
    const inv = inventory.find((i) => i.item_id === itemId);
    if (!inv) return;
    try { await sell(itemId); Sounds.playSell(); notify(`✓ SOLD ${inv.qty}× ${itemMeta(itemId).name}`); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleBuyRumor(rumorId: string) {
    try { await buyRumor(rumorId); notify("✓ INTEL PURCHASED"); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleBid() {
    const amount = parseInt(bidInput, 10);
    if (isNaN(amount)) { notify("✗ ENTER A VALID BID"); return; }
    try { await bid(amount); Sounds.playBid(); setBidInput(""); notify(`✓ BID PLACED — ${fmt(amount)}`); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handlePlaceBounty(targetId: string, amount: number) {
    try { await placeBounty(targetId, amount); notify(`✓ BOUNTY PLACED — ₦${amount.toLocaleString()} committed`); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleTargetBlackout(targetId: string) {
    try { await targetBlackout(targetId); notify("✓ SIGNAL JAM DEPLOYED — ₦5,000 spent"); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handlePumpItem(itemId: string) {
    try { await pumpItem(itemId); notify("✓ PUMP INITIATED — sell before the crash"); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleTakeLoan(amount: number) {
    try { await takeLoan(amount); notify(`✓ ₦${amount.toLocaleString()} borrowed — repay within 90s`); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleRepayLoan() {
    try { await repayLoan(); notify("✓ LOAN REPAID"); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleAssassinate(targetId: string) {
    if (!window.confirm("Spend ₦75,000 to freeze this player for 90 seconds?")) return;
    try { await assassinatePlayer(targetId); notify("☠️ TARGET NEUTRALISED — 90s freeze deployed"); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleAcceptContract(id: string) {
    try { await acceptContract(id); notify("✓ CONTRACT ACCEPTED"); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleCancelContract(id: string) {
    try { await cancelContract(id); notify("CONTRACT RELEASED BACK TO THE BOARD"); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }
  async function handleCompleteContract(id: string) {
    try { await completeContract(id); notify("✓ CONTRACT FULFILLED — REWARD PAID"); }
    catch (e) { notify(`✗ ${(e as Error).message}`); }
  }

  function itemMeta(itemId: string) {
    const mkt = marketItems.find((m) => m.id === itemId);
    if (mkt) return { name: mkt.name, icon: ITEM_META[itemId]?.icon ?? "📦" };
    if (itemId.startsWith("auction:")) return { name: itemId.replace("auction:", ""), icon: "🛂" };
    return { name: itemId, icon: "📦" };
  }

  const portfolioValue = inventory.reduce((acc, inv) => {
    const mkt = marketItems.find((i) => i.id === inv.item_id);
    return acc + (mkt ? mkt.price * inv.qty : inv.avg_buy * inv.qty);
  }, 0);
  const netWorth = cash + portfolioValue; // locally responsive estimate for my own HUD
  // Filter admins BEFORE sort so myRank is computed correctly (admin was
  // previously included in the sort, pushing everyone's rank off by 1).
  const nonAdminPlayers = players.filter((p) => !p.is_admin);
  const sortedPlayers = [...nonAdminPlayers].sort(
    (a, b) => b.net_worth - a.net_worth || b.trade_count - a.trade_count || a.handle.localeCompare(b.handle)
  );
  const myRank = me.is_admin ? 0 : sortedPlayers.findIndex((p) => p.id === me.id) + 1;

  const isFrozen = !!(me.frozen_until && new Date(me.frozen_until).getTime() > now);
  const isPersonalBlackout = !!(me.player_blackout_until && new Date(me.player_blackout_until).getTime() > now);
  const effectiveBlackout = blackout || isPersonalBlackout;
  const chartData = selectedItem ? selectedItem.history.map((v, i) => ({ t: i, v })) : [];
  const auctionTimeLeft = auction ? Math.max(0, Math.round((new Date(auction.ends_at).getTime() - now) / 1000)) : 0;

  return (
    <div className="size-full flex flex-col bg-background text-foreground overflow-hidden" style={{ fontFamily: "'Barlow', sans-serif" }}>
      {notification && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-[#0d1117] border border-[#f0a500]/60 px-4 py-2 font-mono text-[11px] text-[#f0a500] tracking-widest shadow-xl">{notification}</div>
      )}

      <header className="flex items-center gap-0 border-b border-border bg-[#0d1117] shrink-0 overflow-x-auto">
        <div className="flex items-center gap-2 px-4 py-2.5 border-r border-border shrink-0">
          <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: phaseColor }} />
          <span className="font-bold text-[13px] tracking-[0.2em] text-[#f0a500] uppercase shrink-0" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>THE BLACK MARKET</span>
        </div>
        <div className="px-3 py-2.5 border-r border-border shrink-0"><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">PHASE</div><div className="font-mono text-[11px] font-bold tracking-wider" style={{ color: phaseColor }}>{phase}</div></div>
        <div className="px-3 py-2.5 border-r border-border shrink-0">
          <div className="font-mono text-[9px] text-[#5c6878] tracking-widest flex items-center gap-1"><Clock size={8} />REMAINING</div>
          <div className="font-mono text-[14px] font-bold tabular-nums" style={{ color: remainingSec < 300 ? "#ff3333" : "#d8d0c4" }}>{String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}</div>
        </div>
        <div className="px-3 py-2.5 border-r border-border shrink-0"><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">CASH</div><div className="font-mono text-[14px] font-bold text-[#00e676] tabular-nums">{fmt(cash)}</div></div>
        <div className="px-3 py-2.5 border-r border-border shrink-0"><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">NET WORTH</div><div className="font-mono text-[14px] font-bold text-[#f0a500] tabular-nums">{fmt(netWorth)}</div></div>
        <div className="px-3 py-2.5 border-r border-border shrink-0 w-28">
          <div className="font-mono text-[9px] text-[#5c6878] tracking-widest flex justify-between"><span>REPUTATION</span><span className="text-[#d8d0c4]">{rep}</span></div>
          <div className="mt-1.5"><RepBar value={rep} /></div>
        </div>
        <div className="px-3 py-2.5 border-r border-border shrink-0"><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">TRADES</div><div className="font-mono text-[14px] font-bold tabular-nums text-[#d8d0c4]">{tradeCount}</div></div>
        <div className="px-3 py-2.5 border-r border-border shrink-0"><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">RANK</div><div className="font-mono text-[14px] font-bold tabular-nums text-[#06b6d4]">#{myRank}</div></div>
        {me.wanted_level > 0 && (
          <div className="px-3 py-2.5 border-r border-border shrink-0">
            <div className="font-mono text-[9px] text-[#5c6878] tracking-widest">HEAT</div>
            <div className="flex items-center gap-0.5 mt-0.5">
              {[1,2,3,4,5].map((n) => (
                <div key={n} className="w-2 h-2 rounded-full" style={{ background: n <= me.wanted_level ? (me.wanted_level >= 4 ? "#ff3333" : me.wanted_level >= 3 ? "#f0a500" : "#eab308") : "#2a3444" }} />
              ))}
            </div>
          </div>
        )}
        {me.frozen_until && new Date(me.frozen_until).getTime() > now && (
          <div className="px-3 py-2.5 border-r border-border shrink-0 bg-[#06b6d4]/10 animate-pulse">
            <div className="font-mono text-[9px] text-[#06b6d4] tracking-widest">FROZEN</div>
            <div className="font-mono text-[11px] font-bold text-[#06b6d4]">{Math.round((new Date(me.frozen_until).getTime() - now) / 1000)}s</div>
          </div>
        )}
        {me.total_debt > 0 && (
          <div className="px-3 py-2.5 border-r border-border shrink-0 bg-[#ff3333]/10">
            <div className="font-mono text-[9px] text-[#ff3333] tracking-widest">DEBT</div>
            <div className="font-mono text-[11px] font-bold text-[#ff3333]">{fmt(me.total_debt)}</div>
          </div>
        )}
        <div className="px-3 py-2.5 border-r border-border shrink-0">
          <div className="font-mono text-[9px] text-[#5c6878] tracking-widest">HEAT</div>
          <div className="flex items-center gap-0.5 mt-0.5">
            {[1,2,3,4,5].map((n) => (
              <div key={n} className="w-2 h-2 rounded-none" style={{ background: n <= me.wanted_level ? (me.wanted_level >= 4 ? "#ff3333" : me.wanted_level >= 2 ? "#f0a500" : "#00e676") : "#2a3444" }} />
            ))}
          </div>
        </div>
        {frozen && (
          <div className="px-3 py-2.5 border-r border-border shrink-0 bg-[#ff3333]/10 animate-pulse">
            <div className="font-mono text-[9px] text-[#ff3333] tracking-widest">FROZEN</div>
            <div className="font-mono text-[12px] font-bold text-[#ff3333]">{frozenSecsLeft}s</div>
          </div>
        )}
        {me.total_debt > 0 && (
          <div className="px-3 py-2.5 border-r border-border shrink-0 bg-[#f0a500]/8">
            <div className="font-mono text-[9px] text-[#f0a500] tracking-widest">DEBT</div>
            <div className="font-mono text-[12px] font-bold text-[#f0a500] tabular-nums">{fmt(me.total_debt)}</div>
          </div>
        )}
        <div className="flex-1" />
        <button onClick={() => setShowObjective((v) => !v)} className="flex items-center gap-1.5 px-3 py-2.5 border-l border-border text-[#5c6878] hover:text-[#f0a500] transition-colors">
          {showObjective ? <EyeOff size={12} /> : <Eye size={12} />}<span className="font-mono text-[9px] tracking-widest" style={{ color: objective.color }}>{objective.role}</span>
        </button>
        <div className="px-3 py-2.5 border-l border-border shrink-0"><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">ROOM</div><div className="font-mono text-[11px] font-bold text-[#5c6878] tracking-[0.15em]">{formatCode(game.code)}</div></div>
        <div className="px-4 py-2.5 border-l border-border shrink-0"><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">OPERATOR</div><div className="font-mono text-[11px] font-bold text-[#d8d0c4]">{me.handle}</div></div>
        <button onClick={onToggleSounds} className="px-3 py-2.5 border-l border-border font-mono text-[9px] text-[#5c6878] hover:text-[#d8d0c4] transition-colors tracking-widest" title={soundsOn ? "Mute sounds" : "Enable sounds"}>
          {soundsOn ? "🔊" : "🔇"}
        </button>
        <button onClick={onLogout} className="px-3 py-2.5 border-l border-border font-mono text-[9px] text-[#5c6878] hover:text-[#ff3333] transition-colors tracking-widest">EXIT</button>
        <button onClick={() => conn.signOut()} className="px-3 py-2.5 border-l border-border font-mono text-[9px] text-[#5c6878] hover:text-[#ff3333] transition-colors tracking-widest">SIGN OUT</button>
      </header>

      {showObjective && (
        <div className="mx-4 mt-2 px-4 py-3 border flex items-start gap-3 shrink-0" style={{ borderColor: objective.color + "40", background: objective.color + "08" }}>
          <span className="text-xl shrink-0">{objective.icon}</span>
          <div>
            <div className="font-mono text-[10px] font-bold tracking-[0.25em] mb-0.5" style={{ color: objective.color }}>SECRET OBJECTIVE — {objective.role}</div>
            <div className="font-mono text-[11px] text-[#d8d0c4]">{objective.goal}</div>
            <div className="font-mono text-[10px] text-[#5c6878] mt-0.5 italic">{objective.hint}</div>
          </div>
          <Lock size={12} className="shrink-0 ml-auto" style={{ color: objective.color }} />
        </div>
      )}

      <div className="flex border-b border-border bg-[#0d1117] shrink-0">
        {([{ id: "MARKET", icon: TrendingUp }, { id: "INTEL", icon: Radio }, { id: "INVENTORY", icon: Package }, { id: "CONTRACTS", icon: FileText }, { id: "PLAYERS", icon: Users }, { id: "OPS", icon: AlertTriangle }] as { id: Tab; icon: typeof TrendingUp }[]).map(({ id, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)} className={`flex items-center gap-1.5 px-4 py-2.5 font-mono text-[10px] tracking-widest border-r border-border transition-colors ${tab === id ? (id === "OPS" ? "text-[#ff3333] border-b-2 border-b-[#ff3333] bg-[#ff3333]/5" : "text-[#f0a500] border-b-2 border-b-[#f0a500] bg-[#f0a500]/5") : "text-[#5c6878] hover:text-[#d8d0c4] border-b-2 border-b-transparent"}`} style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            <Icon size={10} />{id}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {tab === "MARKET" && (
            <div className="flex flex-col lg:flex-row">
              <div className="w-full lg:w-64 border-r border-border lg:overflow-y-auto shrink-0 lg:h-full">
                {(["legendary", "rare", "common"] as const).map((tier) => (
                  <div key={tier}>
                    <div className="px-3 py-1.5 bg-[#0d1117] border-b border-border"><span className="font-mono text-[9px] tracking-[0.3em] text-[#5c6878]" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>{tier.toUpperCase()}</span></div>
                    {marketItems.filter((i) => i.tier === tier).map((item) => (
                      <button key={item.id} onClick={() => setSelectedId(item.id)} className={`w-full flex items-center gap-2 px-3 py-2.5 border-b border-border text-left transition-colors ${selectedId === item.id ? "bg-[#f0a500]/8 border-l-2 border-l-[#f0a500]" : "hover:bg-[#141b24] border-l-2 border-l-transparent"}`}>
                        <span className="text-base shrink-0">{ITEM_META[item.id]?.icon ?? "📦"}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5"><span className="font-mono text-[11px] font-bold truncate text-[#d8d0c4]">{item.name}</span>{item.is_illegal && <AlertTriangle size={8} className="text-[#ff3333] shrink-0" />}</div>
                          <div className="flex items-center justify-between mt-0.5">
                            <span className="font-mono text-[12px] font-bold tabular-nums text-[#f0a500]">{effectiveBlackout ? "???" : fmt(item.price)}</span>
                            {!effectiveBlackout && <PriceTicker change={item.change} changePercent={item.change_percent} />}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>

              <div className="flex-1 flex flex-col overflow-hidden">
                {selectedItem && (
                  <>
                    <div className="px-5 py-3 border-b border-border bg-[#0d1117] flex items-center justify-between shrink-0">
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{ITEM_META[selectedItem.id]?.icon ?? "📦"}</span>
                        <div>
                          <div className="font-bold text-[16px] tracking-wider text-[#d8d0c4]" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>{selectedItem.name}</div>
                          <div className="flex items-center gap-2 mt-0.5"><TierBadge tier={selectedItem.tier} />{selectedItem.is_illegal && <span className="font-mono text-[9px] text-[#ff3333] border border-[#ff3333]/30 px-1">ILLEGAL</span>}</div>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-[24px] font-bold tabular-nums text-[#f0a500]">{effectiveBlackout ? "BLACKOUT" : fmt(selectedItem.price)}</div>
                        {!effectiveBlackout && <PriceTicker change={selectedItem.change} changePercent={selectedItem.change_percent} />}
                      </div>
                    </div>
                    <div className="h-40 px-2 pt-3 shrink-0">
                      {effectiveBlackout ? (
                        <div className="h-full flex items-center justify-center font-mono text-[12px] text-[#5c6878] tracking-widest">— BLACKOUT EVENT — PRICE DATA HIDDEN —</div>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={chartData}>
                            <defs><linearGradient id="priceGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={selectedItem.trend === "up" ? "#00e676" : "#ff3333"} stopOpacity={0.2} /><stop offset="100%" stopColor={selectedItem.trend === "up" ? "#00e676" : "#ff3333"} stopOpacity={0} /></linearGradient></defs>
                            <XAxis hide /><YAxis hide domain={["auto", "auto"]} /><Tooltip content={<CustomTooltip />} />
                            <Area type="monotone" dataKey="v" stroke={selectedItem.trend === "up" ? "#00e676" : "#ff3333"} strokeWidth={1.5} fill="url(#priceGrad)" isAnimationActive={false} />
                          </AreaChart>
                        </ResponsiveContainer>
                      )}
                    </div>
                    <div className="px-5 py-4 border-t border-border">
                      <div className="font-mono text-[9px] text-[#5c6878] tracking-widest mb-3">EXECUTE TRADE</div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <div className="flex items-center gap-0 border border-border">
                          <button onClick={() => setBuyQty((q) => Math.max(1, q - 1))} className="px-2 py-1.5 font-mono text-[12px] text-[#5c6878] hover:text-[#f0a500] transition-colors bg-[#141b24]">−</button>
                          <div className="px-3 py-1.5 font-mono text-[12px] font-bold text-[#d8d0c4] bg-[#0d1117] min-w-[3rem] text-center tabular-nums">{buyQty}</div>
                          <button onClick={() => setBuyQty((q) => q + 1)} className="px-2 py-1.5 font-mono text-[12px] text-[#5c6878] hover:text-[#f0a500] transition-colors bg-[#141b24]">+</button>
                        </div>
                        <div className="font-mono text-[11px] text-[#5c6878]">TOTAL: <span className="text-[#f0a500] font-bold">{fmt(selectedItem.price * buyQty)}</span> <span className="text-[#ff3333] text-[9px]">+{fmt(Math.max(1, Math.round(selectedItem.price * buyQty * 0.03)))} fee</span></div>
                        <button onClick={handleBuy} disabled={isFrozen || selectedItem.price * buyQty > cash} className="flex items-center gap-1.5 px-4 py-2 bg-[#00e676]/10 border border-[#00e676]/40 text-[#00e676] font-mono text-[11px] font-bold tracking-widest hover:bg-[#00e676]/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"><ShoppingCart size={10} />{isFrozen ? "FROZEN" : "BUY"}</button>
                        {inventory.find((i) => i.item_id === selectedId) && (
                          <button onClick={() => handleSell(selectedId)} className="flex items-center gap-1.5 px-4 py-2 bg-[#ff3333]/10 border border-[#ff3333]/40 text-[#ff3333] font-mono text-[11px] font-bold tracking-widest hover:bg-[#ff3333]/20 transition-colors"><TrendingDown size={10} />SELL ALL</button>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-4 mt-4">
                        {[{ label: "BASE PRICE", value: fmt(selectedItem.base_price) }, { label: "HIGH (SESSION)", value: selectedItem.history.length ? fmt(Math.max(...selectedItem.history)) : "—" }, { label: "LOW (SESSION)", value: selectedItem.history.length ? fmt(Math.min(...selectedItem.history)) : "—" }].map(({ label, value }) => (
                          <div key={label}><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">{label}</div><div className="font-mono text-[12px] font-bold text-[#d8d0c4] tabular-nums mt-0.5">{value}</div></div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === "INTEL" && (
            <div className="p-4">
              <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-4 flex items-center gap-2"><Radio size={9} />INTELLIGENCE MARKET — ALL INFORMATION FOR SALE</div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {rumors.map((r: RumorRow) => {
                  const purchased = purchasedRumorIds.includes(r.id);
                  const credColor = r.credibility === "HOT" ? "#00e676" : r.credibility === "COLD" ? "#ff3333" : "#f0a500";
                  return (
                    <div key={r.id} className="border border-border p-4 relative overflow-hidden" style={{ background: purchased ? "rgba(0,230,118,0.03)" : "#0d1117", borderColor: purchased ? "rgba(0,230,118,0.2)" : undefined }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-mono text-[9px] font-bold tracking-widest border px-1.5 py-0.5" style={{ color: credColor, borderColor: credColor + "40" }}>SOURCE: {r.credibility}</span>
                        {purchased ? <span className="font-mono text-[9px] text-[#00e676] tracking-widest">✓ PURCHASED</span> : <span className="font-mono text-[10px] font-bold text-[#f0a500]">{fmt(r.cost)}</span>}
                      </div>
                      <p className={`font-mono text-[11px] leading-relaxed mb-3 ${purchased ? "text-[#d8d0c4]" : "text-[#5c6878] blur-[3px] select-none"}`}>{r.text}</p>
                      {!purchased && (
                        <>
                          <button onClick={() => handleBuyRumor(r.id)} disabled={r.cost > cash} className="w-full border border-[#f0a500]/40 bg-[#f0a500]/5 text-[#f0a500] font-mono text-[10px] py-1.5 tracking-widest hover:bg-[#f0a500]/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">PURCHASE INTEL — {fmt(r.cost)}</button>
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><Lock size={20} className="text-[#2a3444] opacity-40" /></div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "INVENTORY" && (
            <div className="p-4">
              <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-4 flex items-center gap-2"><Package size={9} />YOUR HOLDINGS</div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                {[{ label: "CASH", value: fmt(cash), color: "#00e676" }, { label: "PORTFOLIO", value: fmt(portfolioValue), color: "#f0a500" }, { label: "NET WORTH", value: fmt(netWorth), color: "#06b6d4" }, { label: "RANK", value: `#${myRank}`, color: "#8b5cf6" }].map(({ label, value, color }) => (
                  <div key={label} className="border border-border p-3 bg-[#0d1117]"><div className="font-mono text-[9px] text-[#5c6878] tracking-widest">{label}</div><div className="font-mono text-[16px] font-bold tabular-nums mt-1" style={{ color }}>{value}</div></div>
                ))}
              </div>
              {inventory.length === 0 ? (
                <div className="border border-dashed border-[#2a3444] p-8 text-center font-mono text-[11px] text-[#5c6878]">NO HOLDINGS — VISIT THE MARKET TO BUY ITEMS</div>
              ) : (
                <div className="border border-border overflow-hidden">
                  <div className="grid grid-cols-6 bg-[#0d1117] border-b border-border px-4 py-2">{["ITEM", "QTY", "AVG BUY", "CURRENT", "P&L", ""].map((h) => <div key={h} className="font-mono text-[9px] text-[#5c6878] tracking-widest">{h}</div>)}</div>
                  {inventory.map((inv) => {
                    const mkt = marketItems.find((i) => i.id === inv.item_id);
                    const meta = itemMeta(inv.item_id);
                    const currentVal = mkt ? mkt.price * inv.qty : inv.avg_buy * inv.qty;
                    const cost = inv.avg_buy * inv.qty;
                    const pnl = currentVal - cost;
                    const pnlPct = cost > 0 ? ((pnl / cost) * 100).toFixed(1) : "0.0";
                    return (
                      <div key={inv.item_id} className="grid grid-cols-6 items-center px-4 py-3 border-b border-border hover:bg-[#141b24] transition-colors">
                        <div className="flex items-center gap-2"><span>{meta.icon}</span><span className="font-mono text-[11px] font-bold text-[#d8d0c4]">{meta.name}</span></div>
                        <div className="font-mono text-[12px] tabular-nums text-[#d8d0c4]">{inv.qty}</div>
                        <div className="font-mono text-[11px] tabular-nums text-[#5c6878]">{fmt(inv.avg_buy)}</div>
                        <div className="font-mono text-[11px] tabular-nums text-[#f0a500]">{mkt ? fmt(mkt.price) : "—"}</div>
                        <div className="font-mono text-[11px] tabular-nums font-bold" style={{ color: pnl >= 0 ? "#00e676" : "#ff3333" }}>{pnl >= 0 ? "+" : ""}{fmt(pnl)} ({pnlPct}%)</div>
                        <div className="flex justify-end">{mkt && <button onClick={() => handleSell(inv.item_id)} className="font-mono text-[9px] tracking-widest text-[#ff3333] border border-[#ff3333]/30 px-2 py-1 hover:bg-[#ff3333]/10 transition-colors">SELL ALL</button>}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === "CONTRACTS" && (
            <div className="p-4">
              <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-4 flex items-center gap-2"><FileText size={9} />ACTIVE CONTRACTS — ALLIANCES NOT BINDING. BETRAYAL IS ALLOWED.</div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {contracts.filter((c: ContractRow) => c.status === "open" || c.accepted_by === me.id).map((c: ContractRow) => {
                  const riskColor = c.risk === "EXTREME" ? "#ff3333" : c.risk === "HIGH" ? "#f0a500" : c.risk === "MED" ? "#06b6d4" : "#00e676";
                  const mineAccepted = c.accepted_by === me.id && c.status === "accepted";
                  const have = c.item_id ? inventory.find((i) => i.item_id === c.item_id)?.qty ?? 0 : c.qty_required;
                  const canFulfill = mineAccepted && have >= c.qty_required;
                  const expiresIn = Math.max(0, Math.round((new Date(c.expires_at).getTime() - now) / 1000));
                  return (
                    <div key={c.id} className="border border-border p-4 bg-[#0d1117]" style={{ opacity: c.status === "completed" ? 0.5 : 1 }}>
                      <div className="flex items-start justify-between mb-2">
                        <div><div className="font-mono text-[10px] text-[#5c6878]">FROM</div><div className="font-mono text-[13px] font-bold text-[#d8d0c4]">{c.author}</div></div>
                        <div className="text-right">
                          <div className="font-mono text-[9px] font-bold border px-1.5 py-0.5 tracking-widest" style={{ color: riskColor, borderColor: riskColor + "40" }}>RISK: {c.risk}</div>
                          {c.is_illegal && <div className="font-mono text-[9px] text-[#ff3333] mt-1">⚠ ILLEGAL</div>}
                        </div>
                      </div>
                      <div className="font-mono text-[11px] text-[#d8d0c4] mb-1 leading-relaxed">{c.demand}</div>
                      {mineAccepted && c.item_id && (
                        <div className="font-mono text-[9px] mb-2" style={{ color: canFulfill ? "#00e676" : "#ff3333" }}>YOU HOLD {have}/{c.qty_required}</div>
                      )}
                      <div className="flex items-center justify-between mt-2">
                        <div><div className="font-mono text-[9px] text-[#5c6878]">REWARD</div><div className="font-mono text-[16px] font-bold text-[#00e676]">{fmt(c.reward)}</div></div>
                        <div className="flex items-center gap-1"><Clock size={8} className="text-[#5c6878]" /><span className="font-mono text-[10px] text-[#5c6878]">{c.status === "open" ? `${expiresIn}s` : c.status.toUpperCase()}</span></div>
                        {c.status === "open" && (
                          <button onClick={() => handleAcceptContract(c.id)} className="font-mono text-[10px] tracking-widest border border-[#00e676]/40 text-[#00e676] px-3 py-1.5 hover:bg-[#00e676]/10 transition-colors">ACCEPT</button>
                        )}
                        {mineAccepted && (
                          <div className="flex gap-1.5">
                            <button onClick={() => handleCancelContract(c.id)} className="font-mono text-[9px] tracking-widest border border-[#5c6878]/40 text-[#5c6878] px-2 py-1.5 hover:bg-[#5c6878]/10 transition-colors">DROP</button>
                            <button onClick={() => handleCompleteContract(c.id)} disabled={!canFulfill} className="font-mono text-[10px] tracking-widest border border-[#00e676]/40 text-[#00e676] px-3 py-1.5 hover:bg-[#00e676]/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed">FULFILL</button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {contracts.filter((c: ContractRow) => c.status === "open" || c.accepted_by === me.id).length === 0 && (
                  <div className="lg:col-span-2 border border-dashed border-[#2a3444] p-8 text-center font-mono text-[11px] text-[#5c6878]">NO CONTRACTS ON THE BOARD RIGHT NOW — CHECK BACK SOON</div>
                )}
              </div>
            </div>
          )}

          {tab === "PLAYERS" && (
            <div className="p-4">
              <div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] mb-4 flex items-center gap-2"><Users size={9} />LEADERBOARD — OBJECTIVES NEVER REVEALED</div>
              <div className="border border-border overflow-hidden">
                <div className="grid grid-cols-6 bg-[#0d1117] border-b border-border px-4 py-2">{["RANK", "HANDLE", "NET WORTH", "CASH", "REP", "TRADES"].map((h) => <div key={h} className="font-mono text-[9px] text-[#5c6878] tracking-widest">{h}</div>)}</div>
                {sortedPlayers.map((p, idx) => {
                  const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : null;
                  const hasBounty = conn.bounties.some((b) => b.target_id === p.id && b.status === "active");
                  return (
                    <div key={p.id} className="grid grid-cols-6 items-center px-4 py-3 border-b border-border hover:bg-[#141b24] transition-colors">
                      <div className="font-mono text-[12px] font-bold text-[#5c6878]">{medal || `#${idx + 1}`}</div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[11px] font-bold text-[#d8d0c4]">{p.handle}{p.id === me.id ? " (you)" : ""}</span>
                        {p.online && <div className="w-1.5 h-1.5 rounded-full bg-[#00e676] animate-pulse" />}
                        {hasBounty && <span className="text-[9px]">🎯</span>}
                        {p.frozen_until && new Date(p.frozen_until).getTime() > now && <span className="text-[9px]">🧊</span>}
                      </div>
                      <div className="font-mono text-[11px] font-bold text-[#06b6d4] tabular-nums">{fmt(p.net_worth)}</div>
                      <div className="font-mono text-[11px] tabular-nums text-[#f0a500]">{fmt(p.cash)}</div>
                      <div className="w-20"><RepBar value={p.rep} /></div>
                      <div className="font-mono text-[11px] tabular-nums text-[#5c6878]">{p.trade_count}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {tab === "OPS" && (
            <OpsTab
              me={me}
              players={players.filter((p) => !p.is_admin && p.id !== me.id)}
              marketItems={marketItems}
              bounties={conn.bounties}
              myLoan={conn.myLoan}
              gameId={game.id}
              now={now}
              onPlaceBounty={async (targetId, amount) => {
                try { await conn.placeBounty(targetId, amount); notify("🎯 BOUNTY PLACED"); }
                catch (e) { notify(`✗ ${(e as Error).message}`); }
              }}
              onTargetBlackout={async (targetId) => {
                try { await conn.targetBlackout(targetId); notify("📡 BLACKOUT SENT"); }
                catch (e) { notify(`✗ ${(e as Error).message}`); }
              }}
              onPumpItem={async (itemId) => {
                try { await conn.pumpItem(itemId); notify("📈 PUMP INITIATED"); }
                catch (e) { notify(`✗ ${(e as Error).message}`); }
              }}
              onTakeLoan={async (amount) => {
                try { await conn.takeLoan(amount); notify(`💸 BORROWED ${fmt(amount)}`); }
                catch (e) { notify(`✗ ${(e as Error).message}`); }
              }}
              onRepayLoan={async () => {
                try { await conn.repayLoan(); notify("✅ LOAN REPAID"); }
                catch (e) { notify(`✗ ${(e as Error).message}`); }
              }}
              onAssassinate={async (targetId) => {
                try { await conn.assassinatePlayer(targetId); notify("☠️ EXECUTED"); }
                catch (e) { notify(`✗ ${(e as Error).message}`); }
              }}
            />
          )}
        </div>

        <div className="w-64 border-l border-border flex-col overflow-hidden shrink-0 hidden lg:flex">
          <div className={`border-b border-border p-3 shrink-0 ${auction?.is_final ? "bg-[#f0a500]/10 border-[#f0a500]/40" : "bg-[#0d1117]"}`}>
            <div className={`font-mono text-[9px] tracking-[0.3em] mb-2 flex items-center gap-1.5 ${auction?.is_final ? "text-[#f0a500]" : "text-[#5c6878]"}`}>
              <Gavel size={8} />{auction?.is_final ? "🏆 FINAL AUCTION" : "LIVE AUCTION"}
            </div>
            {auction && (
              <>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-xl">{auction.icon}</span>
                  <div><div className={`font-mono text-[11px] font-bold ${auction.is_final ? "text-[#f0a500]" : "text-[#d8d0c4]"}`}>{auction.name}</div><div className="font-mono text-[9px] text-[#5c6878]">{auction.bid_count} bids · {auctionTimeLeft}s left</div></div>
                </div>
                {auction.is_final && <div className="font-mono text-[9px] text-[#f0a500] mb-2 tracking-widest">WIN = ITEM + ₦20,000 BONUS</div>}
                <div className="flex items-baseline justify-between mb-2"><div className="font-mono text-[9px] text-[#5c6878]">CURRENT BID</div><div className="font-mono text-[14px] font-bold text-[#f0a500] tabular-nums">{fmt(auction.current_bid)}</div></div>
                {auction.current_bidder_id === me.id && <div className="font-mono text-[9px] text-[#00e676] mb-2">YOU'RE THE HIGH BIDDER</div>}
                <div className="flex gap-1">
                  <input type="number" value={bidInput} onChange={(e) => setBidInput(e.target.value)} placeholder="Enter bid..." className="flex-1 bg-[#141b24] border border-border text-[#d8d0c4] font-mono text-[10px] px-2 py-1.5 focus:outline-none focus:border-[#f0a500]/60 placeholder-[#2a3444]" />
                  <button onClick={handleBid} className="px-2 py-1.5 bg-[#f0a500]/10 border border-[#f0a500]/40 text-[#f0a500] font-mono text-[9px] hover:bg-[#f0a500]/20 transition-colors">BID</button>
                </div>
              </>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            <div className="sticky top-0 px-3 py-2 bg-[#0d1117] border-b border-border"><div className="font-mono text-[9px] text-[#5c6878] tracking-[0.3em] flex items-center gap-1.5">LIVE FEED</div></div>
            <div className="divide-y divide-border">
              {events.map((ev) => {
                const color = ev.type === "crash" ? "#ff3333" : ev.type === "raid" ? "#ef4444" : ev.type === "tax" ? "#f0a500" : ev.type === "leak" ? "#06b6d4" : ev.type === "blackout" ? "#8b5cf6" : "#5c6878";
                return (
                  <div key={ev.id} className="p-3">
                    <div className="font-mono text-[9px] font-bold tracking-wider mb-1" style={{ color }}>■ {ev.type.toUpperCase()}</div>
                    <div className="font-mono text-[10px] text-[#d8d0c4] leading-relaxed">{ev.text}</div>
                    <div className="font-mono text-[9px] text-[#2a3444] mt-1">{new Date(ev.created_at).toLocaleTimeString()}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-border bg-[#0d1117] py-1.5 overflow-hidden">
        <div className="flex gap-8 animate-[ticker_40s_linear_infinite] whitespace-nowrap">
          {[...marketItems, ...marketItems].map((item, i) => (
            <span key={`${item.id}-${i}`} className="font-mono text-[10px] tabular-nums shrink-0">
              <span className="text-[#5c6878]">{ITEM_META[item.id]?.icon ?? "📦"} {item.name}</span>{" "}
              <span className="text-[#f0a500]">{effectiveBlackout ? "???" : fmt(item.price)}</span>{" "}
              {!effectiveBlackout && <span style={{ color: item.change > 0 ? "#00e676" : item.change < 0 ? "#ff3333" : "#5c6878" }}>{item.change > 0 ? "▲" : item.change < 0 ? "▼" : "—"}{Math.abs(item.change_percent).toFixed(1)}%</span>}
            </span>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes ticker { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #2a3444; }
        ::-webkit-scrollbar-thumb:hover { background: #3a4454; }
      `}</style>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

function AppInner() {
  const conn = useGameConnection();
  const { authReady, session, profile, error, game, me, prefillCode,
          passwordRecoveryMode, publicRooms, roomLoading } = conn;

  // Onboarding overlay — shown once per browser after profile is set up
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (profile && !game && !localStorage.getItem(ONBOARDING_KEY)) {
      setShowOnboarding(true);
    }
  }, [profile, game]);

  // Sounds toggle (header button wires to this)
  const [soundsOn, setSoundsOn] = useState(Sounds.soundsEnabled());

  if (error) {
    return (
      <div className="size-full flex items-center justify-center bg-background" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
        <div className="max-w-md text-center px-6">
          <div className="font-mono text-[12px] text-[#ff3333] mb-2">CONNECTION ERROR</div>
          <div className="font-mono text-[11px] text-[#5c6878]">{error}</div>
        </div>
      </div>
    );
  }

  if (!authReady) return <LoadingScreen label="CONNECTING TO THE BLACK MARKET..." />;

  // Password recovery (after clicking email reset link)
  if (passwordRecoveryMode) {
    return <ResetPasswordScreen onReset={conn.updatePassword} />;
  }

  if (!session) {
    return (
      <AuthScreen
        onSignUp={async (email, password) => {
          const result = await conn.signUp(email, password);
          return result as unknown as boolean;
        }}
        onSignIn={conn.signIn}
        onForgotPassword={conn.requestPasswordReset}
        pendingEmail={localStorage.getItem("bm_pending_confirm")}
        onResendConfirmation={conn.resendConfirmation}
      />
    );
  }

  if (!profile) {
    return <ProfileSetupScreen onComplete={conn.completeProfile} />;
  }

  // Actively joining/hosting a room — show a spinner instead of letting the
  // room-browser flash back up mid-transition (this was the main blank-
  // screen cause: the UI had no state for "request sent, room not loaded yet").
  if (roomLoading) {
    return <LoadingScreen label="ENTERING THE MARKET..." />;
  }

  if (!game || !me) {
    return (
      <>
        {showOnboarding && <OnboardingScreen onComplete={() => setShowOnboarding(false)} />}
        <RoomBrowserScreen
          prefillCode={prefillCode}
          publicRooms={publicRooms}
          onHost={async (isPublic, name) => { await conn.hostRoom(isPublic, name); }}
          onJoin={async (code) => { await conn.enterRoom(code); }}
          onSignOut={conn.signOut}
          onRefreshRooms={conn.refreshPublicRooms}
        />
      </>
    );
  }

  if (me.is_admin) {
    return (
      <AdminPanel
        code={game.code}
        registeredPlayers={conn.players}
        onUpdatePlayerObjective={conn.updatePlayerObjective}
        onRemovePlayer={conn.removePlayer}
        onStartGame={conn.startGame}
        onResetGame={conn.resetGame}
        onLeave={conn.leaveGame}
        onSignOut={conn.signOut}
        onTriggerEvent={conn.triggerEvent}
        onAddNpc={conn.addNpc}
        onAutoAssign={conn.autoAssignObjectives}
        gameStatus={game.status}
      />
    );
  }

  if (game.status === "ended") {
    return (
      <GameOverScreen
        players={conn.players}
        me={me}
        onLeave={conn.leaveGame}
        onNewGame={conn.resetGame}
        isAdmin={me.is_admin}
      />
    );
  }

  if (game.status === "lobby") {
    return <LobbyScreen code={game.code} handle={me.handle} players={conn.players} onLeave={conn.leaveGame} onSignOut={conn.signOut} />;
  }

  return (
    <Game conn={conn} onLogout={conn.leaveGame}
      soundsOn={soundsOn}
      onToggleSounds={() => {
        const next = !soundsOn;
        setSoundsOn(next);
        Sounds.setSoundsEnabled(next);
      }}
    />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}
