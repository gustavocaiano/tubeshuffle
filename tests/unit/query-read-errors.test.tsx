import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ query: {} as Record<string, unknown>, refetch: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => state.query,
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "one" }) }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/stores/playlist-store", () => ({ playlistRepository: {} }));
vi.mock("@/stores/player-store", () => {
  const store = Object.assign(() => ({ setQueue: vi.fn(), currentVideo: null, queue: [], currentIndex: 0 }), { getState: () => ({ queue: [], playlistId: null }) });
  return { usePlayerStore: store };
});
vi.mock("@/stores/ui-preferences-store", () => ({ useUiPreferencesStore: () => ({ hideThumbnails: false, focusMode: false, toggleHideThumbnails: vi.fn() }) }));
vi.mock("@/components/layouts/Navbar", () => ({ Navbar: () => null }));
vi.mock("@/components/playlist/PlaylistCard", () => ({ PlaylistCard: ({ playlist }: { playlist: { title: string } }) => <div>{playlist.title}</div> }));
vi.mock("@/components/playlist/ImportPlaylistModal", () => ({ ImportPlaylistModal: () => null }));
vi.mock("@/components/playlist/AccountPanel", () => ({ AccountPanel: () => null }));
vi.mock("@/app/dashboard/ExportLibrary", () => ({ ExportLibrary: () => null }));
vi.mock("@/components/playlist/VideoPlayer", () => ({ VideoPlayer: () => null }));
vi.mock("@/components/playlist/PlaybackControls", () => ({ PlaybackControls: () => null }));
vi.mock("@/components/playlist/PlayerViewControls", () => ({ PlayerViewControls: () => null }));
vi.mock("@/components/playlist/StagePlayer", () => ({ StagePlayer: () => null }));
vi.mock("@/components/playlist/PlaylistQueue", () => ({ PlaylistQueue: () => null }));
vi.mock("@/components/playlist/DailySuggestions", () => ({ DailySuggestions: () => null }));
vi.mock("@/components/playlist/ShuffleControls", () => ({ ShuffleControls: () => null }));

import Dashboard from "@/app/dashboard/DashboardClient";
import Playlist from "@/app/playlist/[id]/page";

const playlist = { id: "one", title: "Saved playlist", youtubeId: "yt", channelTitle: null };
const setQuery = (data: unknown, isError = false) => {
  state.query = { data, isError, isSuccess: !isError, isFetchedAfterMount: true, isPending: false, isLoading: false, isFetching: false, refetch: state.refetch };
};

beforeEach(() => state.refetch.mockReset());
afterEach(cleanup);

describe("library and playlist read states", () => {
  it("shows a retryable library error rather than an empty library", () => {
    setQuery(undefined, true);
    render(<Dashboard appOrigin="https://example.test" />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load your library");
    expect(screen.queryByText("No playlists yet")).toBeNull();
    expect(screen.queryByText("0 playlists ready to shuffle")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
  it("shows the actual empty and populated library states", () => {
    setQuery([]);
    const view = render(<Dashboard appOrigin="https://example.test" />);
    expect(screen.getByText("No playlists yet")).toBeTruthy();
    setQuery([playlist]);
    view.rerender(<Dashboard appOrigin="https://example.test" />);
    expect(screen.getByText("Saved playlist")).toBeTruthy();
  });
  it("retains cached library data with a stale warning", () => {
    setQuery([playlist], true);
    render(<Dashboard appOrigin="https://example.test" />);
    expect(screen.getByText("Saved playlist")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("out of date");
  });
  it("shows a retryable playlist error rather than not found", () => {
    setQuery(undefined, true);
    render(<Playlist />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load your playlist");
    expect(screen.queryByText("Playlist not found")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
  it("distinguishes not found and empty successful playlist reads", () => {
    setQuery(null);
    const view = render(<Playlist />);
    expect(screen.getByText("Playlist not found")).toBeTruthy();
    setQuery({ playlist, videos: [] });
    view.rerender(<Playlist />);
    expect(screen.getByText("This playlist has no videos")).toBeTruthy();
  });
  it("keeps cached playlist details while suppressing a stale empty claim", () => {
    setQuery({ playlist, videos: [] }, true);
    render(<Playlist />);
    expect(screen.getByText("Saved playlist")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("out of date");
    expect(screen.queryByText("This playlist has no videos")).toBeNull();
  });
});
