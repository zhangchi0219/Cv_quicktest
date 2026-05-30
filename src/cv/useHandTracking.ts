import { useEffect, type RefObject } from "react";
import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { Detectors } from "./mediapipe";
import { landmarkBus } from "../particles/landmarkBus";

// Headless hand-tracking loop. This is the single rAF detection loop in the
// app: it runs MediaPipe HandLandmarker on the shared <video>, derives the
// signals the fusion scene needs (each hand's palm anchor + thumb↔index pinch
// distance), and publishes them on `landmarkBus` for ParticleStage to read on
// its own tick. Used to live inside the (now-removed) hand-vectors lesson; the
// teaching overlay (skeleton labels, palm normal, distance text) is gone — the
// only optional drawing here is a minimal 21-point skeleton onto the PiP
// overlay canvas so the user can see their hands are being tracked.
//
// Having exactly one detector loop also keeps MediaPipe's timestamp
// monotonicity trivially satisfied (no competing loops calling detectForVideo).

// 氘 = left hand (cyan), 氚 = right hand (violet) — matches the nucleus colors
// in ParticleStage.
const COLOR_DEUTERIUM = "#38bdf8";
const COLOR_TRITIUM = "#a78bfa";

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const dist3 = (a: Landmark, b: Landmark) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Map a raw normalized MediaPipe coord (spans the FULL camera frame) into the
// visible region that `object-fit: cover` actually shows on screen. When the
// camera aspect (vw/vh) differs from the display box aspect (dw/dh), the
// visible edge of the box corresponds to camera coords inset by the cropped
// margin — un-stretch so visible 0→1 fills [0,1] again. The scene then maps
// this [0,1] across the full-screen stage regardless of the PiP's pixel size.
function toVisibleNormalized(
  rawX: number, rawY: number,
  videoW: number, videoH: number,
  displayW: number, displayH: number,
): { x: number; y: number } | null {
  if (!videoW || !videoH || !displayW || !displayH) return null;
  const va = videoW / videoH;
  const da = displayW / displayH;
  let mx = 0;
  let my = 0;
  if (va > da) mx = (1 - da / va) / 2;       // wider cam, horizontal crop
  else if (va < da) my = (1 - va / da) / 2;  // taller cam, vertical crop
  const x = (rawX - mx) / (1 - 2 * mx);
  const y = (rawY - my) / (1 - 2 * my);
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function drawHandSkeleton(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  color: string,
) {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const p1 = landmarks[a];
    const p2 = landmarks[b];
    if (!p1 || !p2) continue;
    ctx.moveTo(p1.x * w, p1.y * h);
    ctx.lineTo(p2.x * w, p2.y * h);
  }
  ctx.stroke();
  ctx.fillStyle = color;
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function useHandTracking(
  videoRef: RefObject<HTMLVideoElement | null>,
  detectors: Detectors | null,
  cameraReady: boolean,
  overlayRef?: RefObject<HTMLCanvasElement | null>,
) {
  useEffect(() => {
    if (!cameraReady || !detectors) return;
    const video = videoRef.current;
    if (!video) return;
    const canvas = overlayRef?.current ?? null;
    const ctx = canvas?.getContext("2d") ?? null;

    let raf = 0;
    let lastTime = -1;
    const loop = () => {
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        if (ctx && canvas) {
          if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        const result = detectors.hand.detectForVideo(video, performance.now());

        let frameLeftPalm: { x: number; y: number } | null = null;
        let frameRightPalm: { x: number; y: number } | null = null;
        let frameLeftPinchCm: number | null = null;
        let frameRightPinchCm: number | null = null;

        for (let i = 0; i < result.landmarks.length; i++) {
          const lm = result.landmarks[i];
          const wm = result.worldLandmarks[i];
          const handed = result.handedness[i]?.[0]?.categoryName ?? "Right";
          const isLeft = handed === "Left";

          // Thumb tip (4) ↔ index tip (8) real-world distance in cm — drives
          // each nucleus cloud's radius (pinch → contract, open → expand).
          const pinchCm = dist3(wm[4] as Landmark, wm[8] as Landmark) * 100;
          // Wrist (0) remapped from raw-camera [0,1] into the visible region
          // of the cover-cropped video box — anchors the nucleus position.
          const remapped = toVisibleNormalized(
            lm[0].x, lm[0].y,
            video.videoWidth, video.videoHeight,
            video.clientWidth, video.clientHeight,
          );
          if (isLeft) {
            if (remapped) frameLeftPalm = remapped;
            frameLeftPinchCm = pinchCm;
          } else {
            if (remapped) frameRightPalm = remapped;
            frameRightPinchCm = pinchCm;
          }

          if (ctx) {
            drawHandSkeleton(ctx, lm, isLeft ? COLOR_DEUTERIUM : COLOR_TRITIUM);
          }
        }

        landmarkBus.latest = {
          landmarks: result.landmarks,
          leftPalm: frameLeftPalm,
          rightPalm: frameRightPalm,
          leftPinchCm: frameLeftPinchCm,
          rightPinchCm: frameRightPinchCm,
        };
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      // Stop the fusion scene from chasing ghost landmarks after unmount.
      landmarkBus.latest = null;
    };
  }, [cameraReady, detectors, videoRef, overlayRef]);
}
