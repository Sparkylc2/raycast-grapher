/**
 * What the analyzer hands to the renderers.
 *
 * Every plot carries ready-to-call closures bound to the current slider
 * values, so renderers never see expressions, parameters or document rules.
 * Coordinates are named by position: h is the horizontal axis and v the
 * vertical one, whatever the user called them.
 */

export interface Range {
  readonly lo: number;
  readonly hi: number;
}

export type Plot2D =
  /** v = f(h), optionally restricted to a domain and a vertical window. */
  | {
      readonly kind: "explicit";
      readonly color: string;
      readonly f: (h: number) => number;
      readonly domain: Range | null;
      readonly clip: Range | null;
    }
  /** F(h, v) = 0 as a curve, or F(h, v) < 0 as a shaded region. */
  | {
      readonly kind: "field";
      readonly color: string;
      readonly F: (h: number, v: number) => number;
      readonly region: { readonly strict: boolean } | null;
      readonly clipH: Range | null;
      readonly clipV: Range | null;
    }
  | {
      readonly kind: "parametric";
      readonly color: string;
      readonly x: (t: number) => number;
      readonly y: (t: number) => number;
      readonly range: Range;
    }
  | { readonly kind: "point"; readonly color: string; readonly x: number; readonly y: number }
  /** Direction field of a first-order equation: every real slope at (h, v), into `out`. */
  | {
      readonly kind: "slopes";
      readonly color: string;
      readonly slopes: (h: number, v: number, out: number[]) => void;
      readonly clipH: Range | null;
      readonly clipV: Range | null;
    }
  /**
   * A solution curve, sampled in ascending time along h. `t0` marks where its
   * initial condition sits; playback reveals the curve from the left.
   */
  | {
      readonly kind: "trajectory";
      readonly color: string;
      readonly h: Float64Array;
      readonly v: Float64Array;
      readonly t0: number;
      readonly v0: number;
    }
  /** Values on a regular grid, rows running along v. */
  | {
      readonly kind: "heatmap";
      readonly color: string;
      readonly values: Float32Array;
      readonly cols: number;
      readonly rows: number;
      readonly h: Range;
      readonly v: Range;
      readonly min: number;
      readonly max: number;
    };

export type Surface3D =
  | {
      readonly kind: "explicitSurface";
      readonly color: string;
      readonly f: (x: number, y: number) => number;
      readonly x: Range;
      readonly y: Range;
      readonly zClip: Range | null;
    }
  | {
      readonly kind: "implicitSurface";
      readonly color: string;
      readonly F: (x: number, y: number, z: number) => number;
      readonly box: readonly [Range, Range, Range];
      /** Shrink the view box to the surface found, when no ranges were given. */
      readonly fit: boolean;
    }
  | {
      readonly kind: "parametricSurface";
      readonly color: string;
      readonly x: (u: number, v: number) => number;
      readonly y: (u: number, v: number) => number;
      readonly z: (u: number, v: number) => number;
      readonly u: Range;
      readonly v: Range;
    }
  | {
      readonly kind: "curve3d";
      readonly color: string;
      readonly x: (t: number) => number;
      readonly y: (t: number) => number;
      readonly z: (t: number) => number;
      readonly range: Range;
    }
  | { readonly kind: "point3d"; readonly color: string; readonly x: number; readonly y: number; readonly z: number }
  /** Heights on a regular grid over x and y, as a PDE solution u(x, t) provides. */
  | {
      readonly kind: "gridSurface";
      readonly color: string;
      readonly values: Float32Array;
      readonly cols: number;
      readonly rows: number;
      readonly x: Range;
      readonly y: Range;
      readonly min: number;
      readonly max: number;
    };
