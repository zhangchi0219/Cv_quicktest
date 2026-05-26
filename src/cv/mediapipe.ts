import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

// MediaPipe JS bindings and WASM binary are tightly coupled — the version
// string here MUST match the @mediapipe/tasks-vision version in package.json.
const MP_VERSION = "0.10.35";

const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const CDN_HAND =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// Prefix with Vite's base so we resolve correctly whether deployed at the
// site root or a subpath (e.g., GitHub Pages /repo-name/).
const BASE = import.meta.env.BASE_URL;
const LOCAL_WASM = `${BASE}mediapipe/wasm`;
const LOCAL_HAND = `${BASE}mediapipe/models/hand_landmarker.task`;

const PROBE_TIMEOUT_MS = 3000;

// Approximate size (bytes) used to weight the progress bar. Doesn't need to
// match exactly — Content-Length from the server is the source of truth for
// actual bytes, this is just the denominator.
const TOTAL_MODEL_BYTES = 7_900_000;

export type Source = "cdn" | "local";

export type Detectors = {
  hand: HandLandmarker;
  source: Source;
};

export type ProgressCallback = (fraction: number, phase: string) => void;

async function probeCdn(signal?: AbortSignal): Promise<boolean> {
  // Compose the outer signal with our 3s timeout so an abort short-circuits
  // the probe immediately instead of waiting the full timeout.
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(`${CDN_WASM}/vision_wasm_internal.js`, {
      method: "HEAD",
      cache: "no-store",
      signal: probeSignal,
    });
    // 2xx — clearly reachable. 4xx (including 405 Method Not Allowed from
    // some corporate proxies that strip HEAD) and 5xx mean a server answered,
    // so the CDN is in fact reachable; only a thrown error (network down,
    // CORS preflight blocked, timeout) should force the local fallback.
    return res.status < 500;
  } catch {
    return false;
  }
}

// Try GPU first; fall back to CPU. iOS Safari frequently fails to allocate a
// WebGL2 context (memory pressure or missing float-buffer extension); CPU is
// slower but always available.
async function tryCreate<T>(
  factory: (delegate: "GPU" | "CPU") => Promise<T>,
  name: string,
): Promise<T> {
  try {
    return await factory("GPU");
  } catch (err) {
    console.warn(
      `[mediapipe] ${name} GPU delegate failed, retrying on CPU:`,
      err,
    );
    return await factory("CPU");
  }
}

async function fetchBytes(
  url: string,
  onDelta: (delta: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  // Detect captive-portal / proxy HTML interstitials that return 200 with an
  // HTML body. MediaPipe would otherwise consume them as a .task/.wasm and
  // throw an opaque "Invalid flatbuffer" / parse error.
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/html")) {
    throw new Error(
      `Expected binary model at ${url}, got text/html — likely a captive portal or proxy interstitial.`,
    );
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onDelta(buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        onDelta(value.length);
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  } finally {
    // Release the body stream lock on every path — without this, an abort
    // mid-stream keeps the underlying response (and its connection) pinned
    // in Firefox/Safari until GC.
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

export async function createDetectors(
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Detectors> {
  onProgress?.(0, "检查 CDN 可达性");
  const useCdn = await probeCdn(signal);
  signal?.throwIfAborted();
  const source: Source = useCdn ? "cdn" : "local";
  const wasmBase = useCdn ? CDN_WASM : LOCAL_WASM;
  const handPath = useCdn ? CDN_HAND : LOCAL_HAND;

  console.log(`[mediapipe] loading from ${source} (wasm=${wasmBase})`);
  onProgress?.(0.05, `加载 WASM 运行时（${source === "cdn" ? "CDN" : "本地"}）`);

  const vision = await FilesetResolver.forVisionTasks(wasmBase);
  signal?.throwIfAborted();
  onProgress?.(0.15, "下载模型权重");

  let bytesLoaded = 0;
  const onDelta = (delta: number) => {
    bytesLoaded += delta;
    const frac = Math.min(1, bytesLoaded / TOTAL_MODEL_BYTES);
    onProgress?.(0.15 + frac * 0.8, "下载模型权重");
  };

  const handBuf = await fetchBytes(handPath, onDelta, signal);

  signal?.throwIfAborted();
  onProgress?.(0.95, "初始化推理器");

  const hand = await tryCreate(
    (delegate) =>
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetBuffer: handBuf, delegate },
        runningMode: "VIDEO",
        numHands: 2,
      }),
    "hand",
  );

  if (signal?.aborted) {
    try {
      hand.close();
    } catch (err) {
      console.warn("[mediapipe] close() during cleanup failed:", err);
    }
    signal.throwIfAborted();
  }

  onProgress?.(1, "就绪");
  return { hand, source };
}
