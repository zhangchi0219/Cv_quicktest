import { useCallback, useEffect, useState } from "react";

export function useVideoDevices(enabled = false): {
  devices: MediaDeviceInfo[];
  refresh: () => void;
} {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const cams = list.filter((d) => d.kind === "videoinput");
      console.log("[useVideoDevices] found", cams.length, "video inputs:", cams);
      setDevices(cams);
    } catch (err) {
      console.error("[useVideoDevices] enumerateDevices failed:", err);
    }
  }, []);

  useEffect(() => {
    // Deferred until the demo opens (enabled) so first load enumerates nothing.
    // mediaDevices is undefined in non-secure contexts (http:// on a LAN IP)
    // and some embedded WebViews. Don't crash the React tree.
    if (!enabled || !navigator.mediaDevices) return;
    refresh();
    const onChange = () => refresh();
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
    };
  }, [refresh, enabled]);

  return { devices, refresh };
}
