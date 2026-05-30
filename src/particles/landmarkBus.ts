import type { NormalizedLandmark } from "@mediapipe/tasks-vision";

// Module-level pub/sub-ish ref. The useHandTracking hook writes the latest
// detection on every rAF tick; ParticleStage reads it on its own rAF tick.
// Avoids a React Context that would trigger re-renders 60×/s.
//
// landmarks are raw MediaPipe normalized [0,1] image coords (un-mirrored).
// ParticleStage maps them into its own container space — and applies the
// 1-x flip so the response visually matches the mirrored camera view.
//
// leftPalm / rightPalm are each hand's wrist anchor — already remapped to
// the visible-region [0,1] of the cover-cropped camera display, still un-
// mirrored. ParticleStage drives one nucleus cloud per hand: leftPalm anchors
// the deuterium (cyan) nucleus's world-space center, rightPalm anchors the
// tritium (violet) nucleus's. leftPinchCm / rightPinchCm are each hand's
// thumb-tip ↔ index-tip world distance in cm. Each one modulates its own
// nucleus's radius (pinched → contract, opened → expand).
// null when the corresponding hand is not detected — the corresponding
// nucleus smoothly returns to its idle home and default radius.
export type LandmarkFrame = {
  landmarks: NormalizedLandmark[][];
  leftPalm: { x: number; y: number } | null;
  rightPalm: { x: number; y: number } | null;
  leftPinchCm: number | null;
  rightPinchCm: number | null;
};

export const landmarkBus: { latest: LandmarkFrame | null } = {
  latest: null,
};
