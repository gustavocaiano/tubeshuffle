"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Link as LinkIcon } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { playlistRepository } from "@/stores/playlist-store";
import { toast } from "sonner";

interface ImportPlaylistModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

export function ImportPlaylistModal({
  open,
  onOpenChange,
  onSuccess,
}: ImportPlaylistModalProps) {
  const [url, setUrl] = useState("");

  const importMutation = useMutation({
    mutationFn: (playlistUrl: string) =>
      playlistRepository.importPlaylistFromUrl(playlistUrl),
    onSuccess: (data) => {
      toast.success(
        `Imported "${data.playlist.title}" with ${data.videos.length} videos`
      );
      setUrl("");
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    importMutation.mutate(url.trim());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-[#11100e]/95 text-white shadow-2xl shadow-black/40 backdrop-blur-xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import YouTube Playlist</DialogTitle>
          <DialogDescription className="text-white/55">
            Paste a YouTube playlist URL to import it. All public playlists are
            supported.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="playlist-url">Playlist URL</Label>
              <div className="relative">
                <LinkIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/45" />
                <Input
                  id="playlist-url"
                  placeholder="https://youtube.com/playlist?list=..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="border-white/10 bg-black/20 pl-10 text-white placeholder:text-white/40 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0"
                  disabled={importMutation.isPending}
                />
              </div>
              <p className="text-xs text-white/45">
                Example: https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
              onClick={() => onOpenChange(false)}
              disabled={importMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-white text-black hover:bg-white/90"
              disabled={!url.trim() || importMutation.isPending}
            >
              {importMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Importing...
                </>
              ) : (
                "Import Playlist"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
