import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const repository = vi.hoisted(() => ({ listPlaylists: vi.fn(), deletePlaylist: vi.fn() }));
vi.mock("@/stores/playlist-store", () => ({ playlistRepository: repository }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/stores/ui-preferences-store", () => ({ useUiPreferencesStore: (selector?: (s: { hideThumbnails: boolean }) => unknown) => selector ? selector({ hideThumbnails: false }) : { hideThumbnails: false, toggleHideThumbnails: vi.fn() } }));
vi.mock("@/components/playlist/AccountPanel", () => ({ AccountPanel: () => null }));
vi.mock("@/app/dashboard/ExportLibrary", () => ({ ExportLibrary: () => null }));
import Dashboard from "@/app/dashboard/DashboardClient";

const playlist = { id: "one", title: "Cached playlist", youtubeId: "yt", thumbnail: null, channelTitle: null, videoCount: 1 };
const createClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const show = (client: QueryClient) => render(<QueryClientProvider client={client}><Dashboard appOrigin="https://example.test" /></QueryClientProvider>);
beforeEach(() => { repository.listPlaylists.mockReset(); repository.deletePlaylist.mockReset(); });
afterEach(() => { cleanup(); onlineManager.setOnline(true); });

it("makes cached cards read-only when the library read fails", async () => {
  const client = createClient();
  client.setQueryData(["playlists"], [playlist]);
  repository.listPlaylists.mockRejectedValue(new Error("secret storage failure"));
  show(client);
  await screen.findByRole("alert");
  expect(screen.getByText("Cached playlist")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Actions for Cached playlist" })).toBeNull();
  expect(screen.queryByRole("link", { name: "Cached playlist" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Shuffle & Play" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Import Playlist" })).toBeNull();
  expect(screen.queryByText(/secret storage failure/)).toBeNull();
  expect(repository.deletePlaylist).not.toHaveBeenCalled();
});

it("attempts a local library read while offline without exposing cached actions before verification", async () => {
  onlineManager.setOnline(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 300000 } } });
  client.setQueryData(["playlists"], [playlist]);
  let resolveRead!: (value: typeof playlist[]) => void;
  repository.listPlaylists.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
  show(client);
  await waitFor(() => expect(repository.listPlaylists).toHaveBeenCalledTimes(1));
  expect(screen.getByText("Cached playlist")).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Cached playlist" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Actions for Cached playlist" })).toBeNull();
  expect(screen.queryByText("No playlists yet")).toBeNull();
  expect(screen.queryByText("0 playlists ready to shuffle")).toBeNull();
  await act(async () => { resolveRead([playlist]); });
  expect(await screen.findByRole("link", { name: "Cached playlist" })).toBeTruthy();
});

it("keeps retry focused and announces progress during a retry without cached data", async () => {
  let resolveRetry!: (value: typeof playlist[]) => void;
  repository.listPlaylists.mockRejectedValueOnce(new Error("private error")).mockImplementationOnce(
    () => new Promise((resolve) => { resolveRetry = resolve; }),
  );
  show(createClient());
  await screen.findByRole("alert");
  const retry = screen.getByRole("button", { name: "Retry" });
  retry.focus();
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByRole("button", { name: "Trying again…" })).toBe(retry));
  expect(document.activeElement).toBe(retry);
  expect(screen.getByRole("alert").textContent).toContain("Trying again…");
  expect(screen.queryByText("No playlists yet")).toBeNull();
  await act(async () => { resolveRetry([playlist]); });
  await screen.findByText("Cached playlist");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "My Playlists" }));
});

it("preserves an open import draft while a library read fails", async () => {
  repository.listPlaylists.mockResolvedValueOnce([playlist]);
  const client = createClient();
  show(client);
  await screen.findByText("Cached playlist");
  fireEvent.click(screen.getByRole("button", { name: "Import Playlist" }));
  const input = await screen.findByLabelText("Playlist URL");
  fireEvent.change(input, { target: { value: "https://youtube.com/playlist?list=draft" } });
  repository.listPlaylists.mockRejectedValueOnce(new Error("read failed"));
  await act(async () => { await client.refetchQueries({ queryKey: ["playlists"] }); });
  await screen.findByText(/Import is unavailable/);
  expect((screen.getByLabelText("Playlist URL") as HTMLInputElement).value).toBe("https://youtube.com/playlist?list=draft");
  expect((screen.getByRole("button", { name: "Import Playlist" }) as HTMLButtonElement).disabled).toBe(true);
});

it("removes the deleted playlist detail cache", async () => {
  repository.listPlaylists.mockResolvedValue([playlist]);
  repository.deletePlaylist.mockResolvedValue(undefined);
  const client = createClient();
  client.setQueryData(["playlist", "one"], { playlist, videos: [] });
  show(client);
  const actions = await screen.findByRole("button", { name: "Actions for Cached playlist" });
  fireEvent.pointerDown(actions, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete playlist" }));
  await waitFor(() => expect(client.getQueryData(["playlist", "one"])).toBeUndefined());
  expect(repository.deletePlaylist).toHaveBeenCalledWith("one");
});

it("executes a confirmed local deletion once while offline rather than queueing it", async () => {
  repository.listPlaylists.mockResolvedValue([playlist]);
  repository.deletePlaylist.mockResolvedValue(undefined);
  show(createClient());
  const actions = await screen.findByRole("button", { name: "Actions for Cached playlist" });
  onlineManager.setOnline(false);
  fireEvent.pointerDown(actions, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete playlist" }));
  await waitFor(() => expect(repository.deletePlaylist).toHaveBeenCalledTimes(1));
  expect(repository.deletePlaylist).toHaveBeenCalledWith("one");
  await act(async () => { onlineManager.setOnline(true); });
  expect(repository.deletePlaylist).toHaveBeenCalledTimes(1);
});
