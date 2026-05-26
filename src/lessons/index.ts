import { lazy } from "react";
import type { Lesson } from "./types";

// Lessons are lazy-loaded so each lesson's deps ship in a separate chunk and
// only download when opened. Metadata (id/title/description) stays sync so
// the nav can render upfront.
export const lessons: Lesson[] = [
  {
    id: "hand-vectors",
    title: "手部向量",
    description: "测距 / 朝向 / 法向量 — HandLandmarker 之上的几何",
    Component: lazy(() =>
      import("./03-hand-vectors").then((m) => ({ default: m.Component })),
    ),
    Explainer: lazy(() =>
      import("./03-hand-vectors").then((m) => ({ default: m.Explainer })),
    ),
  },
];

export type { Lesson, LessonProps } from "./types";
