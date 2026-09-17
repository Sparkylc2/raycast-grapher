import { environment, getPreferenceValues } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import {
  type Camera2D,
  type Camera3D,
  type Intersection,
  type Plot2D,
  type Scene3D,
  type Surface3D,
  type Typeface,
  KANAGAWA_DRAGON,
  KANAGAWA_LOTUS,
  buildScene3D,
  findIntersections,
  renderPlots,
  renderScene3D,
} from "@grapher/core";
import { encodePng } from "@grapher/core/png";
import { loadSystemTypeface } from "@grapher/core/system-font";
import { ease, ease3D, frameDelay, imageMarkdown, parseFrameRate } from "./motion.js";

/** Size the image is shown at in the detail pane, in display pixels. */
export const PLOT_DISPLAY = { width: 460, height: 330 } as const;

/** A sharp 2x frame replaces the 1x draft once the view has been still this long. */
const REFINE_AFTER_MS = 160;

export interface FrameStats {
  /** Draft frames drawn during the last movement. */
  readonly frames: number;
  /** Frames drawn per second over that movement. */
  readonly fps: number | null;
  /** The frame-rate cap in force. */
  readonly cap: number;
  /** Median time to render and encode one draft frame. */
  readonly renderMs: number | null;
}

export interface PlotInput {
  /** Changes whenever what is plotted changes; plot closures are not comparable. */
  readonly contentKey: string;
  readonly dimension: 2 | 3;
  readonly plots: readonly Plot2D[];
  readonly surfaces: readonly Surface3D[];
  /** Where the 2D view is heading. */
  readonly camera: Camera2D;
  /** Where the 3D view is heading. */
  readonly orbit: Camera3D;
  /** Changing this jumps straight to the targets instead of easing. */
  readonly epoch: number;
  readonly axisNames: readonly string[];
  readonly playhead: number | null;
  readonly highlight: number | null;
  /** Look for crossings once the view settles; off where lines cross by design, as on a grid. */
  readonly findCrossings?: boolean;
}

export interface PlotState {
  readonly markdownImage: string | null;
  readonly stats: FrameStats | null;
  /** True while the view is still easing toward its target. */
  readonly moving: boolean;
  /** Crossings in the settled 2D view, in the order they are stepped through. */
  readonly intersections: readonly Intersection[];
}

interface Motion {
  readonly started: number;
  frames: number;
  readonly renders: number[];
}

const SCENES_KEPT = 6;

/**
 * Renders the current plots, easing the camera toward its target and never
 * faster than the frame-rate preference allows. 3D meshes are built once per
 * content and quality and reused for every orbit frame; intersections are
 * found once the view settles and reused until it moves.
 */
export function usePlot(input: PlotInput): PlotState {
  const [state, setState] = useState<PlotState>({ markdownImage: null, stats: null, moving: false, intersections: [] });
  const [fontReady, setFontReady] = useState(false);
  const shown2d = useRef<Camera2D>(input.camera);
  const shown3d = useRef<Camera3D>(input.orbit);
  const shownEpoch = useRef(input.epoch);
  const typeface = useRef<Typeface | null>(null);
  const lastFrameAt = useRef(0);
  const scenes = useRef(new Map<string, Scene3D>());
  const crossings = useRef<{ key: string; points: Intersection[] } | null>(null);
  const frameRate = parseFrameRate(getPreferenceValues<{ frameRate?: string }>().frameRate);

  // Loading SF is quick, but it still waits for the first frame to go out.
  useEffect(() => {
    const timer = setTimeout(() => {
      typeface.current = loadSystemTypeface();
      if (typeface.current) setFontReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const key = JSON.stringify({
    content: input.contentKey,
    dimension: input.dimension,
    view: input.dimension === 3 ? input.orbit : input.camera,
    epoch: input.epoch,
    playhead: input.playhead,
    highlight: input.highlight,
    crossings: input.findCrossings ?? true,
    axes: input.axisNames,
    fontReady,
    frameRate,
    appearance: environment.appearance,
  });

  useEffect(() => {
    const { dimension, plots, surfaces, contentKey, playhead, highlight, axisNames } = input;
    const findCrossings = input.findCrossings ?? true;
    const target2d = input.camera;
    const target3d = input.orbit;
    if (shownEpoch.current !== input.epoch) {
      shownEpoch.current = input.epoch;
      shown2d.current = target2d;
      shown3d.current = target3d;
    }

    const theme = environment.appearance === "light" ? KANAGAWA_LOTUS : KANAGAWA_DRAGON;
    const face = typeface.current;
    const crossingKey = `${contentKey}|${JSON.stringify(target2d)}`;
    const cachedCrossings = (): Intersection[] =>
      crossings.current?.key === crossingKey ? crossings.current.points : [];

    const sceneFor = (quality: "draft" | "fine"): Scene3D => {
      const sceneKey = `${contentKey}|${quality}`;
      let scene = scenes.current.get(sceneKey);
      if (!scene) {
        if (scenes.current.size >= SCENES_KEPT) scenes.current.clear();
        scene = buildScene3D(surfaces, quality);
        scenes.current.set(sceneKey, scene);
      }
      return scene;
    };

    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    // Treat the first step as one frame period, so the first draft moves at all.
    let last = performance.now() - 1000 / frameRate;
    const motion: Motion = { started: performance.now(), frames: 0, renders: [] };

    const draw = (ratio: 1 | 2): string => {
      const started = performance.now();
      const width = PLOT_DISPLAY.width * ratio;
      const height = PLOT_DISPLAY.height * ratio;
      const common = { transparent: true, pixelRatio: ratio, ...(face ? { typeface: face } : {}) };
      let rgba: Uint8ClampedArray;
      if (dimension === 3) {
        const names = axisNames.length === 3 ? (axisNames as [string, string, string]) : null;
        rgba = renderScene3D(sceneFor(ratio === 1 ? "draft" : "fine"), shown3d.current, { width, height }, theme, {
          ...common,
          axisNames: names,
        });
      } else {
        const points = cachedCrossings();
        rgba = renderPlots(plots, shown2d.current, { width, height }, theme, {
          ...common,
          axisNames: [axisNames[0] ?? "x", axisNames[1] ?? "y"],
          intersections: points,
          highlight: points.length > 0 ? highlight : null,
          playhead,
        });
      }
      // Drafts live for a few dozen milliseconds, so they take the fast compression level.
      const png = encodePng(rgba, width, height, { level: ratio === 1 ? 1 : 6 });
      if (ratio === 1) motion.renders.push(performance.now() - started);
      lastFrameAt.current = performance.now();
      return imageMarkdown(png, PLOT_DISPLAY.width, PLOT_DISPLAY.height);
    };

    const tick = (): void => {
      if (cancelled) return;
      const now = performance.now();
      let settled: boolean;
      if (dimension === 3) {
        const step = ease3D(shown3d.current, target3d, now - last);
        shown3d.current = step.camera;
        settled = step.settled;
      } else {
        const step = ease(shown2d.current, target2d, now - last);
        shown2d.current = step.camera;
        settled = step.settled;
      }
      last = now;

      const image = draw(1);
      motion.frames++;
      setState({ markdownImage: image, stats: null, moving: !settled, intersections: cachedCrossings() });

      if (settled) {
        const stats = summarise(motion, performance.now(), frameRate);
        timer = setTimeout(() => {
          if (cancelled) return;
          if (dimension === 2 && findCrossings && crossings.current?.key !== crossingKey) {
            crossings.current = { key: crossingKey, points: findIntersections(plots, target2d, PLOT_DISPLAY) };
          }
          // Shows up in `ray develop` output.
          if (motion.frames > 1) console.log(`[grapher] ${describeStats(stats)}`);
          setState({ markdownImage: draw(2), stats, moving: false, intersections: cachedCrossings() });
        }, REFINE_AFTER_MS);
        return;
      }
      timer = setTimeout(tick, frameDelay(performance.now(), lastFrameAt.current, frameRate));
    };

    // Retargeting restarts this effect, as key repeat does many times a second,
    // so the first frame of a restart also waits out the cap.
    timer = setTimeout(tick, frameDelay(performance.now(), lastFrameAt.current, frameRate));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key]);

  return state;
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

function summarise(motion: Motion, now: number, cap: number): FrameStats {
  const seconds = (now - motion.started) / 1000;
  return {
    frames: motion.frames,
    fps: motion.frames > 1 && seconds > 0 ? motion.frames / seconds : null,
    cap,
    renderMs: median(motion.renders),
  };
}

export function describeStats(stats: FrameStats): string {
  const fps = stats.fps === null ? "n/a" : stats.fps.toFixed(1);
  const render = stats.renderMs === null ? "n/a" : `${stats.renderMs.toFixed(1)} ms`;
  return `${stats.frames} frames at ${fps} fps (cap ${stats.cap}), render ${render} each`;
}
