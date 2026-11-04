import { Button } from "@/components/ui/button";

export function QueryReadError({
  subject,
  stale,
  onRetry,
  isFetching,
}: {
  subject: "library" | "playlist";
  stale: boolean;
  onRetry: () => void;
  isFetching: boolean;
}) {
  return (
    <div role="alert" className="my-6 rounded-3xl border border-amber-300/20 bg-amber-300/[0.06] p-5 text-white sm:p-6">
      <h2 className="text-lg font-semibold">Could not load your {subject}</h2>
      <p className="mt-2 text-sm text-white/70">
        {stale ? "Showing previously loaded data, which may be out of date. " : ""}
        {subject === "library" ? "Your playlists could not be read." : "This playlist could not be read."} Try again or close other TubeShuffle tabs and reload.
      </p>
      {subject === "playlist" && <p className="mt-2 text-sm text-white/70">Current playback may stop while the playlist cannot be read.</p>}
      <p role="status" className="mt-2 text-sm text-white/70">{isFetching ? "Trying again…" : ""}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" onClick={() => { if (!isFetching) onRetry(); }} aria-disabled={isFetching} className="rounded-full bg-white text-black hover:bg-white/90">
          {isFetching ? "Trying again…" : "Retry"}
        </Button>
        <Button type="button" variant="outline" onClick={() => window.location.reload()} className="rounded-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white">
          Reload page
        </Button>
      </div>
    </div>
  );
}
