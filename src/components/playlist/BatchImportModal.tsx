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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { playlistRepository } from "@/stores/playlist-store";
import { toast } from "sonner";

interface BatchImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

interface ImportResult {
  url: string;
  status: "pending" | "importing" | "success" | "error";
  message?: string;
}

export function BatchImportModal({
  open,
  onOpenChange,
  onSuccess,
}: BatchImportModalProps) {
  const [urls, setUrls] = useState("");
  const [results, setResults] = useState<ImportResult[]>([]);
  const [isImporting, setIsImporting] = useState(false);

  const handleSubmit = async () => {
    const urlList = urls
      .split("\n")
      .map((u) => u.trim())
      .filter((u) => u.length > 0);

    if (urlList.length === 0) return;

    setIsImporting(true);
    const importResults: ImportResult[] = urlList.map((url) => ({
      url,
      status: "pending",
    }));
    setResults(importResults);

    for (let i = 0; i < importResults.length; i++) {
      importResults[i].status = "importing";
      setResults([...importResults]);

      try {
        await playlistRepository.importPlaylistFromUrl(importResults[i].url);
        importResults[i].status = "success";
        importResults[i].message = "Imported successfully";
      } catch (error) {
        importResults[i].status = "error";
        importResults[i].message =
          error instanceof Error ? error.message : "Failed to import";
      }

      setResults([...importResults]);
    }

    setIsImporting(false);

    const successCount = importResults.filter(
      (r) => r.status === "success"
    ).length;
    if (successCount > 0) {
      toast.success(`Successfully imported ${successCount} playlist(s)`);
      onSuccess?.();
    }
  };

  const handleClose = () => {
    if (!isImporting) {
      setUrls("");
      setResults([]);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="border-white/10 bg-[#11100e]/95 text-white shadow-2xl shadow-black/40 backdrop-blur-xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Batch Import Playlists</DialogTitle>
          <DialogDescription className="text-white/55">
            Paste multiple YouTube playlist URLs, one per line.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="batch-urls">Playlist URLs</Label>
            <Textarea
              id="batch-urls"
              placeholder={`https://youtube.com/playlist?list=...\nhttps://youtube.com/playlist?list=...\nhttps://youtube.com/playlist?list=...`}
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              rows={5}
              className="border-white/10 bg-black/20 text-white placeholder:text-white/40 focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0"
              disabled={isImporting}
            />
          </div>

          {results.length > 0 && (
            <div className="space-y-2">
              <Label>Import Progress</Label>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-2xl border border-white/10 bg-black/20 p-2">
                {results.map((result, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 text-sm"
                  >
                    {result.status === "pending" && (
                      <div className="h-4 w-4 rounded-full border-2 border-white/20" />
                    )}
                    {result.status === "importing" && (
                      <Loader2 className="h-4 w-4 animate-spin text-white" />
                    )}
                    {result.status === "success" && (
                      <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                    )}
                    {result.status === "error" && (
                      <XCircle className="h-4 w-4 text-red-300" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {result.url}
                    </span>
                    {result.message && (
                      <span className="shrink-0 text-xs text-white/45">
                        {result.message}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
            onClick={handleClose}
            disabled={isImporting}
          >
            {isImporting ? "Importing..." : "Close"}
          </Button>
          <Button
            onClick={handleSubmit}
            className="bg-white text-black hover:bg-white/90"
            disabled={!urls.trim() || isImporting}
          >
            {isImporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Importing...
              </>
            ) : (
              "Import All"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
