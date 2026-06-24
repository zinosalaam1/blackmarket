export const MARKET_CATALOG = [
  { item_key: "batteries", name: "Batteries", tier: "common", base_price: 120, icon: "🔋", is_illegal: false },
  { item_key: "electronics", name: "Electronics", tier: "common", base_price: 340, icon: "📱", is_illegal: false },
  { item_key: "gold", name: "Gold", tier: "common", base_price: 1000, icon: "🥇", is_illegal: false },
  { item_key: "fuel", name: "Fuel Cells", tier: "common", base_price: 280, icon: "⚗️", is_illegal: false },
  { item_key: "ancient_coins", name: "Ancient Coins", tier: "rare", base_price: 2800, icon: "🪙", is_illegal: false },
  { item_key: "crypto_keys", name: "Crypto Keys", tier: "rare", base_price: 4200, icon: "🔑", is_illegal: false },
  { item_key: "lost_docs", name: "Lost Documents", tier: "rare", base_price: 3600, icon: "📄", is_illegal: false },
  { item_key: "bio_sample", name: "Bio Sample", tier: "rare", base_price: 5100, icon: "🧬", is_illegal: true },
  { item_key: "red_diamond", name: "Red Diamond", tier: "legendary", base_price: 18000, icon: "💎", is_illegal: false },
  { item_key: "gov_secrets", name: "Gov. Secrets", tier: "legendary", base_price: 22000, icon: "🗂️", is_illegal: true },
  { item_key: "quantum_chip", name: "Quantum Chip", tier: "legendary", base_price: 31000, icon: "⚡", is_illegal: false },
];

export const RUMOR_CATALOG = [
  { text: "Red Diamond reserves discovered in Sector 7. Price may collapse 60%.", credibility: "???", cost: 500 },
  { text: "Government raid on illegal electronics scheduled for next phase.", credibility: "HOT", cost: 1200 },
  { text: "Quantum Chip shortage incoming — three suppliers went dark overnight.", credibility: "COLD", cost: 800 },
  { text: "Broker alliance coordinating a Gold pump. Insiders say buy now.", credibility: "???", cost: 600 },
  { text: "Ancient Coins are all counterfeits. Seller is running a long con.", credibility: "HOT", cost: 950 },
  { text: "Market Collapse event triggers in 8 minutes. Prepare.", credibility: "???", cost: 2000 },
];

export const LIVE_EVENTS_POOL = [
  { type: "crash", text: "MARKET CRASH — Gold prices dropped 40% after false reserve report" },
  { type: "raid", text: "GOVERNMENT RAID — illegal goods seized from an unknown seller" },
  { type: "leak", text: "INFORMATION LEAK — a player's inventory was exposed to all players" },
  { type: "tax", text: "TAX COLLECTION — top 5 wealthiest players lost 15% of cash holdings" },
  { type: "neutral", text: "NEW CONTRACT — a bounty was offered for delivery of a Quantum Chip" },
  { type: "crash", text: "PANIC SELL — Crypto Keys down sharply in seconds" },
  { type: "raid", text: "INVESTIGATION — a trader is under suspicion. Trading suspended." },
  { type: "leak", text: "RUMOR CONFIRMED — the Quantum Chip shortage is real" },
  { type: "blackout", text: "BLACKOUT EVENT — all price data hidden for 60 seconds" },
  { type: "neutral", text: "ALLIANCE FORMED — a coalition is now active" },
  { type: "tax", text: "COUNTERFEIT CRISIS — a chunk of electronics in market are fakes" },
];

export const ALL_OBJECTIVES = [
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

export const AUCTION_CATALOG = [
  { name: "Golden Passport", icon: "🛂" },
  { name: "Encrypted Hard Drive", icon: "💽" },
  { name: "Diplomatic Pouch", icon: "📨" },
  { name: "Forged Masterpiece", icon: "🖼️" },
  { name: "Black Box Recorder", icon: "🛰️" },
];

export function initHistory(base: number, len = 30): number[] {
  const h: number[] = [base];
  for (let i = 1; i < len; i++) {
    const prev = h[i - 1];
    const delta = prev * (Math.random() * 0.1 - 0.05);
    h.push(Math.max(1, Math.round(prev + delta)));
  }
  return h;
}
