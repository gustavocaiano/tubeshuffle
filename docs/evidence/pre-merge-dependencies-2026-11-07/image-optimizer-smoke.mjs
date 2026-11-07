// Run after the production build, from the repository root:
// NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
// NODE_OPTIONS="--no-experimental-webstorage --require=$PWD/tests/integration/network-guard.cjs" \
// node --test docs/evidence/pre-merge-dependencies-2026-11-07/image-optimizer-smoke.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";
import next from "next";
import sharp from "sharp";

const root = resolve(import.meta.dirname, "../../..");

test("built Next image optimizer with local synthetic assets", { timeout: 60000 }, async (t) => {
  assert.equal(process.env.NODE_ENV, "production");
  assert.equal(process.env.NEXT_TELEMETRY_DISABLED, "1");
  for (const name of ["YOUTUBE_API_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]) {
    assert.equal(process.env[name], undefined, `Do not run with ${name} configured`);
  }
  assert.equal(sharp.versions.sharp, "0.35.5");
  assert.equal(sharp.versions.rsvg, "2.63.2");
  const built = JSON.parse(await readFile(join(root, ".next/required-server-files.json"), "utf8"));
  assert.equal(built.config.images.dangerouslyAllowSVG, false);
  assert.equal(built.config.images.dangerouslyAllowLocalIP, false);
  assert.equal(built.config.images.remotePatterns.length, 4);
  assert.equal((await readFile(join(root, "src/config/macos-release.json"), "utf8")).trim(), "null");

  const fixtureDir = await mkdtemp(join(root, "public/__dependency-image-"));
  const app = next({ dev: false, dir: root, hostname: "127.0.0.1" });
  let server;
  t.after(async () => {
    try {
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
      }
      await app.close();
    } finally {
      await rm(fixtureDir, { recursive: true });
    }
  });

  for (const format of ["png", "jpeg", "webp", "avif"]) {
    await sharp({ create: { width: 128, height: 64, channels: 3, background: "#2580bb" } })
      .toFormat(format).toFile(join(fixtureDir, `color.${format}`));
  }
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="64"><rect width="128" height="64" fill="blue"/></svg>';
  const rejected = {
    "plain.svg": svg,
    "mislabelled.png": svg,
    "comment-avif.png": "<!--ftypavif-->" + svg,
    "comment-heic.png": "<!--ftypheic-->" + svg,
    "padded.png": " ".repeat(2048) + svg,
    "xml.png": '<?xml version="1.0"?>' + svg,
    "invalid.png": "synthetic non-image data",
  };
  for (const [file, contents] of Object.entries(rejected)) {
    await writeFile(join(fixtureDir, file), contents);
  }
  await app.prepare();
  server = createServer(app.getRequestHandler());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  function imageUrl(file) {
    const params = new URLSearchParams({ url: `/${basename(fixtureDir)}/${file}`, w: "32", q: "75" });
    return `${base}/_next/image?${params}`;
  }

  for (const format of ["png", "jpeg", "webp", "avif"]) {
    await t.test(`${format} decodes, resizes and converts to WebP`, async () => {
      const response = await fetch(imageUrl(`color.${format}`), {
        headers: { accept: "image/webp" }, signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/webp");
      assert.equal(response.headers.get("x-nextjs-cache"), "MISS");
      const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
      assert.equal(metadata.format, "webp");
      assert.equal(metadata.width, 32);
      assert.equal(metadata.height, 16);
    });
  }
  await t.test("optimized image cache and conditional request", async () => {
    const cached = await fetch(imageUrl("color.png"), { headers: { accept: "image/webp" } });
    await cached.arrayBuffer();
    assert.equal(cached.status, 200);
    assert.equal(cached.headers.get("x-nextjs-cache"), "HIT");
    const etag = cached.headers.get("etag");
    assert.ok(etag);
    const conditional = await fetch(imageUrl("color.png"), {
      // Explicit cache policy avoids fetch's automatic no-cache on conditionals.
      headers: { accept: "image/webp", "if-none-match": etag, "cache-control": "max-age=0" },
    });
    assert.equal(conditional.status, 304);
  });
  for (const file of Object.keys(rejected)) {
    await t.test(`rejects ${file}`, async () => {
      const response = await fetch(imageUrl(file), { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 400);
      assert.match(await response.text(), /not allowed|isn't a valid image/);
    });
  }
  await t.test("rejects unapproved remote source before fetching", async () => {
    const params = new URLSearchParams({ url: "https://synthetic.invalid/color.png", w: "32", q: "75" });
    const response = await fetch(`${base}/_next/image?${params}`);
    assert.equal(response.status, 400);
    assert.equal(await response.text(), '"url" parameter is not allowed');
  });
});
