"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AccountError, getCsrf, responseError, safeAccountMessage } from "@/lib/services/account-client";

type Link = { youtubePlaylistId: string; createdAt: string };
type Status = "loading" | "signed-out" | "denied" | "ready" | "error";

export function AccountPanel({ appOrigin }: { appOrigin: string }) {
  const [status, setStatus] = useState<Status>("loading");
  const [links, setLinks] = useState<Link[]>([]);
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("");
  const [signInFailed, setSignInFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const signingOutRef = useRef(false);
  const signingInRef = useRef(false);
  const actionRef = useRef(false);

  const invalidate = useCallback(() => {
    ++generation.current;
    controller.current?.abort();
    controller.current = null;
  }, []);

  const load = useCallback(async () => {
    if (signingOutRef.current || actionRef.current) return;
    const current = ++generation.current;
    controller.current?.abort();
    const abort = controller.current = new AbortController();
    setStatus("loading");
    try {
      const response = await fetch("/api/playlist-links", { cache: "no-store", signal: abort.signal });
      if (!response.ok) throw await responseError(response);
      const data = await response.json();
      if (!Array.isArray(data.links)) throw new Error("Account service returned an invalid response.");
      if (current === generation.current) { setLinks(data.links); setStatus("ready"); setMessage(""); }
    } catch (error) {
      if (current !== generation.current || abort.signal.aborted) return;
      setLinks([]);
      setStatus(error instanceof AccountError && error.code === "unauthenticated" ? "signed-out" : error instanceof AccountError && error.code === "forbidden" ? "denied" : "error");
      setMessage(safeAccountMessage(error, "Account service unavailable."));
    }
  }, []);

  useEffect(() => { const version = generation; const active = controller; void load(); return () => { version.current++; active.current?.abort(); }; }, [load]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const values = url.searchParams.getAll("auth_result");
    if (values.length === 1 && values[0] === "failed") setSignInFailed(true);
    if (values.length) {
      url.searchParams.delete("auth_result");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  }, []);

  function signIn(event: FormEvent<HTMLFormElement>) {
    if (signingOutRef.current || actionRef.current) { event.preventDefault(); return; }
    actionRef.current = true;
    signingInRef.current = true;
    setBusy(true); setMessage(""); setSignInFailed(false);
    if (!appOrigin || window.location.origin !== appOrigin) {
      event.preventDefault();
      signingInRef.current = false; actionRef.current = false; setBusy(false);
      setMessage("Could not start sign-in. Please try again.");
    }
  }

  async function signOut() {
    if (signingOutRef.current || signingInRef.current) return;
    signingOutRef.current = true;
    actionRef.current = false;
    invalidate(); setLinks([]); setValue(""); setStatus("signed-out"); setBusy(true); setSigningOut(true); setMessage(""); setSignInFailed(false);
    try {
      const token = await getCsrf();
      const response = await fetch("/api/auth/logout", { method: "POST", headers: { "x-csrf-token": token } });
      if (!response.ok) throw await responseError(response);
      setMessage("Signed out. Your local library stays on this device.");
    } catch { setMessage("Sign-out could not be confirmed. Please retry when the account service is available."); }
    finally { invalidate(); signingOutRef.current = false; setBusy(false); setSigningOut(false); }
  }

  async function changeLink(id: string, remove: boolean) {
    if (signingOutRef.current || actionRef.current) return;
    actionRef.current = true;
    const current = generation.current;
    controller.current?.abort();
    const abort = controller.current = new AbortController();
    setBusy(true); setMessage("");
    try {
      const token = await getCsrf(abort.signal);
      if (current !== generation.current || abort.signal.aborted) return;
      const response = await fetch(remove ? `/api/playlist-links/${encodeURIComponent(id)}` : "/api/playlist-links", {
        method: remove ? "DELETE" : "POST", signal: abort.signal,
        headers: { "x-csrf-token": token, ...(remove ? {} : { "Content-Type": "application/json" }) },
        ...(!remove ? { body: JSON.stringify({ playlistId: id }) } : {}),
      });
      if (!response.ok) throw await responseError(response);
      if (current === generation.current && !abort.signal.aborted) { setValue(""); actionRef.current = false; setBusy(false); await load(); }
    } catch (error) {
      if (current === generation.current && !abort.signal.aborted) {
        if (error instanceof AccountError && (error.code === "unauthenticated" || error.code === "forbidden")) {
          invalidate(); actionRef.current = false; setBusy(false); setLinks([]); setValue(""); setStatus(error.code === "unauthenticated" ? "signed-out" : "denied");
        }
        setMessage(safeAccountMessage(error, "Could not update saved links."));
      }
    } finally { if (!signingOutRef.current && current === generation.current) { actionRef.current = false; setBusy(false); } }
  }

  const button = "rounded-full border border-white/20 px-4 py-2 text-sm font-semibold transition hover:bg-white/10 disabled:opacity-40";
  return <section aria-labelledby="account-heading" className="mt-6 rounded-[2rem] border border-white/10 bg-white/[0.045] p-6 text-white">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-200/60">Account</p><h2 id="account-heading" className="mt-2 text-xl font-bold">Saved playlist links</h2><p className="mt-1 max-w-xl text-sm text-white/55">Only links you choose to save are kept in your account. Playlist contents and listening history stay on this device.</p></div>
      <div className="flex flex-wrap gap-2">{status === "signed-out" || status === "error" ? <form action="/api/auth/start" method="get" target="_self" onSubmit={signIn}><button type="submit" className={button} disabled={busy}>Sign in with Google</button></form> : null}{status === "ready" || status === "denied" || status === "error" || (status === "signed-out" && message.includes("could not be confirmed")) ? <button type="button" className={button} disabled={signingOut} onClick={signOut}>Sign out</button> : null}</div>
    </div>
    {status === "loading" && <p className="mt-4 text-sm text-white/55" role="status">Checking account…</p>}
    {status === "denied" && <p className="mt-4 text-sm text-amber-100">This Google account is not authorized. Sign out and try another account.</p>}
    {signInFailed && <p className="mt-4 text-sm text-amber-100" role="status">Sign-in could not be completed. Please try again. If you are already signed in, sign out first to try another account.</p>}
    {message && status !== "denied" && <p className="mt-4 text-sm text-amber-100" role="status">{message}</p>}
    {status === "error" && <button type="button" className={`${button} mt-4`} disabled={signingOut} onClick={() => void load()}>Retry account</button>}
    {status === "ready" && <div className="mt-5 border-t border-white/10 pt-5">
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (value.trim()) void changeLink(value, false); }}>
        <label htmlFor="account-link" className="sr-only">YouTube playlist link or ID</label><input id="account-link" value={value} onChange={(event) => setValue(event.target.value)} placeholder="YouTube playlist link or ID" className="min-w-0 flex-1 rounded-full border border-white/15 bg-black/20 px-4 py-2 text-sm outline-none focus:border-amber-200/70" /><button disabled={busy || !value.trim()} className={`${button} bg-white text-black hover:bg-white/90`}>Save link</button>
      </form>
      <p className="mt-2 text-xs text-white/45">Saving a link does not import its videos or upload your local library.</p>
      {links.length === 0 ? <p className="mt-5 text-sm text-white/50">No saved links yet.</p> : <ul className="mt-4 divide-y divide-white/10">{links.map((link) => <li key={link.youtubePlaylistId} className="flex items-center justify-between gap-3 py-3"><span className="min-w-0 break-all font-mono text-sm text-white/75">{link.youtubePlaylistId}</span><button type="button" disabled={busy} className={button} onClick={() => void changeLink(link.youtubePlaylistId, true)} aria-label={`Remove saved link ${link.youtubePlaylistId}`}>Unlink</button></li>)}</ul>}
      <p className="mt-3 text-xs text-white/45">Unlinking never deletes your local playlist or history.</p>
    </div>}
  </section>;
}
