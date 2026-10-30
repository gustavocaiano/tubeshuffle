import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AccountPanel } from "@/components/playlist/AccountPanel";
import { fetchPlaylistDataFromProxy } from "@/lib/services/youtube-proxy";
import { responseError } from "@/lib/services/account-client";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });

it("shows a fixed sign-in failure even when an existing session loads", async () => {
  window.history.replaceState(null, "", "/dashboard?auth_result=failed");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ links: [] })));
  render(<AccountPanel appOrigin={window.location.origin} />);
  await screen.findByText(/Sign-in could not be completed/);
  await screen.findByText("No saved links yet.");
  expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  expect(window.location.search).toBe("");
});

it("ignores unrecognized and duplicate failure markers", async () => {
  window.history.replaceState(null, "", "/dashboard?auth_result=failed&auth_result=secret");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ links: [] })));
  render(<AccountPanel appOrigin={window.location.origin} />);
  await screen.findByText("No saved links yet.");
  expect(screen.queryByText(/Sign-in could not be completed/)).toBeNull();
  expect(window.location.search).toBe("");
});

it("starts sign-in with a same-origin top-level GET and blocks overlapping logout", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { code: "auth_unavailable" } }, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AccountPanel appOrigin={window.location.origin} />);
  const button = await screen.findByRole("button", { name: "Sign in with Google" });
  const form = button.closest("form")!;
  expect(form.getAttribute("action")).toBe("/api/auth/start");
  expect(form.method).toBe("get");
  expect(form.target).toBe("_self");
  expect(new FormData(form).entries().next().done).toBe(true);
  let allowed = false;
  const intercept = (event: Event) => { allowed = !event.defaultPrevented; event.preventDefault(); };
  document.addEventListener("submit", intercept, { once: true });
  fireEvent.submit(form);
  expect(allowed).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("shows generic sign-in feedback when the configured origin does not match", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "unauthenticated" } }, { status: 401 })));
  render(<AccountPanel appOrigin="https://other.example" />);
  const form = (await screen.findByRole("button", { name: "Sign in with Google" })).closest("form")!;
  expect(fireEvent.submit(form)).toBe(false);
  expect(screen.getByText("Could not start sign-in. Please try again.")).toBeTruthy();
});

it("shows denied state and signs out with session CSRF without touching local data", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "forbidden" } }, { status: 403 }))
    .mockResolvedValueOnce(Response.json({ csrfToken: "token" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AccountPanel appOrigin="http://localhost:3000" />);
  await screen.findByText(/not authorized/);
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText(/Signed out. Your local library/);
  expect(fetchMock.mock.calls[2][1].headers["x-csrf-token"]).toBe("token");
});

it("does not restore links when an account operation completes after sign-out", async () => {
  let resolveMutation!: (response: Response) => void;
  const mutation = new Promise<Response>((resolve) => { resolveMutation = resolve; });
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ links: [{ youtubePlaylistId: "PL1234567890", createdAt: "2026-01-01" }] }))
    .mockResolvedValueOnce(Response.json({ csrfToken: "token" })).mockReturnValueOnce(mutation)
    .mockResolvedValueOnce(Response.json({ csrfToken: "token" })).mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AccountPanel appOrigin="http://localhost:3000" />);
  fireEvent.click(await screen.findByRole("button", { name: /Remove saved link/ }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText(/Signed out. Your local library/);
  resolveMutation(new Response(null, { status: 204 }));
  await waitFor(() => expect(screen.queryByText("PL1234567890")).toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(5);
});

it("sends playlist intent and translates structured auth errors", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: { code: "unauthenticated" } }, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(fetchPlaylistDataFromProxy("PL1234567890")).rejects.toThrow("Please sign in");
  expect(fetchMock.mock.calls[0][1].headers["x-tubeshuffle-intent"]).toBe("playlist");
});

it.each(["unauthenticated", "forbidden"])("clears links after %s from CSRF", async (code) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ links: [{ youtubePlaylistId: "PL1234567890", createdAt: "today" }] }))
    .mockResolvedValueOnce(Response.json({ error: { code } }, { status: 403 })));
  render(<AccountPanel appOrigin="http://localhost:3000" />);
  fireEvent.click(await screen.findByRole("button", { name: /Remove saved link/ }));
  await waitFor(() => expect(screen.queryByText("PL1234567890")).toBeNull());
  if (code === "forbidden") expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  else expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
});

it.each(["unauthenticated", "forbidden"])("clears links after %s from link endpoint", async (code) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ links: [{ youtubePlaylistId: "PL1234567890", createdAt: "today" }] }))
    .mockResolvedValueOnce(Response.json({ csrfToken: "token" }))
    .mockResolvedValueOnce(Response.json({ error: { code } }, { status: 403 })));
  render(<AccountPanel appOrigin="http://localhost:3000" />);
  fireEvent.click(await screen.findByRole("button", { name: /Remove saved link/ }));
  await waitFor(() => expect(screen.queryByText("PL1234567890")).toBeNull());
  expect(screen.getByRole("button", { name: code === "forbidden" ? "Sign out" : "Sign in with Google" })).toBeTruthy();
});

it("blocks a queued retry during logout and ignores a late account response", async () => {
  let resolveLogout!: (response: Response) => void;
  const logout = new Promise<Response>((resolve) => { resolveLogout = resolve; });
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "auth_unavailable" } }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ csrfToken: "token" })).mockReturnValueOnce(logout);
  vi.stubGlobal("fetch", fetchMock);
  render(<AccountPanel appOrigin="http://localhost:3000" />);
  const retry = await screen.findByRole("button", { name: "Retry account" });
  act(() => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); fireEvent.click(retry); });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  await act(async () => resolveLogout(new Response(null, { status: 204 })));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
});

it("does not issue a link request after a delayed CSRF response following logout", async () => {
  let resolveCsrf!: (response: Response) => void;
  const csrf = new Promise<Response>((resolve) => { resolveCsrf = resolve; });
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ links: [{ youtubePlaylistId: "PL1234567890", createdAt: "today" }] }))
    .mockReturnValueOnce(csrf).mockResolvedValueOnce(Response.json({ csrfToken: "logout-token" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AccountPanel appOrigin="http://localhost:3000" />);
  fireEvent.click(await screen.findByRole("button", { name: /Remove saved link/ }));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText(/Signed out. Your local library/);
  await act(async () => resolveCsrf(Response.json({ csrfToken: "old-token" })));
  expect(fetchMock).toHaveBeenCalledTimes(4);
  expect(screen.queryByText("PL1234567890")).toBeNull();
});

it("ignores a late retry response after logout completes", async () => {
  let resolveRetry!: (response: Response) => void;
  const retry = new Promise<Response>((resolve) => { resolveRetry = resolve; });
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { code: "auth_unavailable" } }, { status: 503 }))
    .mockReturnValueOnce(retry).mockResolvedValueOnce(Response.json({ csrfToken: "token" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<AccountPanel appOrigin="http://localhost:3000" />);
  const retryButton = await screen.findByRole("button", { name: "Retry account" });
  act(() => { fireEvent.click(retryButton); fireEvent.click(screen.getByRole("button", { name: "Sign out" })); });
  await screen.findByText(/Signed out. Your local library/);
  await act(async () => resolveRetry(Response.json({ links: [{ youtubePlaylistId: "PLold", createdAt: "today" }] })));
  expect(screen.queryByText("PLold")).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
});

it("ignores a late forbidden link response after logout", async () => {
  let resolveLink!: (response: Response) => void;
  const link = new Promise<Response>((resolve) => { resolveLink = resolve; });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ links: [{ youtubePlaylistId: "PL1234567890", createdAt: "today" }] }))
    .mockResolvedValueOnce(Response.json({ csrfToken: "token" })).mockReturnValueOnce(link)
    .mockResolvedValueOnce(Response.json({ csrfToken: "token" })).mockResolvedValueOnce(new Response(null, { status: 204 })));
  render(<AccountPanel appOrigin="http://localhost:3000" />);
  fireEvent.click(await screen.findByRole("button", { name: /Remove saved link/ }));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  await screen.findByText(/Signed out. Your local library/);
  await act(async () => resolveLink(Response.json({ error: { code: "forbidden" } }, { status: 403 })));
  expect(screen.queryByText(/not authorized/)).toBeNull();
  expect(screen.getByRole("button", { name: "Sign in with Google" })).toBeTruthy();
});

it.each([
  { error: { code: "unexpected", message: "secret-token" } },
  { error: { code: "__proto__", message: "secret-token" } },
  { error: "secret-token" },
  { error: { message: "secret-token" } },
  null,
])("does not display untrusted error envelopes: %j", async (body) => {
  const error = await responseError(Response.json(body, { status: 500 }));
  expect(error.message).toBe("Request failed. Please try again.");
});
