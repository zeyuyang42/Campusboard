import type { Db } from "../db/Db.js";
import { deleteSetting, getSetting, setSetting } from "../db/repos/settings.js";
import { clearFanItems, recomputeOwned } from "../db/repos/fanItems.js";
import { cancelJobsOfKind } from "../db/repos/jobs.js";
import { mayCarryIdentity, normalizeFanUsername } from "../scrape/fan.js";
import { ScrapeError } from "../scrape/errors.js";
import type { AccountInfo, SyncSummary } from "../types.js";
import { COLLECTION_REFRESH_LAST_KEY } from "../config.js";

/** settings keys. The cookie has a key of its own so nothing that reads the account reads it by accident. */
export const ACCOUNT_KEY = "bandcamp_account";
export const IDENTITY_KEY = "bandcamp_identity";
export const SYNC_KEY = "bandcamp_sync";

/** RFC 6265 cookie-octets: no whitespace, quotes, commas, semicolons or backslashes. */
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const COOKIE_MAX = 4096;

/**
 * Accept the identity cookie's value, `identity=<value>`, or a whole Cookie header
 * copied from the browser (only the identity part is kept). Errors never echo the input.
 */
export function normalizeIdentityCookie(input: string): string {
  let v = input.trim();
  const m = v.match(/(?:^|;\s*)identity=([^;]*)/);
  if (m) v = m[1].trim();
  else if (v.includes("=") && /[;\s]/.test(v)) throw new ScrapeError("invalid_cookie", "No identity cookie in what was pasted");
  if (v.startsWith('"') && v.endsWith('"') && v.length > 1) v = v.slice(1, -1);
  if (!v || v.length > COOKIE_MAX || !COOKIE_OCTETS.test(v)) throw new ScrapeError("invalid_cookie", "That doesn't look like a cookie value");
  return v;
}

export async function getAccount(db: Db): Promise<AccountInfo> {
  const [acc, identity, last] = await Promise.all([
    getSetting<{ username?: string }>(db, ACCOUNT_KEY),
    getSetting<string>(db, IDENTITY_KEY),
    getSetting<SyncSummary>(db, SYNC_KEY),
  ]);
  return { username: acc?.username ?? null, hasCookie: !!identity, lastSync: last ?? null };
}

/**
 * Forget what was synced for a previous account, in an order that leaves flags consistent.
 * The sync job is cancelled first: its writes are conditional on still running, so nothing
 * it does afterwards can bring the lists or the summary back.
 */
async function forgetSync(db: Db): Promise<void> {
  await cancelJobsOfKind(db, "collection");
  await deleteSetting(db, SYNC_KEY);
  await clearFanItems(db);
  await recomputeOwned(db);
}

/** Save the username. A different username drops the previous account's synced lists and flags. */
export async function setUsername(db: Db, input: string): Promise<AccountInfo> {
  const username = normalizeFanUsername(input);
  const prev = (await getSetting<{ username?: string }>(db, ACCOUNT_KEY))?.username;
  if (prev && prev.toLowerCase() !== username.toLowerCase()) await forgetSync(db);
  await setSetting(db, ACCOUNT_KEY, { username });
  return getAccount(db);
}

/** Store the identity cookie (validated) or remove it with null. A stored cookie counts as not yet checked. */
export async function setIdentityCookie(db: Db, input: string | null): Promise<AccountInfo> {
  const removing = input === null || !input.trim();
  if (removing) await deleteSetting(db, IDENTITY_KEY);
  else await setSetting(db, IDENTITY_KEY, normalizeIdentityCookie(input));
  const last = await getSetting<SyncSummary>(db, SYNC_KEY);
  if (last) await setSetting(db, SYNC_KEY, { ...last, cookie: removing ? "none" : "unchecked" });
  return getAccount(db);
}

/**
 * Remove the account: stop any sync, then the cookie (the secret), then the synced lists
 * and flags, then the username.
 */
export async function clearAccount(db: Db): Promise<AccountInfo> {
  await cancelJobsOfKind(db, "collection");
  await deleteSetting(db, IDENTITY_KEY);
  await forgetSync(db);
  // The next account gets its first automatic sync at the next look, not up to a day later.
  await deleteSetting(db, COLLECTION_REFRESH_LAST_KEY);
  await deleteSetting(db, ACCOUNT_KEY);
  return getAccount(db);
}

/** Settings keys core's generic getSetting/setSetting refuse; they have their own functions here. */
export const PRIVATE_SETTING_KEYS: ReadonlySet<string> = new Set([ACCOUNT_KEY, IDENTITY_KEY, SYNC_KEY]);

/**
 * The Cookie header for `url`, or nothing. Only https bandcamp.com and *.bandcamp.com
 * get it, never a custom domain (any host can claim to be one). Once a sync found that
 * Bandcamp doesn't accept it, only the fan page still gets it (`revalidate`), so the
 * next sync can find it working again without sending it with every album fetch.
 */
export async function identityHeaders(db: Db, url: string, opts: { revalidate?: boolean } = {}): Promise<Record<string, string>> {
  if (!mayCarryIdentity(url)) return {};
  const identity = await getSetting<string>(db, IDENTITY_KEY);
  if (!identity) return {};
  if (!opts.revalidate) {
    const last = await getSetting<SyncSummary>(db, SYNC_KEY);
    if (last && (last.cookie === "rejected" || last.cookie === "other_account")) return {};
  }
  return { Cookie: `identity=${identity}` };
}
