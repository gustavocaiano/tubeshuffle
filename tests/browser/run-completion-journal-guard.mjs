// Native IndexedDB integration test. Set CHROMIUM_PATH to a local Chrome/Chromium executable.
// No existing browser profile, server, database, or user data is used.
//
// JOURNAL_GUARD_MODE=upgrade selects the separate test-only schema-upgrade
// rehearsal. JOURNAL_GUARD_MODE=lifecycle selects the separate test-only
// browser DB lifecycle guard. JOURNAL_GUARD_TEST_CLEANUP_FAULT=1 runs a
// focused, inert-by-default self-check of the fail-closed fixture-removal
// decision.
//
// Isolation is deliberately layered but not absolute: Chrome runs in a fresh
// profile with HOME/XDG/TMPDIR redirected under one exclusive fixture directory,
// the server binds only to 127.0.0.1, and the page is served with CSP plus a
// host-resolver rule that blocks non-loopback hostnames. Those browser controls
// are best-effort, not an OS network firewall or a sandbox. SIGINT, SIGTERM, and
// SIGHUP are handled with bounded cleanup serialized against startup; SIGKILL
// cannot be caught by this process.
import { build } from "esbuild";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const chrome = process.env.CHROMIUM_PATH;
if (!chrome) {
  throw new Error(
    "Set CHROMIUM_PATH to the Chrome or Chromium executable to run browser tests.",
  );
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The default journal mode is unchanged. `JOURNAL_GUARD_MODE=upgrade` selects
// the separate test-only schema-upgrade rehearsal and its own exact allowlist.
// `JOURNAL_GUARD_MODE=lifecycle` selects the separate test-only lifecycle
// guard and its own exact allowlist.
const mode = process.env.JOURNAL_GUARD_MODE ?? "journal";
if (mode !== "journal" && mode !== "upgrade" && mode !== "lifecycle") {
  throw new Error(
    `JOURNAL_GUARD_MODE must be "journal", "upgrade", or "lifecycle", got ${JSON.stringify(mode)}.`,
  );
}
const tempPrefix = "completion-journal-guard-";
const timeoutMs = 60_000;
let temp;
let profile;
let browser;
let server;
let timeout;
let cleanupPromise;
let cleanupFailure;
let interruptedBy = null;
let signalExitCode;
const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 };
const startupShutdownWaitMs = 5_000;
const maxStartupTestDelayMs = 30_000;

// Startup and shutdown are serialized through this barrier. A signal handler
// waits for the main flow to reach its next startup checkpoint (or a bounded
// timeout) before cleaning up, so cleanup cannot remove the fixture while the
// main flow is still able to resume, listen, or spawn Chrome.
let startupSettledFlag = false;
let resolveStartupSettled;
const startupSettled = new Promise((resolveSettled) => {
  resolveStartupSettled = resolveSettled;
});

function markStartupSettled() {
  if (startupSettledFlag) return;
  startupSettledFlag = true;
  resolveStartupSettled();
}

function throwIfInterrupted(phase) {
  if (!interruptedBy) return;
  markStartupSettled();
  throw new Error(`Interrupted by ${interruptedBy} during ${phase}`);
}

const startupTestPhase = process.env.JOURNAL_GUARD_TEST_STARTUP_PHASE ?? "";
const startupTestDelayValue = Number(
  process.env.JOURNAL_GUARD_TEST_STARTUP_DELAY_MS ?? 0,
);
const startupTestDelayMs =
  Number.isFinite(startupTestDelayValue) && startupTestDelayValue > 0
    ? Math.min(Math.trunc(startupTestDelayValue), maxStartupTestDelayMs)
    : 0;

// Test-only startup windows used by the interruption spot checks. Defaults are
// inert; the delay is bounded and every window rechecks the interruption flag
// immediately afterwards.
async function pauseForStartupTest(phase) {
  if (startupTestPhase !== phase || startupTestDelayMs === 0) return;
  console.error(`startup test phase: ${phase}`);
  await delay(startupTestDelayMs);
  throwIfInterrupted(`startup test phase ${phase}`);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveExit) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolveExit(value);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), milliseconds);
    child.once("exit", onExit);
  });
}

async function stopBrowser(child) {
  if (!child?.pid) return true;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    if (!(await waitForExit(child, 5_000))) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      if (!(await waitForExit(child, 2_000))) return false;
    }
  }
  // The child was spawned detached. Clear any remnant in its exclusive process
  // group before the profile directory is considered removable.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function groupState(pid) {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    if (error.code === "ESRCH") return "gone";
    return "unknown";
  }
}

async function waitForGroupGone(pid, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const state = groupState(pid);
    if (state === "gone") return true;
    if (state === "unknown") return false;
    await delay(50);
  }
  return groupState(pid) === "gone";
}

async function closeServer(instance) {
  if (!instance?.listening) return;
  instance.closeAllConnections?.();
  await new Promise((resolveClose) => {
    let settled = false;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveClose();
    };
    timer = setTimeout(finish, 3_000);
    instance.close(finish);
  });
}

async function verifyExclusiveFixture() {
  if (!temp) return { ok: false, reason: "no exclusive fixture path" };
  if (dirname(temp) !== tmpdir()) {
    return { ok: false, reason: "fixture is not under the system temp root" };
  }
  if (!basename(temp).startsWith(tempPrefix)) {
    return { ok: false, reason: "fixture basename does not match the runner prefix" };
  }
  let tempInfo;
  try {
    tempInfo = await lstat(temp);
  } catch (error) {
    return { ok: false, reason: `fixture stat failed: ${String(error)}` };
  }
  if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink()) {
    return { ok: false, reason: "fixture is not a real directory" };
  }
  if (typeof process.getuid === "function" && tempInfo.uid !== process.getuid()) {
    return { ok: false, reason: "fixture is not owned by this process user" };
  }
  if ((tempInfo.mode & 0o077) !== 0) {
    return { ok: false, reason: "fixture is accessible by group or other users" };
  }
  if (profile) {
    try {
      const profileInfo = await lstat(profile);
      if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) {
        return { ok: false, reason: "profile is not a real directory" };
      }
      if (
        typeof process.getuid === "function" &&
        profileInfo.uid !== process.getuid()
      ) {
        return { ok: false, reason: "profile is not owned by this process user" };
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        return { ok: false, reason: `profile stat failed: ${String(error)}` };
      }
    }
  }
  return { ok: true };
}

function recordCleanupFailure(message) {
  cleanupFailure = cleanupFailure ? `${cleanupFailure}; ${message}` : message;
  console.error(message);
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Removal is fail-closed: any uncertainty retains the fixture and reports a
// failure. `removed` becomes true only after the removal call actually succeeds.
async function removeFixtureIfConfirmedSafe(
  fixturePath,
  { reaped, groupGone, ownershipOk, ownershipReason, remove = rm },
) {
  if (!fixturePath) {
    return { removed: false, failure: "no exclusive fixture path" };
  }
  if (!ownershipOk) {
    return {
      removed: false,
      failure: `Fixture ownership check failed: ${ownershipReason ?? "unknown reason"}`,
    };
  }
  if (!reaped) {
    return {
      removed: false,
      failure:
        "Chrome reap was not confirmed; retaining the disposable fixture",
    };
  }
  if (!groupGone) {
    return {
      removed: false,
      failure:
        "Chrome process group was not confirmed gone; retaining the disposable fixture",
    };
  }
  try {
    await remove(fixturePath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    return { removed: true };
  } catch (error) {
    return {
      removed: false,
      failure: `Fixture removal failed: ${String(error)}`,
    };
  }
}

// Focused, opt-in fault injection for the cleanup decision. It uses probe
// directories inside the exclusive fixture root and a throwing fake remover;
// it never changes how the real browser profile is removed. Default is inert.
async function runCleanupFaultInjectionCheck() {
  if (process.env.JOURNAL_GUARD_TEST_CLEANUP_FAULT !== "1") return;
  if (!temp) {
    throw new Error("cleanup fault injection requires the exclusive fixture root");
  }
  const retainedProbe = join(temp, `cleanup-probe-retained-${randomUUID()}`);
  const removedProbe = join(temp, `cleanup-probe-removed-${randomUUID()}`);
  mkdirSync(retainedProbe, { recursive: true, mode: 0o700 });
  mkdirSync(removedProbe, { recursive: true, mode: 0o700 });
  try {
    const unconfirmedReap = await removeFixtureIfConfirmedSafe(retainedProbe, {
      reaped: false,
      groupGone: true,
      ownershipOk: true,
    });
    if (unconfirmedReap.removed) {
      throw new Error("unconfirmed reap reported removed");
    }
    if (!/reap was not confirmed/i.test(unconfirmedReap.failure ?? "")) {
      throw new Error(
        `unconfirmed reap did not report a failure: ${String(
          unconfirmedReap.failure,
        )}`,
      );
    }
    if (!(await pathExists(retainedProbe))) {
      throw new Error("unconfirmed reap removed the fixture");
    }

    const unconfirmedGroup = await removeFixtureIfConfirmedSafe(
      retainedProbe,
      {
        reaped: true,
        groupGone: false,
        ownershipOk: true,
      },
    );
    if (unconfirmedGroup.removed) {
      throw new Error("unconfirmed process-group exit reported removed");
    }
    if (!/process group was not confirmed gone/i.test(unconfirmedGroup.failure ?? "")) {
      throw new Error(
        `unconfirmed process-group exit did not report a failure: ${String(
          unconfirmedGroup.failure,
        )}`,
      );
    }
    if (!(await pathExists(retainedProbe))) {
      throw new Error("unconfirmed process-group exit removed the fixture");
    }

    const failedRemoval = await removeFixtureIfConfirmedSafe(retainedProbe, {
      reaped: true,
      groupGone: true,
      ownershipOk: true,
      remove: async () => {
        throw new Error("injected removal failure");
      },
    });
    if (failedRemoval.removed || !failedRemoval.failure) {
      throw new Error("failed removal was reported as removed");
    }
    if (!(await pathExists(retainedProbe))) {
      throw new Error("failed removal removed the fixture");
    }

    const confirmedRemoval = await removeFixtureIfConfirmedSafe(removedProbe, {
      reaped: true,
      groupGone: true,
      ownershipOk: true,
    });
    if (!confirmedRemoval.removed || confirmedRemoval.failure) {
      throw new Error(
        `confirmed removal did not report removed: ${String(
          confirmedRemoval.failure,
        )}`,
      );
    }
    if (await pathExists(removedProbe)) {
      throw new Error("confirmed removal left the fixture on disk");
    }

    console.error("cleanup fault-injection check: passed");
  } finally {
    await rm(retainedProbe, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    }).catch(() => undefined);
    await rm(removedProbe, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    }).catch(() => undefined);
  }
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    clearTimeout(timeout);
    let reaped = false;
    try {
      reaped = await stopBrowser(browser);
    } catch (error) {
      recordCleanupFailure(`Chrome stop failed: ${String(error)}`);
    }

    let groupGone = true;
    if (browser?.pid) {
      groupGone = await waitForGroupGone(browser.pid, 2_000);
    }

    try {
      await closeServer(server);
    } catch (error) {
      recordCleanupFailure(`Loopback server close failed: ${String(error)}`);
    }

    const ownership = await verifyExclusiveFixture();
    const removal = await removeFixtureIfConfirmedSafe(temp, {
      reaped,
      groupGone,
      ownershipOk: ownership.ok,
      ownershipReason: ownership.reason,
    });
    if (removal.failure) {
      recordCleanupFailure(removal.failure);
    }
    if (removal.removed) {
      console.error(`Removed the disposable fixture at ${temp}`);
    } else if (temp) {
      console.error(
        `Retaining the disposable fixture at ${temp}; cleanup is not confirmed safe`,
      );
    }

    if (cleanupFailure) {
      process.exitCode = Math.max(process.exitCode ?? 0, 1);
    }
    return { removed: removal.removed, failure: cleanupFailure };
  })();
  return cleanupPromise;
}

async function shutdownAfterStartup() {
  const boundary = await Promise.race([
    startupSettled.then(() => "settled"),
    delay(startupShutdownWaitMs).then(() => "timeout"),
  ]);
  if (boundary === "timeout" && !startupSettledFlag) {
    console.error(
      "Startup did not reach a quiescent checkpoint within the shutdown bound; cleanup will proceed and no further resources will be started.",
    );
  }
  try {
    await cleanup();
  } catch (error) {
    console.error(`Shutdown cleanup failed: ${String(error)}`);
  } finally {
    process.exit(signalExitCode ?? process.exitCode ?? 1);
  }
}

function interrupt(signal) {
  if (interruptedBy) return;
  interruptedBy = signal;
  signalExitCode = 128 + (signalNumbers[signal] ?? 1);
  process.exitCode = signalExitCode;
  console.error(`Interrupted by ${signal}; shutting down within bounds.`);
  void shutdownAfterStartup();
}

// Install interruption handlers before creating any fixture. SIGKILL is not
// catchable and cannot run this cleanup. SIGHUP is handled like the other
// catchable termination signals.
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
process.on("SIGHUP", interrupt);

temp = mkdtempSync(join(tmpdir(), tempPrefix));
chmodSync(temp, 0o700);
profile = join(temp, "profile");
const isolatedHome = join(temp, "home");
const isolatedTmp = join(temp, "tmp");
for (const directory of [
  isolatedHome,
  isolatedTmp,
  join(temp, "xdg-config"),
  join(temp, "xdg-cache"),
  join(temp, "xdg-data"),
  join(temp, "xdg-state"),
  join(temp, "xdg-runtime"),
]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const journalDbName = `tubeshuffle-journal-test-${randomUUID()}`;
const wrongDbName = `tubeshuffle-journal-other-${randomUUID()}`;
// A third fresh test-prefixed name is created from a same-origin iframe realm so
// the cross-realm database-handle behavior can be exercised without reusing the
// main fixture. It is still generated at runtime and allowlisted explicitly.
const iframeDbName = `tubeshuffle-journal-test-${randomUUID()}`;
if (new Set([journalDbName, wrongDbName, iframeDbName]).size !== 3) {
  throw new Error("Runner generated colliding fixture database names.");
}
// The upgrade rehearsal gets its own four runtime-unique names and exact
// per-mode allowlist. These are never used by the default journal mode.
const upgradeDbNames = [
  `tubeshuffle-journal-upgrade-test-${randomUUID()}`,
  `tubeshuffle-journal-upgrade-test-${randomUUID()}`,
  `tubeshuffle-journal-upgrade-test-${randomUUID()}`,
  `tubeshuffle-journal-upgrade-test-${randomUUID()}`,
];
if (new Set(upgradeDbNames).size !== 4) {
  throw new Error("Runner generated colliding upgrade fixture database names.");
}
// The lifecycle guard gets its own twenty-eight runtime-unique names and exact
// per-mode allowlist. These are never used by the journal or upgrade modes.
const lifecycleDbNames = Array.from(
  { length: 28 },
  () => `tubeshuffle-db-lifecycle-test-${randomUUID()}`,
);
if (new Set(lifecycleDbNames).size !== 28) {
  throw new Error("Runner generated colliding lifecycle fixture database names.");
}
const journalBootstrap = `(() => {
  const allowed = new Set(${JSON.stringify([journalDbName, wrongDbName, iframeDbName])});
  const production = "tubeshuffle_local";
  const nativeOpen = indexedDB.open.bind(indexedDB);
  const nativeDelete = indexedDB.deleteDatabase.bind(indexedDB);
  const nativeFetch = window.fetch.bind(window);
  const guard = {
    journalDbName: ${JSON.stringify(journalDbName)},
    wrongDbName: ${JSON.stringify(wrongDbName)},
    iframeDbName: ${JSON.stringify(iframeDbName)},
    allowed,
    openedNames: [],
    deleteNames: [],
    unexpectedOpenAttempts: [],
    unexpectedDeleteAttempts: [],
    productionOpenAttempts: 0,
    networkAttempts: 0,
    nativeFetch,
  };
  Object.defineProperty(window, "__journalGuard", {
    value: guard,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  indexedDB.open = function (name, version) {
    const text = String(name);
    guard.openedNames.push(text);
    if (!allowed.has(text)) {
      if (text === production) guard.productionOpenAttempts++;
      guard.unexpectedOpenAttempts.push(text);
      throw new Error("Unexpected IndexedDB open blocked: " + text);
    }
    return nativeOpen(name, version);
  };
  indexedDB.deleteDatabase = function (name) {
    const text = String(name);
    guard.deleteNames.push(text);
    if (!allowed.has(text)) {
      guard.unexpectedDeleteAttempts.push(text);
      throw new Error("Unexpected IndexedDB delete blocked: " + text);
    }
    return nativeDelete(name);
  };
  window.fetch = function (input) {
    guard.networkAttempts++;
    return Promise.reject(new Error("Network access is not allowed: " + String(input)));
  };
  if (window.XMLHttpRequest) {
    XMLHttpRequest.prototype.open = function () {
      guard.networkAttempts++;
      throw new Error("Network access is not allowed: XMLHttpRequest");
    };
  }
  for (const name of ["WebSocket", "EventSource"]) {
    if (name in window) {
      window[name] = function () {
        guard.networkAttempts++;
        throw new Error("Network access is not allowed: " + name);
      };
    }
  }
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function () {
      guard.networkAttempts++;
      return false;
    };
  }
})();`;

// Upgrade mode uses the same isolation layers but allows only its four
// runtime-unique fixture names. It blocks every deleteDatabase call, including
// fixture names: only removal of the whole ephemeral profile is permitted.
const upgradeBootstrap = `(() => {
  const names = ${JSON.stringify(upgradeDbNames)};
  const allowed = new Set(names);
  const production = "tubeshuffle_local";
  const nativeOpen = indexedDB.open.bind(indexedDB);
  const nativeFetch = window.fetch.bind(window);
  const guard = {
    mode: "upgrade",
    dbNames: names,
    allowed,
    openedNames: [],
    deleteNames: [],
    unexpectedOpenAttempts: [],
    productionOpenAttempts: 0,
    networkAttempts: 0,
    nativeFetch,
  };
  Object.defineProperty(window, "__journalGuard", {
    value: guard,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  indexedDB.open = function (name, version) {
    const text = String(name);
    guard.openedNames.push(text);
    if (!allowed.has(text)) {
      if (text === production) guard.productionOpenAttempts++;
      guard.unexpectedOpenAttempts.push(text);
      throw new Error("Unexpected IndexedDB open blocked: " + text);
    }
    return nativeOpen(name, version);
  };
  indexedDB.deleteDatabase = function (name) {
    const text = String(name);
    guard.deleteNames.push(text);
    throw new Error("deleteDatabase is not allowed in upgrade mode: " + text);
  };
  window.fetch = function (input) {
    guard.networkAttempts++;
    return Promise.reject(new Error("Network access is not allowed: " + String(input)));
  };
  if (window.XMLHttpRequest) {
    XMLHttpRequest.prototype.open = function () {
      guard.networkAttempts++;
      throw new Error("Network access is not allowed: XMLHttpRequest");
    };
  }
  for (const name of ["WebSocket", "EventSource"]) {
    if (name in window) {
      window[name] = function () {
        guard.networkAttempts++;
        throw new Error("Network access is not allowed: " + name);
      };
    }
  }
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function () {
      guard.networkAttempts++;
      return false;
    };
  }
})();`;

// Lifecycle mode uses the same isolation layers but allows only its twenty-eight
// runtime-unique fixture names. It blocks every deleteDatabase call, including
// fixture names: only removal of the whole ephemeral profile is permitted.
const lifecycleBootstrap = `(() => {
  const names = ${JSON.stringify(lifecycleDbNames)};
  const allowed = new Set(names);
  const production = "tubeshuffle_local";
  const nativeOpen = indexedDB.open.bind(indexedDB);
  const nativeFetch = window.fetch.bind(window);
  const guard = {
    mode: "lifecycle",
    dbNames: names,
    allowed,
    openedNames: [],
    deleteNames: [],
    unexpectedOpenAttempts: [],
    productionOpenAttempts: 0,
    networkAttempts: 0,
    nativeFetch,
  };
  Object.defineProperty(window, "__journalGuard", {
    value: guard,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  indexedDB.open = function (name, version) {
    const text = String(name);
    guard.openedNames.push(text);
    if (!allowed.has(text)) {
      if (text === production) guard.productionOpenAttempts++;
      guard.unexpectedOpenAttempts.push(text);
      throw new Error("Unexpected IndexedDB open blocked: " + text);
    }
    return nativeOpen(name, version);
  };
  indexedDB.deleteDatabase = function (name) {
    const text = String(name);
    guard.deleteNames.push(text);
    throw new Error("deleteDatabase is not allowed in lifecycle mode: " + text);
  };
  window.fetch = function (input) {
    guard.networkAttempts++;
    return Promise.reject(new Error("Network access is not allowed: " + String(input)));
  };
  if (window.XMLHttpRequest) {
    XMLHttpRequest.prototype.open = function () {
      guard.networkAttempts++;
      throw new Error("Network access is not allowed: XMLHttpRequest");
    };
  }
  for (const name of ["WebSocket", "EventSource"]) {
    if (name in window) {
      window[name] = function () {
        guard.networkAttempts++;
        throw new Error("Network access is not allowed: " + name);
      };
    }
  }
  if (navigator.sendBeacon) {
    navigator.sendBeacon = function () {
      guard.networkAttempts++;
      return false;
    };
  }
})();`;

const bootstrap =
  mode === "upgrade"
    ? upgradeBootstrap
    : mode === "lifecycle"
      ? lifecycleBootstrap
      : journalBootstrap;
const entryFile =
  mode === "upgrade"
    ? "tests/browser/journal-upgrade-guard.ts"
    : mode === "lifecycle"
      ? "tests/browser/db-lifecycle-guard.ts"
      : "tests/browser/completion-journal-guard.ts";

let finish;
const result = new Promise((resolveResult) => {
  finish = resolveResult;
});
let completed = false;
function complete(report) {
  if (completed) return;
  completed = true;
  finish(report);
}

let report;
try {
  throwIfInterrupted("before bundle build");
  await runCleanupFaultInjectionCheck();
  throwIfInterrupted("cleanup fault-injection check");
  await pauseForStartupTest("before-build");
  throwIfInterrupted("before bundle build");
  const bundle = await build({
    entryPoints: [resolve(root, entryFile)],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    tsconfig: resolve(root, "tsconfig.json"),
  });
  throwIfInterrupted("bundle build");
  await pauseForStartupTest("after-build");
  throwIfInterrupted("bundle build");

  server = createServer((req, res) => {
    const remote = req.socket.remoteAddress;
    if (remote !== "127.0.0.1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403).end();
      return;
    }

    if (req.method === "POST" && req.url === "/result") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        res.writeHead(204).end();
        complete(body);
      });
      return;
    }

    if (req.method === "GET" && req.url === "/boot.js") {
      res
        .writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        })
        .end(bootstrap);
      return;
    }

    if (req.method === "GET" && req.url === "/bundle.js") {
      res
        .writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        })
        .end(bundle.outputFiles[0].contents);
      return;
    }

    if (req.method === "GET" && req.url === "/frame.html") {
      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          // Same-origin blank fixture realm used only to obtain a database
          // handle from another realm. It executes no scripts and loads no
          // subresources.
          "Content-Security-Policy": "default-src 'none'",
          "X-Content-Type-Options": "nosniff",
        })
        .end('<!doctype html><meta charset="utf-8"><title>iframe fixture</title>');
      return;
    }

    if (req.method === "GET" && req.url === "/") {
      res
        .writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          // Best-effort browser policy, not an OS network firewall.
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'",
          "X-Content-Type-Options": "nosniff",
        })
        .end(
          '<!doctype html><meta charset="utf-8"><title>completion-journal-guard</title><script src="/boot.js"></script><script src="/bundle.js"></script>',
        );
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      if (startupTestPhase === "during-listen" && startupTestDelayMs > 0) {
        console.error("startup test phase: during-listen");
        setTimeout(resolveListen, startupTestDelayMs);
      } else {
        resolveListen();
      }
    });
  });
  throwIfInterrupted("loopback listen");
  await pauseForStartupTest("before-spawn");
  throwIfInterrupted("before Chrome spawn");
  const url = `http://127.0.0.1:${server.address().port}/`;

  browser = spawn(
    chrome,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-pings",
      "--disable-domain-reliability",
      `--user-data-dir=${profile}`,
      // Best-effort browser restriction, not an OS firewall. The page is served
      // from a literal loopback address and the CSP permits only same-origin
      // script/connect traffic.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      url,
    ],
    {
      stdio: "ignore",
      detached: true,
      env: {
        ...process.env,
        HOME: isolatedHome,
        XDG_CONFIG_HOME: join(temp, "xdg-config"),
        XDG_CACHE_HOME: join(temp, "xdg-cache"),
        XDG_DATA_HOME: join(temp, "xdg-data"),
        XDG_STATE_HOME: join(temp, "xdg-state"),
        XDG_RUNTIME_DIR: join(temp, "xdg-runtime"),
        TMPDIR: isolatedTmp,
      },
    },
  );
  throwIfInterrupted("Chrome spawn");

  timeout = setTimeout(
    () =>
      complete(
        JSON.stringify({
          ok: false,
          error: `Timed out after ${timeoutMs}ms waiting for browser completion barrier`,
        }),
      ),
    timeoutMs,
  );
  browser.once("error", (error) =>
    complete(JSON.stringify({ ok: false, error: String(error) })),
  );
  browser.once("exit", (code) =>
    complete(
      JSON.stringify({
        ok: false,
        error: `Chromium exited before completion: ${code}`,
      }),
    ),
  );

  // All resources that startup can create now exist. Release the signal
  // shutdown barrier before waiting for the browser report.
  markStartupSettled();
  const rawReport = await result;
  clearTimeout(timeout);
  try {
    const parsed = JSON.parse(rawReport);
    report =
      parsed && typeof parsed === "object"
        ? parsed
        : { ok: false, error: "Browser report was not an object" };
  } catch {
    report = {
      ok: false,
      error: `Invalid browser report: ${String(rawReport).slice(0, 500)}`,
    };
  }
  if (interruptedBy) {
    report = {
      ok: false,
      error: `Interrupted by ${interruptedBy} during the browser run`,
    };
  }
} catch (error) {
  markStartupSettled();
  report = {
    ok: false,
    error: error instanceof Error ? error.stack : String(error),
  };
}

const cleanupOutcome = await cleanup();
if (cleanupOutcome.failure) {
  if (report.ok) {
    report = { ok: false, error: `Cleanup failed: ${cleanupOutcome.failure}` };
  } else {
    report = {
      ...report,
      error: `${report.error ?? "browser test failed"}; cleanup failed: ${cleanupOutcome.failure}`,
    };
  }
}
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = Math.max(process.exitCode ?? 0, 1);
