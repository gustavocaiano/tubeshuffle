"use client";

import { useRef, useState } from "react";
import { useBrowserStorage } from "@/hooks/use-browser-storage";
import { confirmBrowserStorageCreation, recheckBrowserStorage } from "@/lib/storage/browser-session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function BrowserStorageNotice() {
  const storage = useBrowserStorage();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  if (storage.phase === "ready") return null;

  const waiting = ["unknown", "checking", "existing", "initializing", "creating", "created"].includes(storage.phase);
  const canRecheck = ["missing", "recheck-required", "incompatible", "metadata-error", "marker-failed", "existing-unverified"].includes(storage.phase);
  const message = storageMessage(storage.phase, waiting);

  async function run(create: boolean) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setConfirming(false);
    try { await (create ? confirmBrowserStorageCreation() : recheckBrowserStorage()); }
    catch { /* The shared state supplies the safe, actionable outcome. */ }
    finally { inFlight.current = false; setBusy(false); }
  }

  return <section role={waiting ? "status" : "alert"} className="my-6 space-y-3 rounded-2xl border border-white/15 bg-white/5 p-5 text-sm leading-relaxed text-white/80">
    <p>{message}</p>
    <div className="flex flex-wrap gap-2">
      {canRecheck && <Button variant="outline" disabled={busy} onClick={() => void run(false)}>Check existing library again</Button>}
      {storage.eligibleForConfirmation && <Button disabled={busy} onClick={() => setConfirming(true)}>Create an empty library…</Button>}
    </div>
    <Dialog open={confirming && storage.eligibleForConfirmation} onOpenChange={setConfirming}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a new empty library?</DialogTitle>
          <DialogDescription>This creates a library in this browser profile. It does not recover an older library, copy legacy data or restore missing history. Cancel if you expected existing playlists.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => void run(true)}>Confirm empty library</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}

function storageMessage(phase: string, waiting: boolean): string {
  switch (phase) {
    case "missing": return "No local library was found in this browser profile. This does not prove first use. If you expected a library, keep this profile and its site data and check that you opened the right browser and address.";
    case "marker-failed": return "Local metadata was saved, but the browser marker could not be saved. These are separate storage systems. Your library has not been rolled back.";
    case "metadata-error": return "The browser’s local settings could not be read. Library access is paused. Keep this profile and its site data.";
    case "recheck-required": return "Another browser context changed the storage connection. Check the existing library again before continuing. A pending write may already have finished; it will not be repeated automatically.";
    case "draining": return "Another browser tab is holding a storage connection. Close the other TubeShuffle tabs and wait for the current request to finish.";
    case "incompatible": return "This library is not compatible with this version. Keep its data intact and use the version that created it. No repair or upgrade was attempted.";
    default: return waiting ? "Checking your local library…" : "Local storage could not be confirmed. Keep this profile and its site data. Library actions are paused; no automatic repair will run.";
  }
}
