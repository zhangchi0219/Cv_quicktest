import { useEffect, useState } from "react";

function buildConstraints(deviceId?: string): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
  if (deviceId) {
    video.deviceId = { exact: deviceId };
  } else {
    video.facingMode = "user";
  }
  return { video, audio: false };
}

// `navigator.mediaDevices` is undefined in non-secure contexts (http:// on a
// LAN IP, embedded WebViews without proper config). Without this check, we'd
// throw an opaque `TypeError: Cannot read properties of undefined` and the
// user has no idea they need to switch to https:// or localhost.
function assertSecureContext(): void {
  if (!navigator.mediaDevices?.getUserMedia) {
    const host = location.hostname;
    const isLocal =
      host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    const hint = isLocal
      ? "浏览器不支持 mediaDevices API（可能是非常旧的浏览器）。"
      : `当前页面 (${location.origin}) 不是安全上下文，浏览器禁用了摄像头 API。请改用 http://localhost:${location.port || "5173"} 打开，或为 LAN 地址配置 HTTPS。`;
    throw new Error(hint);
  }
}

// On Windows, some camera drivers don't release fast enough between
// StrictMode's double-mount, so the second getUserMedia hits NotReadableError.
// Retry a couple of times with backoff to ride out the driver teardown window.
async function acquireCamera(deviceId?: string): Promise<MediaStream> {
  assertSecureContext();
  const constraints = buildConstraints(deviceId);
  const delays = [0, 250, 600];
  let lastErr: unknown;
  for (const delay of delays) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
      if (!(err instanceof DOMException) || err.name !== "NotReadableError") {
        throw err;
      }
    }
  }
  throw lastErr;
}

// Map raw DOMException names to actionable Chinese messages.
function explainCameraError(err: unknown): string {
  if (err instanceof DOMException) {
    switch (err.name) {
      case "NotAllowedError":
        return "摄像头权限被拒绝。请在浏览器地址栏左侧的图标里把摄像头权限改为「允许」，然后刷新页面。";
      case "NotFoundError":
        return "没找到可用的摄像头设备。请检查设备是否连接、是否被其他程序占用。";
      case "NotReadableError":
        return "摄像头被其他程序占用（Zoom / Teams / OBS / 浏览器其他标签页等）。关闭它后刷新重试，或在上方下拉选择其他摄像头。";
      case "OverconstrainedError":
        return "选中的摄像头不支持请求的分辨率/参数。切回「默认」试试。";
      case "SecurityError":
        return "页面不是安全上下文。请用 https:// 或 http://localhost 打开。";
      case "AbortError":
        return "摄像头初始化被打断，请刷新页面重试。";
      default:
        return `${err.name} — ${err.message}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export type CameraState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; stream: MediaStream }
  | { kind: "error"; message: string };

export function useCamera(
  videoRef: React.RefObject<HTMLVideoElement>,
  deviceId?: string,
  active = true,
) {
  const [state, setState] = useState<CameraState>({ kind: "idle" });

  useEffect(() => {
    // Deferred until the demo view is open. When inactive, hold no stream and
    // report idle; the cleanup of a previous active run already stopped tracks.
    if (!active) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    let activeStream: MediaStream | null = null;

    async function start() {
      setState({ kind: "loading" });
      try {
        const stream = await acquireCamera(deviceId);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        activeStream = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }
        // Re-check after the await: cleanup may have run while play() was
        // pending and already stopped the tracks. Don't publish a "ready"
        // state for a dead stream.
        if (cancelled) return;
        setState({ kind: "ready", stream });
      } catch (err) {
        if (cancelled) return;
        console.error("[useCamera] getUserMedia failed:", err);
        setState({ kind: "error", message: explainCameraError(err) });
      }
    }

    start();

    return () => {
      cancelled = true;
      activeStream?.getTracks().forEach((t) => t.stop());
    };
  }, [videoRef, deviceId, active]);

  return state;
}
