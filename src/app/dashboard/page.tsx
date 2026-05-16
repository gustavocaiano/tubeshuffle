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
import { ImageOff, Music, Plus } from "lucide-react";
import { toast } from "sonner";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";

const Navbar = dynamic(
  () => import("@/components/layouts/Navbar").then((module) => module.Navbar),
  { ssr: false }
);

export default function DashboardPage() {
  const [importModalOpen, setImportModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { hideThumbnails, toggleHideThumbnails } = useUiPreferencesStore();

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
    <div className="flex min-h-screen flex-col bg-[#080807] text-white">
      <Navbar />

      <main className="relative flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_0%,rgba(245,158,11,0.16),transparent_28rem),radial-gradient(circle_at_90%_10%,rgba(255,255,255,0.09),transparent_24rem)]" />
        <div className="container relative mx-auto px-4 py-8 md:py-10">
          {/* Header */}
          <div className="flex flex-col gap-4 rounded-[2rem] border border-white/10 bg-white/[0.055] p-6 shadow-2xl shadow-black/30 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-[0.25em] text-white/40">
                Your library
              </p>
              <h1 className="text-3xl font-black tracking-tight md:text-5xl">
                My Playlists
              </h1>
              <div className="mt-2 text-white/55">
                {playlistsQuery.isLoading ? (
                  <Skeleton className="inline-block h-4 w-32" />
                ) : (
                  `${playlists.length} playlists ready to shuffle`
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                variant="outline"
                onClick={toggleHideThumbnails}
                className="rounded-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
              >
                <ImageOff className="mr-2 h-4 w-4" />
                {hideThumbnails ? "Show artwork" : "No artwork"}
              </Button>
              <Button
                onClick={() => setImportModalOpen(true)}
                className="rounded-full bg-white text-black hover:bg-white/90"
              >
                <Plus className="mr-2 h-4 w-4" />
                Import Playlist
              </Button>
            </div>
          </div>

          {/* Playlists Grid */}
          {playlistsQuery.isLoading ? (
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[1, 2, 3].map((i) => (
                <Card
                  key={i}
                  className="overflow-hidden rounded-[2rem] border-white/10 bg-white/[0.045]"
                >
                  <Skeleton className="aspect-video bg-white/10" />
                  <CardContent className="p-4">
                    <Skeleton className="h-5 w-3/4 bg-white/10" />
                    <Skeleton className="mt-2 h-4 w-1/2 bg-white/10" />
                    <Skeleton className="mt-4 h-9 w-full bg-white/10" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : playlists.length === 0 ? (
            <Card className="mt-12 overflow-hidden rounded-[2rem] border-dashed border-white/15 bg-white/[0.055] text-white shadow-2xl shadow-black/30 backdrop-blur-xl">
              <CardContent className="flex flex-col items-center justify-center py-16">
                <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-white/10">
                  <Music className="h-8 w-8 text-white/70" />
                </div>
                <CardTitle className="text-xl">No playlists yet</CardTitle>
                <CardDescription className="mt-2 max-w-md text-center text-white/55">
                  Import your first public YouTube playlist and turn it into a
                  better listening session.
                </CardDescription>
                <Button
                  className="mt-6 rounded-full bg-white text-black hover:bg-white/90"
                  onClick={() => setImportModalOpen(true)}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  Import Your First Playlist
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
