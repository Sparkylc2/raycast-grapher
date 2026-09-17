import { DEFAULT_CAMERA_2D, DEFAULT_CAMERA_3D, type Camera2D, type Camera3D } from "./camera.js";
import { DEFAULT_THEME, seriesColor } from "./theme.js";

/**
 * The document both surfaces read and write.
 *
 * Raycast owns the expression list; the viewer owns the cameras. Keeping them
 * in one serialisable object means "open in viewer" and "show me a still" are
 * the same state seen two ways.
 */
export interface Scene {
  readonly version: 1;
  readonly mode: "2d" | "3d";
  readonly expressions: readonly ExpressionEntry[];
  readonly camera2d: Camera2D;
  readonly camera3d: Camera3D;
  /** Values for any non-coordinate variables, addressed by name. */
  readonly parameters: Readonly<Record<string, number>>;
}

export interface ExpressionEntry {
  readonly id: string;
  readonly source: string;
  /** The automatic colour, given when the line was added. */
  readonly color: string;
  readonly visible: boolean;
  /** A colour chosen by hand, as a position in the series; absent means automatic. */
  readonly colorIndex?: number;
}

/** Kept as a named export for convenience; the theme owns the actual values. */
export const SERIES_COLORS: readonly string[] = DEFAULT_THEME.series;

export function emptyScene(): Scene {
  return {
    version: 1,
    mode: "2d",
    expressions: [],
    camera2d: DEFAULT_CAMERA_2D,
    camera3d: DEFAULT_CAMERA_3D,
    parameters: {},
  };
}

export function nextColor(count: number): string {
  return seriesColor(DEFAULT_THEME, count);
}

/** The colour a line draws in: the one chosen by hand, or its automatic one. */
export function lineColor(entry: ExpressionEntry): string {
  const chosen = entry.colorIndex;
  return chosen !== undefined && SERIES_COLORS[chosen] ? SERIES_COLORS[chosen]! : entry.color;
}

/** Tolerant reader: an older or hand-edited file degrades to defaults, never throws. */
export function parseScene(raw: string): Scene {
  const base = emptyScene();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof data !== "object" || data === null) return base;
  const d = data as Partial<Scene>;

  return {
    version: 1,
    mode: d.mode === "3d" ? "3d" : "2d",
    expressions: Array.isArray(d.expressions)
      ? d.expressions.filter(isExpressionEntry).map(withValidColor)
      : base.expressions,
    camera2d: { ...base.camera2d, ...(d.camera2d ?? {}) },
    camera3d: { ...base.camera3d, ...(d.camera3d ?? {}) },
    parameters: typeof d.parameters === "object" && d.parameters !== null ? d.parameters : {},
  };
}

function isExpressionEntry(value: unknown): value is ExpressionEntry {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Partial<ExpressionEntry>;
  return typeof e.id === "string" && typeof e.source === "string";
}

function withValidColor(entry: ExpressionEntry): ExpressionEntry {
  const chosen = entry.colorIndex;
  if (chosen === undefined || (Number.isInteger(chosen) && chosen >= 0 && chosen < SERIES_COLORS.length)) return entry;
  const { colorIndex: _dropped, ...rest } = entry;
  return rest;
}
