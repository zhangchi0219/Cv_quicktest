import {
  Component as ReactComponent,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { useCamera } from "./camera/useCamera";
import { useVideoDevices } from "./camera/useVideoDevices";
import { createDetectors, type Detectors } from "./cv/mediapipe";
import { lessons } from "./lessons";

// Catches errors from React.lazy() chunk loads (404 after a deploy, offline,
// CSP block). Without this, a failed dynamic import unmounts the whole tree.
class LessonErrorBoundary extends ReactComponent<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[LessonErrorBoundary]", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="model-loader">
          <p className="model-loader-title error">课程模块加载失败</p>
          <p className="model-loader-phase">{this.state.error.message}</p>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [deviceId, setDeviceId] = useState<string | undefined>();
  const cam = useCamera(videoRef, deviceId);
  const { devices, refresh: refreshDevices } = useVideoDevices();

  const [detectors, setDetectors] = useState<Detectors | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [lessonId, setLessonId] = useState(lessons[0].id);
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("准备中");

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
  // clear deviceId so the next acquireCamera falls back to the default
  // instead of looping on OverconstrainedError forever.
  useEffect(() => {
    if (!deviceId || devices.length === 0) return;
    if (!devices.some((d) => d.deviceId === deviceId)) {
      setDeviceId(undefined);
    }
  }, [devices, deviceId]);

  const active = lessons.find((l) => l.id === lessonId) ?? lessons[0];
  const ActiveLesson = active.Component;
  const ActiveExplainer = active.Explainer;

  return (
    <>
      <header className="page-header">
        <h1>CV Quicktest</h1>
        <p className="subtitle">
          Computer Vision 教学 Demo · MediaPipe + three.js + React
        </p>
      </header>

      <nav className="lesson-nav">
        {lessons.map((l) => (
          <button
            key={l.id}
            type="button"
            className={"lesson-tab" + (l.id === lessonId ? " active" : "")}
            onClick={() => setLessonId(l.id)}
          >
            {l.title}
          </button>
        ))}
      </nav>

      <div className="layout">
        <section className="layout-left">
          <div className="controls">
            <label>
              摄像头 ({devices.length})
              <select
                value={deviceId ?? ""}
                onChange={(e) => setDeviceId(e.target.value || undefined)}
              >
                <option value="">默认</option>
                {devices.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `摄像头 ${i + 1}（未授权时无名称）`}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={refreshDevices}>
              刷新列表
            </button>
          </div>

          <div className="stage">
            <video ref={videoRef} playsInline muted />
            {detectors && (
              <LessonErrorBoundary key={lessonId}>
                <Suspense fallback={null}>
                  <ActiveLesson
                    videoRef={videoRef}
                    detectors={detectors}
                    cameraReady={cam.kind === "ready"}
                  />
                </Suspense>
              </LessonErrorBoundary>
            )}
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

          <p className="status">
            {cam.kind === "loading" && "正在请求摄像头权限…"}
            {cam.kind === "error" && (
              <span className="error">摄像头错误: {cam.message}</span>
            )}
            {cam.kind === "ready" && detectors && (
              <>运行中 · 模型来自 {detectors.source === "cdn" ? "CDN" : "本地"}</>
            )}
          </p>
        </section>

        <aside className="layout-right">
          <h2>{active.title}</h2>
          <p className="lesson-description">{active.description}</p>
          <LessonErrorBoundary key={lessonId}>
            <Suspense fallback={<p className="lesson-description">正在加载…</p>}>
              <ActiveExplainer />
            </Suspense>
          </LessonErrorBoundary>

          <section className="app-list">
            <h2>测距 / 深度的真实应用</h2>

            <details className="app-item">
              <summary className="app-item-summary">
                <span className="app-item-title">扫地机器人</span>
                <span className="app-tech">LiDAR · ToF · vSLAM</span>
              </summary>
              <p className="app-desc">
                旋转激光头扫一圈得到 360° 距离图，知道墙、家具在哪；视觉 SLAM
                通过特征点匹配 + 三角化估算自己移动了多少、把走过的地方拼成地图。
              </p>
            </details>

            <details className="app-item">
              <summary className="app-item-summary">
                <span className="app-item-title">汽车自动驾驶</span>
                <span className="app-tech">
                  立体视差 · 单目深度估计 · LiDAR + 毫米波雷达融合
                </span>
              </summary>
              <p className="app-desc">
                <strong>立体视差</strong>从左右双摄像头差异反推深度（跟人眼一样）；
                <strong>单目深度估计</strong>用 MiDaS / DPT
                这类大模型从单张图回归出深度图；多传感器在 Kalman filter
                或神经网络里融合，最后决定跟车、变道、紧急刹车。
              </p>
            </details>

            <details className="app-item">
              <summary className="app-item-summary">
                <span className="app-item-title">路口监控 / 行人识别</span>
                <span className="app-tech">单目 + 针孔成像模型</span>
              </summary>
              <p className="app-desc">
                固定摄像头一次标定（焦距、安装高度、俯仰角）后，用
                <strong>针孔模型</strong>反算：在图像里检测到人脸宽 X
                像素，已知真实约 14 cm
                加上焦距，就能得出距离。闯红灯抓拍、车牌识别、行人计数都靠这一套。
              </p>
            </details>
          </section>
        </aside>
      </div>
    </>
  );
}
