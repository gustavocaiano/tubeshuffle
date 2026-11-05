export function QueryReadError({
  subject,
  stale,
}: {
  subject: "library" | "playlist";
  stale: boolean;
}) {
  return (
    <div role="alert" className="my-6 rounded-3xl border border-amber-300/20 bg-amber-300/[0.06] p-5 text-white sm:p-6">
      <h2 className="text-lg font-semibold">Could not confirm your {subject}</h2>
      <p className="mt-2 text-sm text-white/70">
        {stale ? "Showing previously loaded data, which may be out of date. " : ""}
        Keep this browser profile and do not clear its site data.
      </p>
      {subject === "playlist" && <p className="mt-2 text-sm text-white/70">Current playback may stop while the playlist cannot be read.</p>}
    </div>
  );
}
