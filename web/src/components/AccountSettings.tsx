import { useEffect, useState } from "react";
import type { CookieStatus } from "@bc/core";
import { useAccount, useAccountMutations, useCollectionRefresh, useCollectionRefreshMutation, useJobs } from "../api/queries";
import { friendlyError } from "../lib/errors";
import { ConfirmButton } from "./ConfirmButton";
import { JobProgress } from "./JobProgress";

const COOKIE_LINES: Record<CookieStatus, { text: string; error?: boolean } | null> = {
  none: null,
  unchecked: { text: "Cookie saved. The next sync checks it with Bandcamp." },
  ok: { text: "Bandcamp accepted the cookie on the last sync." },
  rejected: { text: "Bandcamp didn't accept the cookie on the last sync. It has probably expired: paste a fresh one.", error: true },
  other_account: { text: "The cookie belongs to a different Bandcamp account than this username, so it isn't used.", error: true },
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Settings → Bandcamp account: username, optional identity cookie, sync. */
export function AccountSettings() {
  const { data: account } = useAccount();
  const { data: jobs } = useJobs();
  const { setUsername, setCookie, clear, sync } = useAccountMutations();
  const [username, setUsernameText] = useState("");
  const [cookie, setCookieText] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setUsernameText(account?.username ?? ""); }, [account?.username]);

  const job = jobs?.find((j) => j.kind === "collection");
  const busy = setUsername.isPending || setCookie.isPending || sync.isPending || (!!job && (job.status === "pending" || job.status === "queued" || job.status === "running"));

  const syncNow = async () => {
    setError(null);
    try {
      if (username.trim() !== (account?.username ?? "")) await setUsername.mutateAsync(username);
      if (cookie.trim()) { await setCookie.mutateAsync(cookie); setCookieText(""); }
      await sync.mutateAsync();
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const last = account?.lastSync;
  const cookieLine = account?.hasCookie ? COOKIE_LINES[last?.cookie ?? "unchecked"] : null;
  return (
    <section id="account">
      <h2>Bandcamp account</h2>
      <p className="muted">Bring what you bought and your wishlist into the library. A public collection needs only your username. Albums you remove from the library stay out on later syncs.</p>
      <div className="field-row">
        <label>Username
          <input value={username} placeholder="bandcamp.com/username" spellCheck={false} autoCapitalize="off" autoCorrect="off"
            onChange={(e) => setUsernameText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) void syncNow(); }} />
        </label>
        <label>Identity cookie <span className="muted">optional</span>
          <input type="password" value={cookie} autoComplete="new-password" spellCheck={false}
            placeholder={account?.hasCookie ? "Saved. Paste a new one to replace it" : "Value of the identity cookie"}
            onChange={(e) => setCookieText(e.target.value)} />
        </label>
      </div>
      <p className="muted">
        With the cookie from a logged-in browser, the sync also sees a private collection and your purchases stream as MP3 V0
        instead of 128 kbps. It stays in this Mac's library database and is only ever sent to bandcamp.com.
      </p>
      <div className="row">
        <button className="btn primary" disabled={busy || !username.trim()} onClick={() => void syncNow()}>{busy ? "Syncing…" : "Sync now"}</button>
        {account?.hasCookie && (
          <ConfirmButton label="Remove cookie" confirmLabel="Remove" question="Remove the saved identity cookie?" onConfirm={async () => { await setCookie.mutateAsync(null); }} />
        )}
        {(account?.username || account?.hasCookie) && (
          <ConfirmButton label="Remove account" confirmLabel="Remove account" question="Forget the username, cookie and Purchased/Wishlist marks? Albums stay in the library."
            onConfirm={async () => { await clear.mutateAsync(); setUsernameText(""); setCookieText(""); }} />
        )}
      </div>
      {error && <div className="notice error" style={{ marginTop: 12 }}>{error}</div>}
      {last && (
        <p className="muted">
          Last synced {new Date(last.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}:{" "}
          {plural(last.collection, "purchase", "purchases")} and {plural(last.wishlist, "wishlist item", "wishlist items")}.
          {!last.complete && (last.authenticated && last.cookie === "none"
            ? " Signed out: items no longer listed weren't removed. Add your cookie and sync to update."
            : last.authenticated && last.cookie !== "ok"
              ? " This sync couldn't sign in, so nothing was removed from Purchased or Wishlist."
              : " Bandcamp stopped paging early, so items that left your lists were kept.")}
        </p>
      )}
      {cookieLine && <p className={cookieLine.error ? "error" : "muted"}>{cookieLine.text}</p>}
      {job && <JobProgress job={job} compact />}
      {account?.username && <AutoRefresh />}
    </section>
  );
}

/** The background refresh toggle and when it last ran. */
function AutoRefresh() {
  const { data: status } = useCollectionRefresh();
  const setEnabled = useCollectionRefreshMutation();
  const on = setEnabled.isPending ? setEnabled.variables : (status?.enabled ?? true);
  const last = status?.last_auto_at ? new Date(status.last_auto_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <>
      <label className="check-row">
        <input type="checkbox" checked={on} disabled={!status || setEnabled.isPending} onChange={(e) => setEnabled.mutate(e.target.checked)} />
        Sync automatically once a day
      </label>
      <p className="muted">
        While the app is open and no import is running, a few minutes after launch at the earliest.
        {" "}{last ? `Last automatic sync ${last}.` : "No automatic sync yet."}
      </p>
    </>
  );
}
