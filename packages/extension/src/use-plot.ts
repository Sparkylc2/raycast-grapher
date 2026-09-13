import { environment, getPreferenceValues } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import {
  type Camera2D,
  type Classified,
  type RenderLayer,
  type Typeface,
  KANAGAWA_DRAGON,
  KANAGAWA_LOTUS,
  classify,
  parse,
  renderScene,
} from "@grapher/core";
import { encodePng } from "@grapher/core/png";
import { loadSystemTypeface } from "@grapher/core/system-font";
import { ease, frameDelay, imageMarkdown, parseFrameRate } from "./motion.js";

export interface PlotEntry {
  readonly source: string;
  readonly color: string;
}

/** Size the image is shown at in the detail pane, in display pixels. */
export const PLOT_DISPLAY = { width: 460, height: 345 } as const;

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

export interface PlotState {
  readonly markdownImage: string | null;
  /** Parse errors, aligned with the entries passed in; null where the entry is fine. */
  readonly errors: readonly (string | null)[];
  readonly stats: FrameStats | null;
  /** True while the view is still easing toward its target. */
  readonly moving: boolean;
}

/**
 * Renders entries at an animated camera that eases toward `target`, never
 * faster than the frame-rate preference allows.
 *
 * Changing `epoch` snaps the view to the target without animating, for jumps
 * that should not glide, such as restoring the saved view on launch.
 */
export function usePlot(entries: readonly PlotEntry[], target: Camera2D, epoch: number): PlotState {
  const [state, setState] = useState<PlotState>({ markdownImage: null, errors: [], stats: null, moving: false });
  const [fontReady, setFontReady] = useState(false);
  const shown = useRef<Camera2D>(target);
  const shownEpoch = useRef(epoch);
  const typeface = useRef<Typeface | null>(null);
  const lastFrameAt = useRef(0);
  const frameRate = parseFrameRate(getPreferenceValues<{ frameRate?: string }>().frameRate);

  // Loading SF is quick now, but it still waits for the first frame to go out.
  useEffect(() => {
    const timer = setTimeout(() => {
      typeface.current = loadSystemTypeface();
      if (typeface.current) setFontReady(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const key = JSON.stringify({ entries, target, epoch, fontReady, frameRate, appearance: environment.appearance });

  useEffect(() => {
    if (shownEpoch.current !== epoch) {
      shownEpoch.current = epoch;
      shown.current = target;
    }

    const { layers, errors } = buildLayers(entries);
    const theme = environment.appearance === "light" ? KANAGAWA_LOTUS : KANAGAWA_DRAGON;
    const face = typeface.current;

    let cancelled = false;
    let timer: NodeJS.Timeout | undefined;
    // Treat the first step as one frame period, so the first draft moves at all.
    let last = performance.now() - 1000 / frameRate;
    const motion = { started: performance.now(), frames: 0, renders: [] as number[] };

    const draw = (camera: Camera2D, ratio: 1 | 2): string => {
      const started = performance.now();
      const width = PLOT_DISPLAY.width * ratio;
      const height = PLOT_DISPLAY.height * ratio;
      const rgba = renderScene(layers, camera, { width, height }, theme, {
        transparent: true,
        pixelRatio: ratio,
        ...(face ? { typeface: face } : {}),
      });
      // Drafts live for a few dozen milliseconds, so they take the fast compression level.
      const png = encodePng(rgba, width, height, { level: ratio === 1 ? 1 : 6 });
      if (ratio === 1) motion.renders.push(performance.now() - started);
      lastFrameAt.current = performance.now();
      return imageMarkdown(png, PLOT_DISPLAY.width, PLOT_DISPLAY.height);
    };

    const tick = (): void => {
      if (cancelled) return;
      const now = performance.now();
      const step = ease(shown.current, target, now - last);
      last = now;
      shown.current = step.camera;

      const image = draw(step.camera, 1);
      motion.frames++;
      setState({ markdownImage: image, errors, stats: null, moving: !step.settled });

      if (step.settled) {
        const stats = summarise(motion, performance.now(), frameRate);
        timer = setTimeout(() => {
          if (cancelled) return;
          // Shows up in `ray develop` output.
          if (motion.frames > 1) console.log(`[grapher] ${describeStats(stats)}`);
          setState({ markdownImage: draw(target, 2), errors, stats, moving: false });
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

/**
 * Parsed graphs are cached by source. Keeping the same graph objects between
 * frames lets the renderer reuse compiled functions V8 has already optimised.
 */
const classified = new Map<string, Classified | Error>();

function classifyCached(source: string): Classified | Error {
  let result = classified.get(source);
  if (!result) {
    try {
      result = classify(parse(source));
    } catch (error) {
      result = error as Error;
    }
    // Typing produces a new source per keystroke; cap the cache rather than track usage.
    if (classified.size > 500) classified.clear();
    classified.set(source, result);
  }
  return result;
}

function buildLayers(entries: readonly PlotEntry[]): { layers: RenderLayer[]; errors: (string | null)[] } {
  const layers: RenderLayer[] = [];
  const errors = entries.map((entry) => {
    const result = classifyCached(entry.source);
    if (result instanceof Error) return result.message;
    if (result.dimension === 3) return "3D graphs need the viewer window";
    layers.push({ graph: result.graph, color: entry.color });
    return null;
  });
  return { layers, errors };
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

function summarise(motion: { started: number; frames: number; renders: number[] }, now: number, cap: number): FrameStats {
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
