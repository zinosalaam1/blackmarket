import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Admin client — uses the service role key, bypasses RLS.
 * Every Edge Function uses this for all reads/writes. Authorization is
 * enforced manually in each function (see getCallerPlayer below), NOT by
 * Postgres RLS, since these functions are the only privileged write path.
 */
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

/**
 * Resolves the calling user's auth.uid() from the request's bearer token.
 * Throws if the request has no valid session — every game action requires
 * the player to be signed in (anonymous auth is fine).
 */
export async function getCallerUserId(req: Request): Promise<string> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Missing Authorization header");
  const token = authHeader.replace("Bearer ", "");

  const client = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) throw new Error("Invalid session");
  return data.user.id;
}

/**
 * Loads the player row for the caller within a specific game, optionally
 * requiring admin privileges. This is the core authorization check used by
 * almost every mutating function.
 */
export async function getCallerPlayer(
  db: SupabaseClient,
  req: Request,
  gameId: string,
  opts: { requireAdmin?: boolean } = {},
) {
  const userId = await getCallerUserId(req);
  const { data: player, error } = await db
    .from("players")
    .select("*")
    .eq("game_id", gameId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!player) throw new Error("You are not a player in this game");
  if (opts.requireAdmin && !player.is_admin) {
    throw new Error("Admin privileges required");
  }
  return player;
}

export function generateGameCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}
