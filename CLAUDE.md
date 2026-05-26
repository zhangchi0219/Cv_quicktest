# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

Teaching-oriented web app that demonstrates computer-vision concepts in the browser using the device camera. The current demo runs MediaPipe Tasks for hand landmarks and visualizes derived geometry (distances, palm orientation, normal vector) on top of the 21 keypoints; the longer-term plan is to add per-lesson interactive demos that visualize CV fundamentals (convolution, edges, color spaces, Haar cascades, etc.) alongside the modern ML detectors.

UI language is Chinese (zh-CN); explanatory copy in components should follow.

## Commands

```bash
npm run dev           # vite dev server (HMR)
npm run build         # tsc -b && vite build
npm run typecheck     # tsc -b --noEmit
npm run preview       # serve the production build
npm run fetch-assets  # download MediaPipe WASM + hand model into public/mediapipe/ (~8 MB, one-time, idempotent)
```

There is no test runner configured yet — add one only when a real test arrives.

## Architecture

The app is a single-page Vite + React + TS project organized as a **shell + lessons** structure. `src/App.tsx` is the shell — it owns the camera stream, the device picker, the detector instance, and renders a lesson nav. Each lesson under `src/lessons/NN-<name>/` is a self-contained component that receives the shared video ref + detectors and renders its own overlay inside the `.stage` div. Only one lesson is mounted at a time; switching tabs unmounts the previous lesson (triggering its rAF/cleanup) and mounts the next.

- `src/camera/useCamera.ts` — `getUserMedia` lifecycle as a hook. Owns the `MediaStream`, attaches it to a `<video>` ref, and exposes a discriminated-union state (`idle | loading | ready | error`). Stops the stream on unmount. Accepts an optional `deviceId` for the picker.
- `src/camera/useVideoDevices.ts` — `enumerateDevices` wrapper with a `refresh()` callback. App re-enumerates on `ready` and `error` so the device labels populate after the browser grants permission.
- `src/cv/mediapipe.ts` — single entry point `createDetectors()` that probes the CDN, loads the WASM fileset (jsDelivr or local fallback), and creates a `HandLandmarker` in `VIDEO` mode with the GPU delegate (CPU fallback). Returned `Detectors.source` is `"cdn" | "local"`. When adding more detectors, share the single `FilesetResolver` and parallelize the model downloads with `Promise.all` over `fetchBytes`.
- `src/lessons/types.ts` — the `Lesson` registry type and `LessonProps` (`{ videoRef, detectors, cameraReady }`).
- `src/lessons/index.ts` — array of lessons in display order. The App's nav iterates this.

**Per-lesson conventions:**

- A lesson lives at `NN-name/index.tsx` and exports two **named** components: `Component` (the lesson FC) and `Explainer` (the right-pane FC). No default export.
- The Component is mounted as a direct child of `.stage` (alongside the `<video>`). It typically renders a `<canvas>` styled `position: absolute; inset: 0; transform: scaleX(-1)` so it overlays the mirrored video.
- Per-lesson UI controls go in a `<div className="lesson-overlay-ui">` (top-right of the stage, no mirror). Don't put text-bearing UI inside something with `scaleX(-1)` — the text will read backwards. For text drawn into a mirrored canvas, counter-mirror with a local transform (`ctx.save(); ctx.translate(x,y); ctx.scale(-1,1); ctx.fillText(...); ctx.restore()`).
- The lesson runs its own rAF loop inside `useEffect`. Guard with `video.currentTime !== lastVideoTime` so `detectForVideo` only sees new frames (MediaPipe asserts on duplicate timestamps).

**Lessons currently shipped:**

- `03-hand-vectors` — pure 2D-canvas overlay on `HandLandmarker`. Draws the 21-point skeleton (cyan = left, pink = right) plus four derived layers: thumb↔ring real-world distance in cm (from `worldLandmarks`); palm normal as a green arrow + "掌心/手背" label (cross product of `(p₅−p₀) × (p₁₇−p₀)`, negated for the left hand to keep "palm-toward-camera ⇒ z<0"); wrist height (image y) + depth (image-space `landmarks[0].z`) chip. Geometry helpers (`sub`, `cross`, `dist3`, `length3`) are inlined at the top of the file — don't extract a shared math module until a second lesson needs the same shapes.

(Numbering starts at 03 because earlier face/pose and particle lessons were removed; nothing requires consecutive numbers and the next lesson can pick whatever NN reads well in the nav.)

## Library choices and why

- **MediaPipe Tasks (`@mediapipe/tasks-vision`)** is the chosen runtime for hand (and any future face/pose) landmarks. Google-maintained, low-latency, returns normalized landmarks with a stable topology, plus `worldLandmarks` in meters for real-world geometry. The WASM fileset and `.task` model files are loaded at runtime from CDN with a local fallback (see below).
- **No three.js right now.** It was used by a previous particle-system lesson and removed when that lesson was dropped. If a future lesson needs real-time GPU rendering (particles, 3D overlays), add it back as a lesson-local dep — lessons that only need 2D dots should stay on plain canvas2d (simpler, less code). Remember to add it back to `vite.config.ts` `manualChunks` so it ships only with the lesson that uses it.
- **OpenCV.js is planned but not yet added.** The intent is to use it for the "how does this work" lessons (manual convolution, Sobel/Canny, Haar cascades) where seeing the intermediate result matters more than detection accuracy. When adding it, prefer the `<script>` tag pattern (load `opencv.js` lazily per lesson) over npm — the npm package is awkward and the file is large enough that lazy-loading per-lesson is worth it.
- **No TensorFlow.js, no face-api.js.** If a future lesson needs a model MediaPipe doesn't cover (custom training, OCR, classification), reach for TF.js then — don't pre-emptively add it.

## Things to know when editing

- **Camera requires a secure context.** `getUserMedia` only works on `https://` or `http://localhost`. The Vite dev server on `localhost` is fine; if testing from another device on the LAN, you need HTTPS (configure `server.https` in `vite.config.ts` with a local cert).
- **MediaPipe timestamp monotonicity.** `detectForVideo(video, ts)` requires strictly increasing timestamps within a detector. Using `performance.now()` is fine; calling it twice in the same frame for the same detector is not.
- **`landmarks` vs `worldLandmarks`.** `landmarks` is image-normalized (`x, y ∈ [0,1]`, `z` signed depth in same scale as x with wrist as origin — use for drawing). `worldLandmarks` is in **meters** with origin at the hand geometric center — use for real-world distances. `worldLandmarks.z` is intra-hand depth, *not* distance from the camera; if you need camera distance, derive it from apparent size in the image.
- **Asset loading: CDN-first, local fallback.** `createDetectors` does a 3-second HEAD probe against the CDN WASM URL on startup. If it succeeds the detectors load from jsdelivr (WASM) and Google Storage (models). If it times out or 4xx/5xx's, everything is served from `public/mediapipe/` instead — populated by `npm run fetch-assets`. The chosen source is exposed as `Detectors.source` and shown in the status bar. The local copies live under `public/mediapipe/{wasm,models}/`, are gitignored (~8 MB for the hand model + WASM), and the fetch script is idempotent (skips existing files).
- **MediaPipe JS/WASM version pinning.** `@mediapipe/tasks-vision` in `package.json` is pinned to an exact version (no caret). The same version string appears in **three** places that must stay in lockstep: `package.json`, the `MP_VERSION` constant in `src/cv/mediapipe.ts`, and the `MP_VERSION` constant in `scripts/fetch-assets.mjs`. The JS bindings and WASM binary are tightly coupled — a mismatch (e.g. caret-bumped npm install + stale URL) 404s at runtime when the loader fetches a sub-resource that doesn't exist at the URL version. If you bump one, bump all three and re-run `npm run fetch-assets`.
- **Multiple cameras / virtual cameras.** `useVideoDevices` enumerates inputs and the App-level picker lets the user choose. Default device may be a virtual camera (OBS/Snap/Nvidia Broadcast) that has no live source and surfaces as `NotReadableError`. `useCamera` retries a few times with backoff to absorb the StrictMode teardown race, but a truly unreadable device still fails — the user has to pick a real one from the dropdown.
- **Deploy path: relative base.** `vite.config.ts` sets `base: "./"` so the built `dist/` is portable to any subpath (GitHub Pages `/repo/`, Cloudflare Pages, nested folders on a static host). Asset URLs in the generated HTML are relative (`./assets/...`). Any runtime asset path constructed in code (e.g., the local MediaPipe paths in `src/cv/mediapipe.ts`) **must** be prefixed with `import.meta.env.BASE_URL` — hard-coding a leading `/` will 404 on every non-root deploy.
- **Code splitting.** Lessons are lazy-loaded via `React.lazy(() => import("./NN-name").then(m => ({ default: m.Component })))` in `src/lessons/index.ts`. Each lesson directory exports **named** `Component` and `Explainer` (no default `Lesson` object) so the registry can split them out. `App.tsx` wraps both the active Component and active Explainer in `<Suspense>` boundaries. `vite.config.ts` `manualChunks` splits `react` and `@mediapipe/tasks-vision` into separate vendor chunks. If you add a heavy lesson-local dep (e.g. three.js, OpenCV.js), add it to `manualChunks` too so it ships only with the lesson that imports it.
- **Mirroring is cosmetic only.** The CSS `scaleX(-1)` flip is applied to both video and canvas so they stay aligned. Landmark coordinates from MediaPipe are in the original (un-mirrored) frame — handedness ("Left" / "Right") refers to the *user's* hands, but they appear on the opposite side of the screen because of the mirror.

## Adding a new lesson

1. Create `src/lessons/NN-name/index.tsx` with two **named** exports: `Component` (the lesson FC) and `Explainer` (the right-pane FC). No default export.
2. Add an entry to the `lessons` array in `src/lessons/index.ts` with `id`, `title`, `description`, and `lazy()`-wrapped imports for `Component` and `Explainer`. The lazy import is what keeps each lesson's deps out of the initial bundle.
3. Inside the Component:
   - Take `videoRef`, `detectors`, `cameraReady` from props. Don't grab the camera yourself.
   - Start your rAF loop in a `useEffect`. Return a cleanup that `cancelAnimationFrame`s and disposes any GPU/observer resources.
   - Use `performance.now()` for the MediaPipe timestamp; dedupe with `video.currentTime !== lastVideoTime`.
4. If the lesson needs a new MediaPipe model (e.g. gesture, segmentation, face, pose), add the detector inside `createDetectors`, extend the `Detectors` type (and the cleanup `close()` calls in `App.tsx`), and add the model file to `scripts/fetch-assets.mjs`. Re-run `npm run fetch-assets`.
5. Mirror: place visual overlays (canvas, three.js container) with `scaleX(-1)`; place text/UI without it (or counter-mirror per-text inside the canvas).

Lessons are deliberately independent — copy-paste between them is fine. Don't extract a shared "lesson runtime" abstraction until a third lesson makes the right shape obvious.
