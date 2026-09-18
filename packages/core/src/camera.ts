/**
 * Cameras live in core, not in the viewer, because two surfaces have to agree
 * on them: the interactive window drives them with the mouse, and Raycast
 * renders a still from whatever they were left at.
 */

export interface Camera2D {
  readonly cx: number;
  readonly cy: number;
  /** World-space height of the viewport; width follows from the aspect ratio. */
  readonly spanY: number;
}

export interface Camera3D {
  readonly target: readonly [number, number, number];
  readonly distance: number;
  /** Radians. Yaw sweeps around the up axis, pitch is clamped off the poles. */
  readonly yaw: number;
  readonly pitch: number;
  readonly fovY: number;
}

export const DEFAULT_CAMERA_2D: Camera2D = { cx: 0, cy: 0, spanY: 10 };

export const DEFAULT_CAMERA_3D: Camera3D = {
  target: [0, 0, 0],
  distance: 14,
  yaw: Math.PI * 0.25,
  pitch: Math.PI * 0.18,
  fovY: Math.PI / 4,
};

const PITCH_LIMIT = Math.PI / 2 - 1e-3;
const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));

export function panBy(
  camera: Camera2D,
  dxWorld: number,
  dyWorld: number,
): Camera2D {
  return { ...camera, cx: camera.cx - dxWorld, cy: camera.cy - dyWorld };
}

/**
 * Zooms about a world-space anchor so the point under the cursor stays put,
 * which is what makes wheel zoom feel attached to the graph.
 */
export function zoomAbout(
  camera: Camera2D,
  factor: number,
  anchorX: number,
  anchorY: number,
): Camera2D {
  const spanY = clamp(camera.spanY * factor, 1e-9, 1e9);
  const k = spanY / camera.spanY;
  return {
    spanY,
    cx: anchorX + (camera.cx - anchorX) * k,
    cy: anchorY + (camera.cy - anchorY) * k,
  };
}

/** Viewport bounds for a given pixel aspect ratio. */
export function bounds2D(
  camera: Camera2D,
  aspect: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const halfY = camera.spanY / 2;
  const halfX = halfY * aspect;
  return {
    minX: camera.cx - halfX,
    maxX: camera.cx + halfX,
    minY: camera.cy - halfY,
    maxY: camera.cy + halfY,
  };
}

export function orbitBy(
  camera: Camera3D,
  dYaw: number,
  dPitch: number,
): Camera3D {
  return {
    ...camera,
    yaw: camera.yaw + dYaw,
    pitch: clamp(camera.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT),
  };
}

export function dollyBy(camera: Camera3D, factor: number): Camera3D {
  return { ...camera, distance: clamp(camera.distance * factor, 1e-3, 1e6) };
}

/** Eye position implied by the orbit parameters. */
export function eyeOf(camera: Camera3D): [number, number, number] {
  const { target, distance, yaw, pitch } = camera;
  const cp = Math.cos(pitch);
  return [
    target[0] + distance * cp * Math.cos(yaw),
    target[1] + distance * Math.sin(pitch),
    target[2] + distance * cp * Math.sin(yaw),
  ];
}
