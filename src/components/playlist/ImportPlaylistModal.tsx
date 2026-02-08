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
import { trpc } from "@/lib/trpc";
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

  const importMutation = trpc.playlist.import.useMutation({
    onSuccess: (data) => {
      toast.success(`Imported "${data.title}" with ${data.videos.length} videos`);
      setUrl("");
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    importMutation.mutate({ url: url.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import YouTube Playlist</DialogTitle>
          <DialogDescription>
            Paste a YouTube playlist URL to import it. All public playlists are
            supported.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="playlist-url">Playlist URL</Label>
              <div className="relative">
                <LinkIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="playlist-url"
                  placeholder="https://youtube.com/playlist?list=..."
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  className="pl-10"
                  disabled={importMutation.isPending}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Example: https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={importMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!url.trim() || importMutation.isPending}>
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
