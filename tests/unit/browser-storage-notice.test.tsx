import React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const session = vi.hoisted(() => ({
  state: { phase: "missing", generation: 0, eligibleForConfirmation: true },
  listeners: new Set<() => void>(), confirm: vi.fn(async () => {}), recheck: vi.fn(async () => {}),
}));
vi.mock("@/lib/storage/browser-session", () => ({
  getBrowserStorageState: () => session.state,
  getServerStorageState: () => session.state,
  subscribeBrowserStorage: (listener: () => void) => { session.listeners.add(listener); return () => session.listeners.delete(listener); },
  confirmBrowserStorageCreation: session.confirm,
  recheckBrowserStorage: session.recheck,
}));
import { BrowserStorageNotice } from "@/components/BrowserStorageNotice";

afterEach(() => { cleanup(); session.confirm.mockClear(); session.recheck.mockClear(); session.state = { phase: "missing", generation: 0, eligibleForConfirmation: true }; });

test("missing is not empty and cancel never invokes creation", () => {
  render(<BrowserStorageNotice />);
  expect(screen.getByText(/does not prove first use/)).toBeTruthy();
  expect(session.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Create an empty library…"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByText("Cancel"));
  expect(session.confirm).not.toHaveBeenCalled();
});

test("only the final explicit confirmation calls creation", async () => {
  render(<BrowserStorageNotice />);
  fireEvent.click(screen.getByText("Create an empty library…"));
  await act(async () => { fireEvent.click(screen.getByText("Confirm empty library")); });
  expect(session.confirm).toHaveBeenCalledTimes(1);
  act(() => { session.state = { phase: "ready", generation: 1, eligibleForConfirmation: false }; session.listeners.forEach(listener => listener()); });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("incompatible storage cannot offer replacement creation", async () => {
  session.state = { phase: "incompatible", generation: 1, eligibleForConfirmation: false };
  render(<BrowserStorageNotice />);
  expect(screen.queryByText("Create an empty library…")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByText("Check existing library again")); });
  expect(session.recheck).toHaveBeenCalledTimes(1);
  expect(session.confirm).not.toHaveBeenCalled();
});

test("marker failure discloses committed metadata without claiming rollback", () => {
  session.state = { phase: "marker-failed", generation: 1, eligibleForConfirmation: false };
  render(<BrowserStorageNotice />);
  expect(screen.getByText(/Local metadata was saved/)).toBeTruthy();
  expect(screen.getByText(/has not been rolled back/)).toBeTruthy();
  expect(screen.queryByText("Create an empty library…")).toBeNull();
});
