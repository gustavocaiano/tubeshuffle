"use client";

import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { exportBrowserLibrary, type Diagnostic } from "@/lib/transfer/export";

type Feedback = { type: "error" | "success"; message: string; diagnostics?: Diagnostic[]; remaining?: number };

export function ExportLibrary() {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const inFlight = useRef(false);

  async function exportLibrary() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const result = await exportBrowserLibrary();
      if (!result.ok) {
        setFeedback({
          type: "error",
          message: result.requiredBytes
            ? `The library is too large to export (approximately ${(result.requiredBytes / 1048576).toFixed(1)} MB; the limit is 10 MB). No download was started.`
            : "Some local records could not be exported. No file was downloaded. Keep your browser data and review the details below.",
          diagnostics: result.diagnostics.slice(0, 10),
          remaining: result.omittedDiagnostics + Math.max(0, result.diagnostics.length - 10),
        });
        return;
      }
      const url = URL.createObjectURL(new Blob([result.json], { type: "application/json" }));
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `tubeshuffle-library-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); }
      } finally {
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      const count = result.omittedOrphans.length;
      setFeedback({ type: "success", message: `Your download was started. ${count} history ${count === 1 ? "entry was" : "entries were"} omitted because the linked playlist or video is missing or does not match. Check your browser downloads for the JSON file.` });
    } catch {
      setFeedback({ type: "error", message: "Could not read or download your library. No export was completed. Check that browser storage and downloads are available, then try again; keep your browser data intact." });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!inFlight.current) setOpen(nextOpen); }}>
      <DialogTrigger asChild>
        <Button variant="outline" className="rounded-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white">
          <Download className="mr-2 h-4 w-4" aria-hidden="true" /> Export library
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" showCloseButton={!busy} onEscapeKeyDown={(event) => { if (inFlight.current) event.preventDefault(); }} onPointerDownOutside={(event) => { if (inFlight.current) event.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>Export your local library</DialogTitle>
          <DialogDescription>Download a JSON copy of the library stored in this browser, including an empty library.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm leading-relaxed text-white/75">
          <p><strong className="text-white">Included:</strong> current local playlists, video metadata and valid play history, including watch timestamps and completion information.</p>
          <p><strong className="text-white">Not included:</strong> account credentials, video or audio media, queue, preferences, suggestions and the legacy database. Playlist and video text is included as stored, so review the file before sharing it.</p>
          <p>History without a matching playlist and video is omitted and counted. Earlier duplicate video occurrences may already have been overwritten; previously lost data cannot be recovered by this export.</p>
          <p>The JSON file is unencrypted. Depending on your browser settings, downloads may be synced or shared. A started download does not prove the file was saved; check your browser downloads. Browser restore is not available yet.</p>
        </div>
        {feedback && (
          <div role={feedback.type === "error" ? "alert" : "status"} className="rounded-2xl border border-white/15 bg-white/5 p-4 text-sm leading-relaxed text-white/85">
            <p>{feedback.message}</p>
            {!!feedback.diagnostics?.length && <ul className="mt-2 list-inside list-disc break-words text-white/65">{feedback.diagnostics.map((item, index) => <li key={index}>{item.kind}{item.id ? ` (${item.id})` : ""}: {item.reason}</li>)}</ul>}
            {!!feedback.remaining && <p className="mt-2">{feedback.remaining} more issues not shown.</p>}
          </div>
        )}
        <DialogFooter>
          <Button onClick={exportLibrary} disabled={busy} className="rounded-full bg-white text-black hover:bg-white/90">
            {busy ? "Preparing export…" : "Download JSON"}
          </Button>
        </DialogFooter>
        <span className="sr-only" role="status">{busy ? "Preparing your library export." : ""}</span>
      </DialogContent>
    </Dialog>
  );
}
