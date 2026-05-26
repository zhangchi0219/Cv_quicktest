import { useEffect, useRef } from "react";
import type { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import type { LessonProps } from "../types";

const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const COLOR_LEFT = "#22d3ee";
const COLOR_RIGHT = "#f472b6";

type Vec3 = { x: number; y: number; z: number };
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (u: Vec3, v: Vec3): Vec3 => ({
  x: u.y * v.z - u.z * v.y,
  y: u.z * v.x - u.x * v.z,
  z: u.x * v.y - u.y * v.x,
});
const length3 = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const dist3 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

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

// Canvas is CSS-mirrored (scaleX(-1)) for the user-facing view. Text drawn
// directly reads backwards. Counter-mirror with a local transform.
function drawMirroredText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: { color: string; font?: string; bg?: string },
) {
  const font = options.font ?? "bold 16px system-ui, -apple-system, sans-serif";
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(-1, 1);
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (options.bg) {
    const metrics = ctx.measureText(text);
    const padX = 6;
    const padY = 4;
    const tw = metrics.width + padX * 2;
    const th = 20 + padY * 2;
    ctx.fillStyle = options.bg;
    ctx.fillRect(-tw / 2, -th / 2, tw, th);
  }
  ctx.fillStyle = options.color;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const angle = Math.atan2(y1 - y0, x1 - x0);
  const head = 10;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - head * Math.cos(angle - Math.PI / 6),
    y1 - head * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    x1 - head * Math.cos(angle + Math.PI / 6),
    y1 - head * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

export function Component({ videoRef, detectors, cameraReady }: LessonProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!cameraReady || !detectors) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastTime = -1;
    const loop = () => {
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const result = detectors.hand.detectForVideo(video, performance.now());
        const w = canvas.width;
        const h = canvas.height;

        for (let i = 0; i < result.landmarks.length; i++) {
          const lm = result.landmarks[i];
          const wm = result.worldLandmarks[i];
          const handed = result.handedness[i]?.[0]?.categoryName ?? "Right";
          const color = handed === "Left" ? COLOR_LEFT : COLOR_RIGHT;
          const isLeft = handed === "Left";

          drawHandSkeleton(ctx, lm, color);

          // Thumb tip (4) ↔ ring tip (16) distance, in meters from worldLandmarks.
          const distMeters = dist3(wm[4] as Landmark, wm[16] as Landmark);
          const distCm = distMeters * 100;
          const t4 = lm[4];
          const r16 = lm[16];
          if (t4 && r16) {
            ctx.save();
            ctx.strokeStyle = "#facc15";
            ctx.lineWidth = 2;
            ctx.setLineDash([6, 4]);
            ctx.beginPath();
            ctx.moveTo(t4.x * w, t4.y * h);
            ctx.lineTo(r16.x * w, r16.y * h);
            ctx.stroke();
            ctx.restore();
            drawMirroredText(
              ctx,
              `${distCm.toFixed(1)} cm`,
              ((t4.x + r16.x) / 2) * w,
              ((t4.y + r16.y) / 2) * h - 14,
              { color: "#facc15", bg: "rgba(0,0,0,0.55)" },
            );
          }

          // Palm normal: cross of (p5−p0) and (p17−p0) in world coords. Right
          // hand: palm-toward-camera → normal.z negative (MediaPipe z<0 = closer
          // to camera). Left hand: triplet is mirrored, so cross flips sign;
          // negate to keep the same "palm faces camera ⇒ z<0" convention.
          const p0 = wm[0] as Landmark;
          const p5 = wm[5] as Landmark;
          const p17 = wm[17] as Landmark;
          const v1 = sub(p5, p0);
          const v2 = sub(p17, p0);
          let normal = cross(v1, v2);
          if (isLeft) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
          const nlen = length3(normal);
          const nUnit =
            nlen > 1e-9
              ? { x: normal.x / nlen, y: normal.y / nlen, z: normal.z / nlen }
              : { x: 0, y: 0, z: 0 };

          // Palm center in screen coords — midpoint of wrist and middle MCP.
          const palmCx = ((lm[0].x + lm[9].x) / 2) * w;
          const palmCy = ((lm[0].y + lm[9].y) / 2) * h;

          // Arrow direction: the (x, y) projection of the unit normal. Length
          // = how tilted the palm is away from the camera-facing axis (the more
          // the normal lies in the image plane, the longer the 2D projection).
          // Scale by the pixel distance wrist→middle_MCP so the arrow is sized
          // relative to the hand on screen.
          const handScale = Math.hypot(
            (lm[9].x - lm[0].x) * w,
            (lm[9].y - lm[0].y) * h,
          );
          const arrowLen = handScale * 1.2;
          const ax = palmCx + nUnit.x * arrowLen;
          const ay = palmCy + nUnit.y * arrowLen;
          drawArrow(ctx, palmCx, palmCy, ax, ay, "#a3e635");

          const facingLabel = nUnit.z < 0 ? "掌心" : "手背";
          drawMirroredText(ctx, facingLabel, palmCx, palmCy - 18, {
            color: "#a3e635",
            bg: "rgba(0,0,0,0.55)",
          });

          // Height + depth readout near the wrist. y is normalized image
          // coord (0 = top of frame). z from image-space landmarks is signed
          // depth in same scale as x (image width); convert to a rough %
          // relative to image width with sign for intuition. (worldLandmarks
          // z is hand-centered, not camera-centered, so it isn't what users
          // mean by "how far the hand is from the camera".)
          const wrist = lm[0];
          const yPct = wrist.y;
          const zPct = wrist.z * 100;
          drawMirroredText(
            ctx,
            `${isLeft ? "左手" : "右手"}  y=${yPct.toFixed(2)}  z=${zPct >= 0 ? "+" : ""}${zPct.toFixed(1)}%`,
            wrist.x * w,
            wrist.y * h + 28,
            { color, bg: "rgba(0,0,0,0.6)" },
          );
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cameraReady, detectors, videoRef]);

  return <canvas ref={canvasRef} className="lesson-canvas" />;
}

export function Explainer() {
  return (
    <>
      <h3>做什么</h3>
      <p>
        把 <code>HandLandmarker</code> 已经返回的几何信息显式可视化：
        <strong>拇指↔无名指真实距离</strong>、<strong>手掌法向量</strong>（正反面 +
        箭头方向）、<strong>手在画面中的高低和前后</strong>。21 点本身画在那里，
        其它都是从这 21 点 + <code>worldLandmarks</code> 计算出来的。
      </p>

      <h3><code>landmarks</code> vs <code>worldLandmarks</code></h3>
      <ul>
        <li>
          <code>landmarks</code>：图像归一化坐标，<code>x, y ∈ [0, 1]</code>，
          <code>z</code> 是相对于手腕的深度（与 x 同尺度，负=更近）。
          用来画到屏幕上的就是它。
        </li>
        <li>
          <code>worldLandmarks</code>：以手几何中心为原点的<strong>米</strong>单位
          3D 坐标。用来测真实长度的就是它。
        </li>
      </ul>

      <h3>拇指 ↔ 无名指距离</h3>
      <p>
        <code>‖worldLandmarks[4] − worldLandmarks[16]‖</code>。
        因为是基于<strong>平均手部模型</strong>缩放出来的，绝对值有几毫米误差，
        但相对变化（捏合/张开的趋势）很准。捏到一起时 ~0，最张开时 ~10 cm。
      </p>

      <h3>手掌法向量（绿色箭头）</h3>
      <ol>
        <li>
          取三个非共线点 <code>0</code>（手腕）、<code>5</code>（食指 MCP）、
          <code>17</code>（小指 MCP）
        </li>
        <li>
          <code>v₁ = p₅ − p₀</code>，<code>v₂ = p₁₇ − p₀</code>，
          <strong>法向量 n = v₁ × v₂</strong>（叉乘）
        </li>
        <li>
          <strong>左右手手序相反</strong>，叉乘符号会翻：左手时把 n 整体取负，
          统一约定为「掌心朝相机 ⇒ n.z &lt; 0」（MediaPipe 里 z 越负越靠近相机）
        </li>
        <li>
          屏幕上的箭头 = 把单位法向量的 <code>(x, y)</code> 分量按手的像素大小放大；
          手掌正对相机时投影几乎为 0（箭头很短），手掌侧立时箭头最长
        </li>
      </ol>

      <h3>手的"高低"为什么有两种</h3>
      <ul>
        <li>
          <strong>屏幕高低</strong> <code>y</code>：手腕的归一化图像 y，
          0 = 画面顶、1 = 画面底
        </li>
        <li>
          <strong>前后深度</strong> <code>z</code>：手腕在<strong>图像坐标系</strong>
          下的 z（不是 worldLandmarks 的 z — 那是手内部的相对深度，不能用来表示
          "离镜头多远"）。这里展示成与图像宽度的百分比，符号代表前后
        </li>
      </ul>

      <h3>试试</h3>
      <p>
        捏拇指和无名指看 cm 读数；手心 / 手背来回翻看绿色标签和箭头长度变化；
        手在画面里上下移动 / 前后推拉看 y 和 z 数字怎么走。
      </p>
    </>
  );
}
