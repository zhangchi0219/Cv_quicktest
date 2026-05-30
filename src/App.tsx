import {
  Component as ReactComponent,
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { useCamera } from "./camera/useCamera";
import { useVideoDevices } from "./camera/useVideoDevices";
import { createDetectors, type Detectors } from "./cv/mediapipe";
import { useHandTracking } from "./cv/useHandTracking";
import { FusionExplainer } from "./ui/FusionExplainer";

// The fusion scene is the full-screen hero. Lazy so the three.js chunk only
// downloads after the rest of the UI has painted; if it never loads, the
// camera + tracking still run (the scene is what consumes them).
const ParticleStage = lazy(() => import("./particles/ParticleStage"));

// Catches errors from React.lazy() chunk loads (404 after a deploy, offline,
// CSP block) so a failed dynamic import doesn't unmount the whole tree.
class SceneErrorBoundary extends ReactComponent<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[SceneErrorBoundary]", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="model-loader">
          <p className="model-loader-title error">聚变场景加载失败</p>
          <p className="model-loader-phase">{this.state.error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement>(null);
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const cam = useCamera(videoRef, deviceId);
  const { devices, refresh: refreshDevices } = useVideoDevices();

  const [detectors, setDetectors] = useState<Detectors | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("准备中");
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    let created: Detectors | null = null;
    createDetectors((p, ph) => {
      setProgress(p);
      setPhase(ph);
    }, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) {
          // Aborted after construction completed — close to free WASM memory.
          d.hand.close();
          return;
        }
        created = d;
        setDetectors(d);
      })
      .catch((err) => {
        if (ctrl.signal.aborted) return;
        setModelError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      ctrl.abort();
      // Closes the WASM + WebGL resources held by MediaPipe. Without this,
      // every StrictMode remount / HMR cycle leaks WASM heap + a WebGL context.
      if (created) {
        created.hand.close();
      }
    };
  }, []);

  useEffect(() => {
    if (cam.kind === "ready" || cam.kind === "error") refreshDevices();
  }, [cam.kind, refreshDevices]);

  // If the selected camera disappears (unplugged / virtual cam shut down),
  // clear deviceId so the next acquireCamera falls back to the default instead
  // of looping on OverconstrainedError forever.
  useEffect(() => {
    if (!deviceId || devices.length === 0) return;
    if (!devices.some((d) => d.deviceId === deviceId)) {
      setDeviceId(undefined);
    }
  }, [devices, deviceId]);

  // The single hand-tracking loop: feeds landmarkBus (which drives the fusion
  // scene) and paints a minimal skeleton onto the PiP overlay for feedback.
  useHandTracking(videoRef, detectors, cam.kind === "ready", pipCanvasRef);

  return (
    <>
      <Suspense fallback={<div className="particle-stage" aria-hidden="true" />}>
        <SceneErrorBoundary>
          <ParticleStage />
        </SceneErrorBoundary>
      </Suspense>

      <header className="page-header">
        <h1>核聚变 · 氘氚聚变</h1>
        <p className="subtitle">
          双手即两个原子核 · MediaPipe + three.js + React
        </p>
      </header>

      <div className="pip-camera">
        <div className="pip-stage">
          <video ref={videoRef} playsInline muted />
          <canvas ref={pipCanvasRef} className="pip-overlay" />
          {!detectors && !modelError && (
            <div className="model-loader">
              <p className="model-loader-title">正在加载 MediaPipe 模型</p>
              <div className="progress-bar">
                <div
                  className="progress-bar-fill"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className="progress-text">{Math.round(progress * 100)}%</p>
              <p className="model-loader-phase">{phase}</p>
            </div>
          )}
          {modelError && (
            <div className="model-loader">
              <p className="model-loader-title error">模型加载失败</p>
              <p className="model-loader-phase">{modelError}</p>
            </div>
          )}
        </div>

        <div className="pip-controls">
          <label>
            摄像头 ({devices.length})
            <select
              value={deviceId ?? ""}
              onChange={(e) => setDeviceId(e.target.value || undefined)}
            >
              <option value="">默认</option>
              {devices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `摄像头 ${i + 1}`}
                </option>
              ))}
            </select>
          </label>
          <span className="pip-status">
            {cam.kind === "loading" && "请求权限…"}
            {cam.kind === "error" && (
              <span className="error">{cam.message}</span>
            )}
            {cam.kind === "ready" &&
              detectors &&
              `运行中 · ${detectors.source === "cdn" ? "CDN" : "本地"}`}
          </span>
        </div>
      </div>

      <button
        type="button"
        className="explainer-toggle"
        onClick={() => setDrawerOpen((v) => !v)}
        aria-expanded={drawerOpen}
        aria-controls="explainer-drawer"
      >
        {drawerOpen ? "闭合" : "讲解"}
      </button>

      <aside
        id="explainer-drawer"
        className="explainer-drawer"
        data-open={drawerOpen}
        aria-hidden={!drawerOpen}
      >
        <h2>氘氚聚变</h2>
        <p className="lesson-description">
          两手分别控制氘核与氚核，靠拢克服库仑势垒即可触发聚变。
        </p>
        <FusionExplainer />
      </aside>
    </>
  );
}
