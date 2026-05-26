import type { RefObject, ComponentType } from "react";
import type { Detectors } from "../cv/mediapipe";

export type LessonProps = {
  videoRef: RefObject<HTMLVideoElement>;
  detectors: Detectors | null;
  cameraReady: boolean;
};

// ComponentType (not FC) so React.lazy(...) is assignable — the registry
// in lessons/index.ts wraps the actual components in lazy() so each lesson
// (and its heavy deps like three.js) only loads when opened.
export type Lesson = {
  id: string;
  title: string;
  description: string;
  Component: ComponentType<LessonProps>;
  Explainer: ComponentType;
};
