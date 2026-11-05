#!/usr/bin/env node
// Reuse the web favicon unchanged; iconutil packages its macOS/Retina sizes.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const source = await readFile(new URL("../../public/favicon.svg", import.meta.url));
const destination = fileURLToPath(new URL("../TubeShuffle/Resources/AppIcon.icns", import.meta.url));
const { width, height } = await sharp(source).metadata();
if (!width || width !== height) throw new Error("The app favicon must be square.");

const temporary = await mkdtemp(join(tmpdir(), "tubeshuffle-app-icon-"));
try {
  const iconset = join(temporary, "AppIcon.iconset");
  await mkdir(iconset);
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = points * scale;
      const filename = `icon_${points}x${points}${scale === 2 ? "@2x" : ""}.png`;
      await sharp(source, { density: 72 * pixels / width })
        .resize(pixels, pixels).png().toFile(join(iconset, filename));
    }
  }
  execFileSync("iconutil", ["--convert", "icns", "--output", destination, iconset]);
  console.log(destination);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
