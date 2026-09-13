import type { Camera2D } from "@grapher/core";

/**
 * Animation rules with no Raycast imports, so they can be tested directly.
 */

/**
 * Time constant of the view easing toward its target. Each frame closes the gap
 * by a share set by elapsed time, not frame count, so motion keeps the same pace
 * at any frame rate. Long enough that even a 30 fps cap puts several frames
 * into a single nudge.
 */
export const EASE_MS = 80;

export const FRAME_RATES = [15, 30, 45, 60] as const;
export const DEFAULT_FRAME_RATE = 30;

/** Reads the frame-rate preference, falling back to the default for anything unexpected. */
export function parseFrameRate(value: string | undefined): number {
  const rate = Number(value);
  return (FRAME_RATES as readonly number[]).includes(rate) ? rate : DEFAULT_FRAME_RATE;
}

/** Eases the view toward the target by an amount set by elapsed time. */
export function ease(from: Camera2D, to: Camera2D, elapsedMs: number): { camera: Camera2D; settled: boolean } {
  const k = 1 - Math.exp(-Math.max(0, elapsedMs) / EASE_MS);
  // Zoom interpolates in log space, so zooming in and out feel equally quick.
  const logSpan = Math.log(from.spanY) + (Math.log(to.spanY) - Math.log(from.spanY)) * k;
  const camera: Camera2D = {
    cx: from.cx + (to.cx - from.cx) * k,
    cy: from.cy + (to.cy - from.cy) * k,
    spanY: Math.exp(logSpan),
  };
  // Within 0.2% of the view is under a pixel at the pane's size.
  const tolerance = to.spanY * 0.002;
  const settled =
    Math.abs(camera.cx - to.cx) < tolerance &&
    Math.abs(camera.cy - to.cy) < tolerance &&
    Math.abs(Math.log(camera.spanY / to.spanY)) < 0.002;
  return { camera: settled ? to : camera, settled };
}

/**
 * Milliseconds to wait before the next frame. Measured from the last frame
 * actually drawn, so the cap still holds when key repeat retargets the view
 * faster than frames are allowed.
 */
export function frameDelay(now: number, lastFrameAt: number, fps: number): number {
  return Math.max(0, lastFrameAt + 1000 / fps - now);
}

/**
 * Markdown for a PNG frame, inlined as a data URI.
 *
 * Raycast treats any other local image as a themable asset: on every change it
 * hides the image, looks for a `@dark` variant, falls back to the real file and
 * fades that in once loaded. For a still that is invisible; during animation it
 * blanked every frame. Data URIs go straight to a plain image element.
 */
export function imageMarkdown(png: Uint8Array, width: number, height: number): string {
  const base64 = Buffer.from(png.buffer, png.byteOffset, png.byteLength).toString("base64");
  // Raycast strips these size hints from the query before loading the image.
  return `![Plot](data:image/png;base64,${base64}?raycast-width=${width}&raycast-height=${height})`;
}
