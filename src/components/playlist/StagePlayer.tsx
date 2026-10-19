"use client";

import Image from "next/image";
import { Minimize2 } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { PlaybackControls } from "@/components/playlist/PlaybackControls";
import { usePlayerStore } from "@/stores/player-store";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";

export function StagePlayer() {
  const { currentVideo, queue, currentIndex } = usePlayerStore();
  const { fullWindowMode, hideThumbnails, setFullWindowMode } =
    useUiPreferencesStore();
  const showArtwork = Boolean(currentVideo?.thumbnail && !hideThumbnails);

  return (
    <DialogPrimitive.Root
      open={fullWindowMode}
      onOpenChange={setFullWindowMode}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-[#080807]" />
        <DialogPrimitive.Content
          data-stage-player
          className="fixed inset-0 z-[101] flex flex-col overflow-y-auto bg-[#080807] text-white outline-none"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("enter-stage")?.focus();
          }}
        >
          {showArtwork && (
            <div
              className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-20 blur-3xl"
              style={{ backgroundImage: `url(${currentVideo!.thumbnail})` }}
            />
          )}
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.08),transparent_65%)]" />
          <header className="relative flex shrink-0 items-center justify-between gap-4 px-6 py-5 sm:px-10">
            <div>
              <DialogPrimitive.Title className="text-sm font-semibold">
                Stage
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1 text-xs text-white/50">
                {queue.length
                  ? `Track ${currentIndex + 1} of ${queue.length}`
                  : "Ready to listen"}
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                variant="outline"
                className="min-h-11 rounded-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
              >
                <Minimize2 className="size-4" />
                Exit Stage
                <span className="ml-1 hidden text-xs text-white/45 sm:inline">
                  Esc
                </span>
              </Button>
            </DialogPrimitive.Close>
          </header>
          <div className="relative mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center gap-8 px-6 py-8 text-center">
            {showArtwork && (
              <div className="relative size-[min(36vh,320px)] shrink-0 overflow-hidden rounded-3xl shadow-2xl shadow-black/50 outline outline-white/10">
                <Image
                  src={currentVideo!.thumbnail}
                  alt=""
                  fill
                  sizes="320px"
                  className="object-cover"
                />
              </div>
            )}
            <div className="max-w-3xl space-y-4">
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-white/45">
                Now playing
              </p>
              <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-5xl">
                {currentVideo?.title ?? "Choose a track to start listening"}
              </h2>
              <p className="text-base text-white/60 sm:text-xl">
                {currentVideo?.channelTitle}
              </p>
            </div>
          </div>
          <footer className="relative shrink-0 px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-4 sm:px-10">
            <PlaybackControls stage />
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
