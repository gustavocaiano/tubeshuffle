"use client";

import { useEffect, useState } from "react";
import { Keyboard, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { usePlaybackStore } from "@/stores/playback-store";

const shortcuts = [
  { keys: ["Space", "K"], action: "Play or pause" },
  { keys: ["J"], action: "Previous track, or restart after five seconds" },
  { keys: ["L"], action: "Next track" },
  { keys: ["?"], action: "Open this shortcut guide" },
  { keys: ["Esc"], action: "Exit Stage player" },
];

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);
  const connectMediaKeys = usePlaybackStore((state) => state.connectMediaKeys);
  const disconnectMediaKeys = usePlaybackStore(
    (state) => state.disconnectMediaKeys,
  );
  const mediaKeysStatus = usePlaybackStore((state) => state.mediaKeysStatus);

  let mediaButtonLabel = "Connect media keys";
  if (mediaKeysStatus === "connected")
    mediaButtonLabel = "Disconnect media keys";
  if (mediaKeysStatus === "connecting") mediaButtonLabel = "Connecting…";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        event.preventDefault();
        setOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 gap-2 border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
        >
          <Keyboard className="h-4 w-4" />
          Shortcuts & media keys
        </Button>
      </DialogTrigger>
      <DialogContent className="z-[120] max-h-[calc(100dvh-2rem)] overflow-y-auto border-white/10 bg-[#11100e]/95 text-white shadow-2xl shadow-black/40 backdrop-blur-xl">
        <DialogHeader>
          <DialogTitle>Playback controls</DialogTitle>
          <DialogDescription className="text-white/55">
            Fast controls work while you are not typing in a form field.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 rounded-2xl bg-white/5 p-4">
          <p className="text-sm font-semibold">
            macOS & keyboard media buttons
          </p>
          <p className="text-sm leading-relaxed text-white/55">
            Play, pause, previous and next use your browser’s media controls.
            Start a track first. If the buttons control YouTube instead of your
            queue, try connecting them below.
          </p>
          <Button
            variant="outline"
            className="min-h-11 border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
            onClick={() => {
              if (mediaKeysStatus === "connected") disconnectMediaKeys?.();
              else void connectMediaKeys?.();
            }}
            disabled={!connectMediaKeys || mediaKeysStatus === "connecting"}
          >
            <Radio className="size-4" />
            {mediaButtonLabel}
          </Button>
          <p role="status" className="text-xs leading-relaxed text-white/45">
            {mediaKeysStatus === "unavailable"
              ? "Your browser could not connect. Start playback and try again, or use the shortcuts below."
              : "This uses a silent audio connection for this visit. Browser and macOS support may vary."}
          </p>
        </div>
        <div className="space-y-3">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.action}
              className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.05] p-3"
            >
              <span className="text-sm text-white/55">{shortcut.action}</span>
              <div className="flex flex-wrap justify-end gap-1.5">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded-md border border-white/10 bg-white/10 px-2 py-1 font-mono text-xs font-semibold text-white shadow-sm"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
