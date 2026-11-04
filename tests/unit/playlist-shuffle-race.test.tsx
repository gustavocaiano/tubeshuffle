import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalPlaylist, LocalVideo } from "@/types/playlist";

const route = vi.hoisted(() => ({ playlistId: "playlist-a" }));
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const repositoryMocks = vi.hoisted(() => ({
  getPlaylist: vi.fn(),
  getCompletedVideoIds: vi.fn(),
  recordPlay: vi.fn(),
}));
const shuffleMocks = vi.hoisted(() => ({
  shuffleVideos: vi.fn(),
}));
const player = vi.hoisted(() => ({ onEnd: undefined as undefined | ((video: { id: string; youtubeId: string; title: string; channelTitle: string; thumbnail: string; duration: number }) => void) }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: route.playlistId }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("next/image", () => ({
  default: () => null,
}));

vi.mock("sonner", () => ({ toast: toastMocks }));
vi.mock("@/stores/playlist-store", () => ({
  playlistRepository: repositoryMocks,
}));
vi.mock("@/lib/shuffle/shuffle-service", () => shuffleMocks);

vi.mock("@/components/layouts/Navbar", () => ({ Navbar: () => null }));
vi.mock("@/components/playlist/VideoPlayer", () => ({
  VideoPlayer: ({ onVideoEnd }: { onVideoEnd: typeof player.onEnd }) => { player.onEnd = onVideoEnd; return <div data-testid="video-player" />; },
}));
vi.mock("@/components/playlist/PlaybackControls", () => ({
  PlaybackControls: () => null,
}));
vi.mock("@/components/playlist/PlayerViewControls", () => ({
  PlayerViewControls: () => null,
}));
vi.mock("@/components/playlist/StagePlayer", () => ({
  StagePlayer: () => null,
}));
vi.mock("@/components/playlist/PlaylistQueue", () => ({
  PlaylistQueue: () => null,
}));
vi.mock("@/components/playlist/DailySuggestions", () => ({
  DailySuggestions: () => null,
}));
vi.mock("@/components/playlist/ShuffleControls", () => ({
  ShuffleControls: ({
    excludeWatched,
    onShuffle,
    onExcludeWatchedChange,
  }: {
    excludeWatched: boolean;
    onShuffle: (preset: "RANDOM" | "SMART") => void;
    onExcludeWatchedChange: (value: boolean) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onShuffle("RANDOM")}>
        shuffle-random
      </button>
      <button type="button" onClick={() => onShuffle("SMART")}>
        shuffle-smart
      </button>
      <label>
        <input
          type="checkbox"
          checked={excludeWatched}
          onChange={(event) => onExcludeWatchedChange(event.target.checked)}
        />
        exclude-watched
      </label>
    </div>
  ),
}));
vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: React.MouseEventHandler<HTMLButtonElement>; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
vi.mock("@/components/ui/skeleton", () => ({ Skeleton: () => null }));

import PlaylistPage from "@/app/playlist/[id]/page";
import { usePlayerStore } from "@/stores/player-store";
import { shuffleVideos } from "@/lib/shuffle/shuffle-service";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeVideo(playlistId: string, id: string): LocalVideo {
  return {
    id,
    playlistId,
    youtubeId: `yt-${id}`,
    title: `Video ${id}`,
    channelTitle: `Channel ${playlistId}`,
    thumbnail: `https://img.example/${id}.jpg`,
    duration: 120,
    position: 0,
  };
}

function makeBundle(
  id: string,
  title: string,
  videos: LocalVideo[],
): { playlist: LocalPlaylist; videos: LocalVideo[] } {
  return {
    playlist: {
      id,
      youtubeId: `yt-${id}`,
      title,
      description: null,
      thumbnail: null,
      channelTitle: null,
      videoCount: videos.length,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    videos,
  };
}

const videoA1 = makeVideo("playlist-a", "a1");
const videoA2 = makeVideo("playlist-a", "a2");
const videoB1 = makeVideo("playlist-b", "b1");
const videoB2 = makeVideo("playlist-b", "b2");
const bundleA = makeBundle("playlist-a", "Playlist A", [videoA1, videoA2]);
const bundleB = makeBundle("playlist-b", "Playlist B", [videoB1, videoB2]);

function createClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
    },
  });
}

function pageElement(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <PlaylistPage />
    </QueryClientProvider>
  );
}

function renderPage(client = createClient()) {
  return { client, view: render(pageElement(client)) };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  route.playlistId = "playlist-a";
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
  repositoryMocks.getPlaylist.mockReset();
  repositoryMocks.getCompletedVideoIds.mockReset();
  repositoryMocks.recordPlay.mockReset();
  shuffleMocks.shuffleVideos.mockReset();
  player.onEnd = undefined;

  repositoryMocks.getPlaylist.mockImplementation(async (id: string) => {
    if (id === "playlist-a") return bundleA;
    if (id === "playlist-b") return bundleB;
    return null;
  });
  repositoryMocks.getCompletedVideoIds.mockResolvedValue(new Set<string>());
  repositoryMocks.recordPlay.mockResolvedValue(undefined);
  shuffleMocks.shuffleVideos.mockImplementation((videos: LocalVideo[]) => [
    ...videos,
  ]);

  usePlayerStore.getState().clearQueue();
});

afterEach(() => {
  cleanup();
  onlineManager.setOnline(true);
  usePlayerStore.getState().clearQueue();
});

describe("playlist shuffle request identity", () => {
  it("reads and shuffles locally while offline without a matching queue", async () => {
    onlineManager.setOnline(false);
    renderPage();
    await waitFor(() => expect(usePlayerStore.getState().playlistId).toBe("playlist-a"));
    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual(["a1", "a2"]);
    expect(repositoryMocks.getPlaylist).toHaveBeenCalledWith("playlist-a");
    expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(1);
    expect(repositoryMocks.getCompletedVideoIds).not.toHaveBeenCalled();
    expect(repositoryMocks.recordPlay).not.toHaveBeenCalled();
    expect(screen.getByTestId("video-player")).toBeTruthy();
  });
  it("shares the initial verification under Strict Mode", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 300000, retry: false } } });
    client.setQueryData(["playlist", "playlist-a"], bundleA);
    const pending = deferred<typeof bundleA>();
    repositoryMocks.getPlaylist.mockReturnValueOnce(pending.promise);
    render(<React.StrictMode>{pageElement(client)}</React.StrictMode>);
    await waitFor(() => expect(repositoryMocks.getPlaylist).toHaveBeenCalledTimes(1));
    await act(async () => { pending.resolve(bundleA); });
    await screen.findByText("Playlist A");
    expect(repositoryMocks.getPlaylist).toHaveBeenCalledTimes(1);
  });

  it("revalidates fresh cached B after an in-place route change before enabling playback", async () => {
    usePlayerStore.getState().setQueue([videoB1], "playlist-b", "Playlist B");
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 300000, retry: false } } });
    client.setQueryData(["playlist", "playlist-b"], bundleB);
    const pending = deferred<typeof bundleB>();
    repositoryMocks.getPlaylist.mockImplementation((id: string) => id === "playlist-b" ? pending.promise : Promise.resolve(bundleA));
    const { view } = renderPage(client);
    await screen.findByText("Playlist A");
    route.playlistId = "playlist-b";
    view.rerender(pageElement(client));
    await waitFor(() => expect(repositoryMocks.getPlaylist).toHaveBeenCalledWith("playlist-b"));
    expect(screen.queryByTestId("video-player")).toBeNull();
    await act(async () => { pending.resolve(bundleB); });
    await screen.findByTestId("video-player");
  });

  it("does not claim cached null is not found before route verification", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 300000, retry: false } } });
    client.setQueryData(["playlist", "playlist-a"], null);
    const pending = deferred<typeof bundleA | null>();
    repositoryMocks.getPlaylist.mockReturnValueOnce(pending.promise);
    renderPage(client);
    expect(screen.queryByText("Playlist not found")).toBeNull();
    await act(async () => { pending.resolve(null); });
    await screen.findByText("Playlist not found");
  });

  it("records healthy completions but ignores the same callback after direct unmount", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");
    const { view } = renderPage();
    await screen.findByTestId("video-player");
    const onEnd = player.onEnd!;
    act(() => onEnd(videoA1));
    await waitFor(() => expect(repositoryMocks.recordPlay).toHaveBeenCalledTimes(1));
    view.unmount();
    act(() => onEnd(videoA1));
    expect(repositoryMocks.recordPlay).toHaveBeenCalledTimes(1);
  });

  it("revalidates a fresh cached detail before mounting playback, including offline", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: 300000, retry: false } } });
    client.setQueryData(["playlist", "playlist-a"], bundleA);
    const pending = deferred<typeof bundleA>();
    repositoryMocks.getPlaylist.mockReturnValueOnce(pending.promise);
    onlineManager.setOnline(false);
    renderPage(client);
    expect(screen.queryByTestId("video-player")).toBeNull();
    await waitFor(() => expect(repositoryMocks.getPlaylist).toHaveBeenCalledWith("playlist-a"));
    await act(async () => { pending.resolve(bundleA); });
    await screen.findByTestId("video-player");
  });

  it("keeps the same player mounted during a healthy background refetch", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");
    const { client } = renderPage();
    const original = await screen.findByTestId("video-player");
    const pending = deferred<typeof bundleA>();
    repositoryMocks.getPlaylist.mockReturnValueOnce(pending.promise);
    act(() => { void client.refetchQueries({ queryKey: ["playlist", "playlist-a"] }); });
    await waitFor(() => expect(client.isFetching()).toBe(1));
    expect(screen.getByTestId("video-player")).toBe(original);
    await act(async () => { pending.resolve(bundleA); });
    expect(screen.getByTestId("video-player")).toBe(original);
  });

  it("ignores captured completion callbacks after a read error and unmount", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");
    const { client, view } = renderPage();
    await screen.findByTestId("video-player");
    const onEnd = player.onEnd!;
    repositoryMocks.getPlaylist.mockRejectedValueOnce(new Error("read failed"));
    await act(async () => { await client.refetchQueries({ queryKey: ["playlist", "playlist-a"] }); });
    await screen.findByRole("alert");
    act(() => onEnd(videoA1));
    view.unmount();
    act(() => onEnd(videoA1));
    expect(repositoryMocks.recordPlay).not.toHaveBeenCalled();
  });

  it("keeps an intentionally emptied queue visible without reshuffling", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");
    renderPage();
    await screen.findByTestId("video-player");
    act(() => usePlayerStore.getState().removeFromQueue(0));
    expect(screen.getByTestId("video-player")).toBeTruthy();
    expect(screen.getByText("Queue")).toBeTruthy();
    expect(screen.queryByText("Preparing this playlist for playback.")).toBeNull();
    expect(shuffleMocks.shuffleVideos).not.toHaveBeenCalled();
  });
  it("attempts an offline local read and does not claim not found before it completes", async () => {
    const pending = deferred<typeof bundleA | null>();
    repositoryMocks.getPlaylist.mockReturnValueOnce(pending.promise);
    onlineManager.setOnline(false);
    renderPage();
    await waitFor(() => expect(repositoryMocks.getPlaylist).toHaveBeenCalledWith("playlist-a"));
    expect(screen.queryByText("Playlist not found")).toBeNull();
    expect(screen.queryByText("This playlist has no videos")).toBeNull();
    await act(async () => { pending.resolve(null); });
    expect(await screen.findByText("Playlist not found")).toBeTruthy();
  });
  it("keeps another playlist's queue untouched and player unmounted when a cached read fails", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");
    route.playlistId = "playlist-b";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000, gcTime: Infinity } } });
    client.setQueryData(["playlist", "playlist-b"], bundleB);
    repositoryMocks.getPlaylist.mockRejectedValue(new Error("secret database error"));
    renderPage(client);
    await screen.findByRole("alert");
    expect(screen.getByText("Playlist B")).toBeTruthy();
    expect(screen.queryByTestId("video-player")).toBeNull();
    expect(repositoryMocks.getPlaylist).toHaveBeenCalledWith("playlist-b");
    expect(screen.queryByText(/secret database error/)).toBeNull();
    expect(usePlayerStore.getState().playlistId).toBe("playlist-a");
    expect(repositoryMocks.recordPlay).not.toHaveBeenCalled();
  });

  it("does not mount another playlist's queue while replacement shuffle is pending", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");
    route.playlistId = "playlist-b";
    const pending = deferred<LocalVideo[]>();
    shuffleMocks.shuffleVideos.mockReturnValue(pending.promise);
    renderPage();
    await screen.findByText("Playlist B");
    await waitFor(() => expect(shuffleMocks.shuffleVideos).toHaveBeenCalled());
    expect(screen.queryByTestId("video-player")).toBeNull();
    expect(usePlayerStore.getState().playlistId).toBe("playlist-a");
  });

  it("invalidates a pending shuffle on read failure and recovers after explicit refetch", async () => {
    const pending = deferred<LocalVideo[]>();
    shuffleMocks.shuffleVideos.mockReturnValueOnce(pending.promise).mockImplementation((videos: LocalVideo[]) => videos);
    const { client } = renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() => expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(1));
    repositoryMocks.getPlaylist.mockRejectedValueOnce(new Error("private detail"));
    await act(async () => { await client.refetchQueries({ queryKey: ["playlist", "playlist-a"] }); });
    await screen.findByRole("alert");
    await act(async () => { pending.resolve([videoA2]); });
    expect(usePlayerStore.getState().queue).toEqual([]);
    repositoryMocks.getPlaylist.mockResolvedValueOnce(bundleA);
    await act(async () => { await client.refetchQueries({ queryKey: ["playlist", "playlist-a"] }); });
    await waitFor(() => expect(usePlayerStore.getState().queue.map((v) => v.id)).toEqual(["a1", "a2"]));
    expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/private detail/)).toBeNull();
  });

  it("keeps the remounted playlist queue when an unmounted playlist's deferred watched lookup finishes later", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");

    const watched = deferred<Set<string>>();
    repositoryMocks.getCompletedVideoIds.mockReturnValueOnce(watched.promise);

    const client = createClient();
    const first = renderPage(client);
    await screen.findByText("Playlist A");

    fireEvent.click(screen.getByLabelText("exclude-watched"));
    fireEvent.click(screen.getByRole("button", { name: "shuffle-random" }));

    await waitFor(() =>
      expect(repositoryMocks.getCompletedVideoIds).toHaveBeenCalledWith(
        "playlist-a",
      ),
    );
    expect(shuffleMocks.shuffleVideos).not.toHaveBeenCalled();

    first.view.unmount();

    route.playlistId = "playlist-b";
    const second = renderPage(client);
    await screen.findByText("Playlist B");
    await waitFor(() =>
      expect(usePlayerStore.getState().playlistId).toBe("playlist-b"),
    );
    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
      "b1",
      "b2",
    ]);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);

    await act(async () => {
      watched.resolve(new Set<string>());
    });
    await settle();

    expect(usePlayerStore.getState().playlistId).toBe("playlist-b");
    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
      "b1",
      "b2",
    ]);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(shuffleMocks.shuffleVideos).toHaveBeenCalledWith(
      bundleA.videos,
      "RANDOM",
    );

    second.view.unmount();
  });

  it("ignores a pending previous route's shuffle while the new playlist is still loading", async () => {
    const pendingPlaylistB = deferred<{
      playlist: LocalPlaylist;
      videos: LocalVideo[];
    } | null>();
    repositoryMocks.getPlaylist.mockImplementation((id: string) =>
      id === "playlist-b" ? pendingPlaylistB.promise : Promise.resolve(bundleA),
    );

    const previousRouteShuffle = deferred<LocalVideo[]>();
    shuffleMocks.shuffleVideos.mockImplementationOnce(
      () => previousRouteShuffle.promise as never,
    );

    const { client, view } = renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() => expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(1));

    route.playlistId = "playlist-b";
    view.rerender(pageElement(client));
    await waitFor(() => expect(screen.queryByText("Playlist A")).toBeNull());

    await act(async () => {
      previousRouteShuffle.resolve([videoA2, videoA1]);
    });
    await settle();

    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();

    view.unmount();
  });

  it("ignores an old playlist request after navigating away and back to the same playlist", async () => {
    usePlayerStore.getState().setQueue([videoA1], "playlist-a", "Playlist A");

    const pendingPlaylistB = deferred<{
      playlist: LocalPlaylist;
      videos: LocalVideo[];
    } | null>();
    repositoryMocks.getPlaylist.mockImplementation((id: string) =>
      id === "playlist-b" ? pendingPlaylistB.promise : Promise.resolve(bundleA),
    );

    const watched = deferred<Set<string>>();
    repositoryMocks.getCompletedVideoIds.mockReturnValueOnce(watched.promise);

    const { client, view } = renderPage();
    await screen.findByText("Playlist A");

    fireEvent.click(screen.getByLabelText("exclude-watched"));
    fireEvent.click(screen.getByRole("button", { name: "shuffle-random" }));
    await waitFor(() =>
      expect(repositoryMocks.getCompletedVideoIds).toHaveBeenCalledWith(
        "playlist-a",
      ),
    );
    expect(shuffleMocks.shuffleVideos).not.toHaveBeenCalled();

    route.playlistId = "playlist-b";
    view.rerender(pageElement(client));
    await waitFor(() => expect(screen.queryByText("Playlist A")).toBeNull());

    route.playlistId = "playlist-a";
    view.rerender(pageElement(client));
    await screen.findByText("Playlist A");
    expect(repositoryMocks.getCompletedVideoIds).toHaveBeenCalledTimes(1);
    expect(shuffleMocks.shuffleVideos).not.toHaveBeenCalled();

    await act(async () => {
      watched.resolve(new Set<string>());
    });
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledWith(
        bundleA.videos,
        "RANDOM",
      ),
    );
    await settle();

    expect(usePlayerStore.getState().playlistId).toBe("playlist-a");
    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
      "a1",
    ]);
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();

    view.unmount();
  });

  it("ignores a previous route's shuffle after an in-place playlist change", async () => {
    const previousRouteShuffle = deferred<LocalVideo[]>();
    shuffleMocks.shuffleVideos.mockImplementationOnce(
      () => previousRouteShuffle.promise as never,
    );

    const { client, view } = renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(1),
    );

    route.playlistId = "playlist-b";
    view.rerender(pageElement(client));
    await screen.findByText("Playlist B");
    await waitFor(() =>
      expect(usePlayerStore.getState().playlistId).toBe("playlist-b"),
    );
    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
      "b1",
      "b2",
    ]);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);

    await act(async () => {
      previousRouteShuffle.resolve([videoA2, videoA1]);
    });
    await settle();

    expect(usePlayerStore.getState().playlistId).toBe("playlist-b");
    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
      "b1",
      "b2",
    ]);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();

    view.unmount();
  });

  it("suppresses a stale shuffle failure after the playlist unmounts", async () => {
    const previousPlaylistShuffle = deferred<LocalVideo[]>();
    shuffleMocks.shuffleVideos.mockImplementationOnce(
      () => previousPlaylistShuffle.promise as never,
    );

    const client = createClient();
    const first = renderPage(client);
    await screen.findByText("Playlist A");
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(1),
    );

    first.view.unmount();

    route.playlistId = "playlist-b";
    const second = renderPage(client);
    await screen.findByText("Playlist B");
    await waitFor(() =>
      expect(usePlayerStore.getState().playlistId).toBe("playlist-b"),
    );

    await act(async () => {
      previousPlaylistShuffle.reject(new Error("stale failure"));
    });
    await settle();

    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().playlistId).toBe("playlist-b");
    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
      "b1",
      "b2",
    ]);

    second.view.unmount();
  });

  it("applies only the newest same-page shuffle when responses resolve out of order", async () => {
    const randomShuffle = deferred<LocalVideo[]>();
    const smartShuffle = deferred<LocalVideo[]>();
    shuffleMocks.shuffleVideos.mockImplementation(
      (_videos: LocalVideo[], preset: string) =>
        (preset === "SMART" ? smartShuffle.promise : randomShuffle.promise) as never,
    );

    const { view } = renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "shuffle-smart" }));
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      smartShuffle.resolve([videoA2, videoA1]);
    });
    await waitFor(() =>
      expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
        "a2",
        "a1",
      ]),
    );
    expect(toastMocks.success).toHaveBeenCalledTimes(1);

    await act(async () => {
      randomShuffle.resolve([videoA1, videoA2]);
    });
    await settle();

    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
      "a2",
      "a1",
    ]);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.error).not.toHaveBeenCalled();

    view.unmount();
  });

  it("does not report a superseded shuffle failure after a newer shuffle succeeds", async () => {
    const randomShuffle = deferred<LocalVideo[]>();
    const smartShuffle = deferred<LocalVideo[]>();
    shuffleMocks.shuffleVideos.mockImplementation(
      (_videos: LocalVideo[], preset: string) =>
        (preset === "SMART" ? smartShuffle.promise : randomShuffle.promise) as never,
    );

    const { view } = renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "shuffle-smart" }));
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      smartShuffle.resolve([videoA2, videoA1]);
    });
    await waitFor(() =>
      expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
        "a2",
        "a1",
      ]),
    );

    await act(async () => {
      randomShuffle.reject(new Error("superseded failure"));
    });
    await settle();

    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
      "a2",
      "a1",
    ]);

    view.unmount();
  });

  it("does not apply an older shuffle success after a newer shuffle fails", async () => {
    const randomShuffle = deferred<LocalVideo[]>();
    const smartShuffle = deferred<LocalVideo[]>();
    shuffleMocks.shuffleVideos.mockImplementation(
      (_videos: LocalVideo[], preset: string) =>
        (preset === "SMART" ? smartShuffle.promise : randomShuffle.promise) as never,
    );

    const { view } = renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByRole("button", { name: "shuffle-smart" }));
    await waitFor(() =>
      expect(shuffleMocks.shuffleVideos).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      smartShuffle.reject(new Error("newer failure"));
    });
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("newer failure"),
    );

    await act(async () => {
      randomShuffle.resolve([videoA1, videoA2]);
    });
    await settle();

    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledTimes(1);

    view.unmount();
  });

  it("rejects a shuffle bundle whose playlist identity does not match the route", async () => {
    repositoryMocks.getPlaylist.mockResolvedValue({
      playlist: { ...bundleA.playlist, id: "playlist-other" },
      videos: bundleA.videos,
    });

    const { view } = renderPage();
    await screen.findByText("Playlist A");
    await settle();
    expect(shuffleMocks.shuffleVideos).not.toHaveBeenCalled();

    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(toastMocks.error).not.toHaveBeenCalled();
    expect(repositoryMocks.recordPlay).not.toHaveBeenCalled();

    view.unmount();
  });

  it("keeps normal shuffle success behavior", async () => {
    shuffleMocks.shuffleVideos.mockImplementation((videos: LocalVideo[]) => [
      videos[1],
      videos[0],
    ]);

    renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() => expect(usePlayerStore.getState().queue).toHaveLength(2));

    expect(usePlayerStore.getState().queue).toEqual([
      {
        id: "a2",
        youtubeId: "yt-a2",
        title: "Video a2",
        channelTitle: "Channel playlist-a",
        thumbnail: "https://img.example/a2.jpg",
        duration: 120,
      },
      {
        id: "a1",
        youtubeId: "yt-a1",
        title: "Video a1",
        channelTitle: "Channel playlist-a",
        thumbnail: "https://img.example/a1.jpg",
        duration: 120,
      },
    ]);
    expect(usePlayerStore.getState().playlistId).toBe("playlist-a");
    expect(usePlayerStore.getState().playlistTitle).toBe("Playlist A");
    expect(usePlayerStore.getState().currentVideo?.id).toBe("a2");
    expect(usePlayerStore.getState().isPlaying).toBe(true);
    expect(toastMocks.success).toHaveBeenCalledWith("Shuffled 2 videos");
  });

  it("keeps empty shuffle feedback", async () => {
    shuffleMocks.shuffleVideos.mockReturnValue([]);

    renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "No videos available with the current filters.",
      ),
    );

    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("keeps shuffle failure feedback", async () => {
    shuffleMocks.shuffleVideos.mockImplementation(() => {
      throw new Error("shuffle failed");
    });

    renderPage();
    await screen.findByText("Playlist A");
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("shuffle failed"),
    );

    expect(usePlayerStore.getState().queue).toEqual([]);
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("keeps autoshow working under Strict Mode without duplicate queue writes or success toasts", async () => {
    const client = createClient();
    client.setQueryData(["playlist", "playlist-a"], bundleA);
    shuffleMocks.shuffleVideos.mockImplementation((videos: LocalVideo[]) => [
      ...videos,
    ]);

    const queueWrites: string[][] = [];
    const unsubscribe = usePlayerStore.subscribe((state, previousState) => {
      if (state.queue !== previousState.queue) {
        queueWrites.push(state.queue.map((video) => video.id));
      }
    });

    try {
      render(
        <React.StrictMode>
          <QueryClientProvider client={client}>
            <PlaylistPage />
          </QueryClientProvider>
        </React.StrictMode>,
      );

      await screen.findByText("Playlist A");
      await waitFor(() =>
        expect(usePlayerStore.getState().queue.map((video) => video.id)).toEqual([
          "a1",
          "a2",
        ]),
      );
      await settle();

      expect(queueWrites).toEqual([["a1", "a2"]]);
      expect(toastMocks.success).toHaveBeenCalledTimes(1);
      expect(toastMocks.error).not.toHaveBeenCalled();
      expect(shuffleVideos).toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
