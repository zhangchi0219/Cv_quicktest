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
import type { Detectors } from "./cv/mediapipe";
import { useHandTracking } from "./cv/useHandTracking";
import { FusionExplainer } from "./ui/FusionExplainer";

// The fusion scene fills the right-hand stage panel. Lazy so the three.js chunk
// only downloads after the rest of the UI has painted; if it never loads, the
// camera + tracking still run (the scene is what consumes them).
const ParticleStage = lazy(() => import("./particles/ParticleStage"));

// Catches errors from React.lazy() chunk loads (404 after a deploy, offline,
// CSP block) so a failed dynamic import doesn't unmount the whole tree. Renders
// the failure inside a dark scene block so it matches the panel it replaces.
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
        <div className="particle-stage">
          <div className="model-loader">
            <p className="model-loader-title error">聚变场景加载失败</p>
            <p className="model-loader-phase">{this.state.error.message}</p>
          </div>
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

  // Two-stage left panel. The intro (description) loads nothing; entering the
  // demo is what boots the camera + MediaPipe. `demoStarted` latches true on the
  // first entry so the model loads once and survives back/forward toggles.
  const [view, setView] = useState<"intro" | "demo">("intro");
  const [demoStarted, setDemoStarted] = useState(false);
  const cameraActive = view === "demo";
  const enterDemo = () => {
    setDemoStarted(true);
    setView("demo");
  };
  const exitDemo = () => setView("intro");

  const cam = useCamera(videoRef, deviceId, cameraActive);
  const { devices, refresh: refreshDevices } = useVideoDevices(demoStarted);

  const [detectors, setDetectors] = useState<Detectors | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("准备中");

  // Build the detectors the first time the demo opens (not on first paint), then
  // keep them — `demoStarted` only flips false→true once, so this body runs a
  // single time and the close() cleanup fires only on unmount.
  useEffect(() => {
    if (!demoStarted) return;
    const ctrl = new AbortController();
    let created: Detectors | null = null;
    // Lazy — keeps the @mediapipe/tasks-vision chunk out of the first paint; it
    // downloads only when the demo opens.
    import("./cv/mediapipe")
      .then(({ createDetectors }) =>
        createDetectors((p, ph) => {
          setProgress(p);
          setPhase(ph);
        }, ctrl.signal),
      )
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
  }, [demoStarted]);

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
    <div className="layout">
      <aside className="sidebar">
        {view === "intro" ? (
          <div className="sidebar-view" key="intro">
            <header className="brand">
              <div className="brand-text">
                <h1 className="brand-title">核聚变</h1>
                <span className="label">氘氚聚变 · D–T FUSION</span>
              </div>
            </header>

            <p className="lead">双手即两个原子核</p>

            <div className="explainer">
              <FusionExplainer />
            </div>

            <button type="button" className="cta" onClick={enterDemo}>
              进入演示 · 启动摄像头
            </button>
          </div>
        ) : (
          <div className="sidebar-view" key="demo">
            <button type="button" className="back-link" onClick={exitDemo}>
              ← 返回说明
            </button>

            <div className="camera-control">
              <span className="label">摄像头 · CAMERA</span>
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
                    <p className="progress-text">
                      {Math.round(progress * 100)}%
                    </p>
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
              <select
                className="camera-select"
                value={deviceId ?? ""}
                onChange={(e) => setDeviceId(e.target.value || undefined)}
                aria-label="摄像头选择"
              >
                <option value="">默认摄像头</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `摄像头 ${i + 1}`}
                  </option>
                ))}
              </select>
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

            <p className="demo-hint">
              张开双手，两团核云会跟随你的左右手；慢慢靠拢双核并稳住，蓄满顶部「库仑势垒」即可触发聚变。
            </p>
          </div>
        )}
      </aside>

      <main className="stage-panel">
        <Suspense
          fallback={<div className="particle-stage" aria-hidden="true" />}
        >
          <SceneErrorBoundary>
            <ParticleStage />
          </SceneErrorBoundary>
        </Suspense>
      </main>
    </div>
  );
}
