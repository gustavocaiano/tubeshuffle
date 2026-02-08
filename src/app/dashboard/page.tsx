"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { usePlaylistStore } from "@/stores/playlist-store";
import { Navbar } from "@/components/layouts/Navbar";
import { PlaylistCard } from "@/components/playlist/PlaylistCard";
import { ImportPlaylistModal } from "@/components/playlist/ImportPlaylistModal";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Plus,
  Shuffle,
  Music,
  Crown,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const { importModalOpen, setImportModalOpen } = usePlaylistStore();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  const profileQuery = trpc.user.getProfile.useQuery(undefined, {
    enabled: !!session,
  });

  const playlistsQuery = trpc.playlist.list.useQuery(undefined, {
    enabled: !!session,
  });

  const deleteMutation = trpc.playlist.delete.useMutation({
    onSuccess: () => {
      toast.success("Playlist deleted");
      playlistsQuery.refetch();
      profileQuery.refetch();
    },
    onError: (error) => toast.error(error.message),
  });

  const syncMutation = trpc.playlist.sync.useMutation({
    onSuccess: () => {
      toast.success("Playlist synced with YouTube");
      playlistsQuery.refetch();
    },
    onError: (error) => toast.error(error.message),
  });

  if (status === "loading" || status === "unauthenticated") {
    return null;
  }

  const profile = profileQuery.data;
  const playlists = playlistsQuery.data ?? [];
  const isAtLimit =
    profile && profile.playlistCount >= profile.maxPlaylists;
  const isPremium = profile?.subscription === "PREMIUM";

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
                {profile ? (
                  <>
                    {profile.playlistCount} / {profile.maxPlaylists} playlists
                    used
                    {isPremium && (
                      <Badge variant="default" className="ml-2">
                        <Crown className="mr-1 h-3 w-3" />
                        Premium
                      </Badge>
                    )}
                  </>
                ) : (
                  <Skeleton className="inline-block h-4 w-32" />
                )}
              </p>
            </div>
            <Button
              onClick={() => setImportModalOpen(true)}
              disabled={!!isAtLimit}
            >
              <Plus className="mr-2 h-4 w-4" />
              Import Playlist
            </Button>
          </div>

          {/* Upgrade Banner (for free users at limit) */}
          {isAtLimit && !isPremium && (
            <Card className="mt-6 border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950">
              <CardContent className="flex items-center gap-4 p-4">
                <AlertCircle className="h-5 w-5 text-amber-600" />
                <div className="flex-1">
                  <p className="font-medium text-amber-800 dark:text-amber-200">
                    You&apos;ve reached the free playlist limit
                  </p>
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Upgrade to Premium to save up to 50 playlists and unlock
                    advanced shuffle modes.
                  </p>
                </div>
                <Link href="/pricing">
                  <Button size="sm">
                    <Crown className="mr-2 h-4 w-4" />
                    Upgrade
                  </Button>
                </Link>
              </CardContent>
            </Card>
          )}

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
                  onDelete={(id) => deleteMutation.mutate({ id })}
                  onSync={(id) => syncMutation.mutate({ id })}
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
          playlistsQuery.refetch();
          profileQuery.refetch();
        }}
      />
    </div>
  );
}
