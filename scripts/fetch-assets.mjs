#!/usr/bin/env node
// Downloads MediaPipe WASM + model files into public/mediapipe/ as a local
// fallback. The CDN is still the default at runtime; these copies are only
// served when the probe in src/cv/mediapipe.ts can't reach the CDN.
// Idempotent: skips files that already exist.

import { mkdir, writeFile, stat, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const MP_VERSION = "0.10.35";
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL_BASE = "https://storage.googleapis.com/mediapipe-models";

const FILES = [
  ["wasm/vision_wasm_internal.js", `${WASM_BASE}/vision_wasm_internal.js`],
  ["wasm/vision_wasm_internal.wasm", `${WASM_BASE}/vision_wasm_internal.wasm`],
  ["wasm/vision_wasm_nosimd_internal.js", `${WASM_BASE}/vision_wasm_nosimd_internal.js`],
  ["wasm/vision_wasm_nosimd_internal.wasm", `${WASM_BASE}/vision_wasm_nosimd_internal.wasm`],
  [
    "models/hand_landmarker.task",
    `${MODEL_BASE}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  ],
];

async function exists(path) {
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
  return bytes + " B";
}

async function fetchOne(relPath, url) {
  const dest = resolve(ROOT, "public/mediapipe", relPath);
  if (await exists(dest)) {
    console.log(`  skip  ${relPath} (already present)`);
    return;
  }
  process.stdout.write(`  fetch ${relPath} ... `);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  // Write to a .partial sibling first, then atomically rename. A Ctrl-C
  // mid-write otherwise leaves a truncated file at `dest` that the
  // `exists(size > 0)` check would silently skip on the next run, and that
  // MediaPipe would later fail to parse with an opaque error.
  const tmp = dest + ".partial";
  try {
    await writeFile(tmp, buf);
    await rename(tmp, dest);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  console.log(fmtSize(buf.length));
}

console.log(`Fetching MediaPipe assets (v${MP_VERSION}) into public/mediapipe/`);
for (const [rel, url] of FILES) {
  await fetchOne(rel, url);
}
console.log("Done.");
