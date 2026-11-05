// Native IndexedDB integration test. Set CHROMIUM_PATH to a local Chrome/Chromium executable.
// No existing browser profile, server, or database is ever used.
import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const chrome = process.env.CHROMIUM_PATH;
if (!chrome) throw new Error("Set CHROMIUM_PATH to the Chrome or Chromium executable to run browser tests.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temp = await mkdtemp(join(tmpdir(), "playlist-guard-"));
let browser;
let server;
try {
  const entry = process.argv[2] === "migration" ? "migration-guard.ts" : "playlist-guard.ts";
  const bundle = await build({ entryPoints: [resolve(root, "tests/browser", entry)], bundle: true, write: false, platform: "browser", format: "iife", tsconfig: resolve(root, "tsconfig.json") });
  let finish;
  const result = new Promise(resolveResult => { finish = resolveResult; });
  server = createServer((req, res) => {
    if (req.url === "/result" && req.method === "POST") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => { body += chunk; });
      req.on("end", () => { res.writeHead(204).end(); finish(body); });
    } else if (req.url === "/bundle.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].contents);
    } else if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><script src="/bundle.js"></script>');
    } else res.writeHead(404).end();
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  browser = spawn(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${join(temp, "profile")}`, url], { stdio: "ignore", detached: true });
  const timeout = setTimeout(() => finish(JSON.stringify({ ok: false, error: "Timed out waiting for browser completion barrier" })), 30000);
  browser.once("error", error => finish(JSON.stringify({ ok: false, error: String(error) })));
  browser.once("exit", code => finish(JSON.stringify({ ok: false, error: `Chromium exited before completion: ${code}` })));
  const report = JSON.parse(await result);
  clearTimeout(timeout);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  if (browser?.pid && browser.exitCode === null && browser.signalCode === null) {
    try { process.kill(-browser.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    await new Promise(resolveExit => browser.once("exit", resolveExit));
  }
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
