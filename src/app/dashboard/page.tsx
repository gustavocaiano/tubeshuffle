"use client";

import dynamic from "next/dynamic";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { playlistRepository } from "@/stores/playlist-store";
import { PlaylistCard } from "@/components/playlist/PlaylistCard";
import { ImportPlaylistModal } from "@/components/playlist/ImportPlaylistModal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardTitle,
} from "@/components/ui/card";
import { Plus, Music } from "lucide-react";
import { toast } from "sonner";

const Navbar = dynamic(
  () => import("@/components/layouts/Navbar").then((module) => module.Navbar),
  { ssr: false }
);

export default function DashboardPage() {
  const [importModalOpen, setImportModalOpen] = useState(false);
  const queryClient = useQueryClient();

  const playlistsQuery = useQuery({
    queryKey: ["playlists"],
    queryFn: () => playlistRepository.listPlaylists(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => playlistRepository.deletePlaylist(id),
    onSuccess: () => {
      toast.success("Playlist deleted");
      queryClient.invalidateQueries({ queryKey: ["playlists"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const syncMutation = useMutation({
    mutationFn: (id: string) => playlistRepository.syncPlaylist(id),
    onSuccess: () => {
      toast.success("Playlist synced with YouTube");
      queryClient.invalidateQueries({ queryKey: ["playlists"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const playlists = playlistsQuery.data ?? [];

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />

      <main className="flex-1">
        <div className="container mx-auto px-4 py-8">
          {/* Header */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-3xl font-bold">My Playlists</h1>
              <p className="mt-1 text-muted-foreground">
                {playlistsQuery.isLoading ? (
                  <Skeleton className="inline-block h-4 w-32" />
                ) : (
                  `${playlists.length} playlists saved locally`
                )}
              </p>
            </div>
            <Button onClick={() => setImportModalOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Import Playlist
            </Button>
          </div>

          {/* Playlists Grid */}
          {playlistsQuery.isLoading ? (
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="overflow-hidden">
                  <Skeleton className="aspect-video" />
                  <CardContent className="p-4">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="mt-2 h-4 w-1/2" />
                    <Skeleton className="mt-4 h-9 w-full" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : playlists.length === 0 ? (
            <Card className="mt-12">
              <CardContent className="flex flex-col items-center justify-center py-16">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <Music className="h-8 w-8 text-muted-foreground" />
                </div>
                <CardTitle className="text-xl">No playlists yet</CardTitle>
                <CardDescription className="mt-2 text-center">
                  Import your first YouTube playlist to get started with true
                  random shuffling.
                </CardDescription>
                <Button
                  className="mt-6"
                  onClick={() => setImportModalOpen(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Import Your First Playlist
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {playlists.map((playlist) => (
                <PlaylistCard
                  key={playlist.id}
                  playlist={playlist}
                  onDelete={(id) => deleteMutation.mutate(id)}
                  onSync={(id) => syncMutation.mutate(id)}
                />
              ))}
            </div>
          )}
        </div>
      </main>

      <ImportPlaylistModal
        open={importModalOpen}
        onOpenChange={setImportModalOpen}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["playlists"] });
        }}
      />
    </div>
  );
}
