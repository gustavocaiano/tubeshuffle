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
import { Badge } from "@/components/ui/badge";
import { Loader2, Crown, CheckCircle2, XCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface BatchImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPremium: boolean;
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
  isPremium,
  onSuccess,
}: BatchImportModalProps) {
  const [urls, setUrls] = useState("");
  const [results, setResults] = useState<ImportResult[]>([]);
  const [isImporting, setIsImporting] = useState(false);

  const importMutation = trpc.playlist.import.useMutation();

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
        await importMutation.mutateAsync({ url: importResults[i].url });
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

  if (!isPremium) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Batch Import
              <Badge>
                <Crown className="mr-1 h-3 w-3" />
                Premium
              </Badge>
            </DialogTitle>
            <DialogDescription>
              Batch import is a Premium feature. Upgrade to import multiple
              playlists at once.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Batch Import Playlists</DialogTitle>
          <DialogDescription>
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
              disabled={isImporting}
            />
          </div>

          {results.length > 0 && (
            <div className="space-y-2">
              <Label>Import Progress</Label>
              <div className="max-h-40 space-y-1 overflow-y-auto rounded border p-2">
                {results.map((result, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 text-sm"
                  >
                    {result.status === "pending" && (
                      <div className="h-4 w-4 rounded-full border-2" />
                    )}
                    {result.status === "importing" && (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    )}
                    {result.status === "success" && (
                      <CheckCircle2 className="h-4 w-4 text-green-500" />
                    )}
                    {result.status === "error" && (
                      <XCircle className="h-4 w-4 text-destructive" />
                    )}
                    <span className="min-w-0 flex-1 truncate">
                      {result.url}
                    </span>
                    {result.message && (
                      <span className="shrink-0 text-xs text-muted-foreground">
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
            onClick={handleClose}
            disabled={isImporting}
          >
            {isImporting ? "Importing..." : "Close"}
          </Button>
          <Button
            onClick={handleSubmit}
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
