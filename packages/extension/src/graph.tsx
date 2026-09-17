import { Action, ActionPanel, Color, Icon, List, Toast, getPreferenceValues, showToast } from "@raycast/api";
import { useCachedState } from "@raycast/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Camera2D,
  type Camera3D,
  type DocumentLine,
  type EntryAnalysis,
  type Hint,
  type Plot2D,
  type Range,
  type Scene,
  type SliderInfo,
  DEFAULT_ORBIT,
  KANAGAWA_DRAGON,
  SERIES_COLORS,
  analyzeDocument,
  dollyBy,
  emptyScene,
  fieldPlots,
  fieldSurfaces,
  formatCoordinate,
  describeTransform,
  formatHintParts,
  formatSliderValue,
  hintFor,
  lineColor,
  nextColor,
  orbitBy,
  orbitSurfaces,
  panBy,
  pickPlot,
  profileAt,
  setSliderValue,
  stepSlider,
  transformPlots,
  transformSurfaces,
  zoomAbout,
} from "@grapher/core";
import { parseFrameRate } from "./motion.js";
import { DEFAULT_PLOT_RECT, type PlotRect, plotFraction, useMouse } from "./mouse.js";
import { loadScene, saveScene } from "./store.js";
import { PLOT_DISPLAY, describeStats, usePlot } from "./use-plot.js";

/** One step is a fifth of the viewport, which reads as a deliberate nudge. */
const PAN_FRACTION = 0.2;
const ZOOM_FACTOR = 1.35;
/** Fifteen degrees per press. */
const ORBIT_STEP = Math.PI / 12;
const DRAFT_ID = "draft";
const HINT_ID = "hint";
/** Names for the series colours, in order, as Cmd+1 to Cmd+7 choose them. */
const COLOR_NAMES = ["Blue", "Red", "Green", "Yellow", "Pink", "Orange", "Aqua"];
const PLAYBACK_MS = 4000;
/** Time for one matrix to finish moving the plane. */
const STEP_SECONDS = 1.2;
const SLIDER_TRACK = 10;

/**
 * Keys under the plot. Movement is Cmd+Shift with N E I O, left, down, up and
 * right. Not arrows: Raycast's list takes the vertical ones, with any modifier,
 * before an action shortcut sees them. Not Option: Option+N, E and I are dead
 * keys, and Raycast ignores any keypress that is composing a character.
 */
const HELP = [
  "`↵` add or save  ·  `⇥` complete  ·  `⌘⌫` delete line  ·  `⌘⇧H` hide line  ·  `⌘/` hide this help",
  "`⌘⇧N` `⌘⇧E` `⌘⇧I` `⌘⇧O` move, or rotate in 3D  ·  `⌥=` `⌥-` zoom  ·  `⌥F` fit  ·  `⌥0` reset",
  "`⌘]` `⌘[` step slider  ·  `⌘⇧]` `⌘⇧[` switch slider  ·  `⌘U` `⌘L` intersections or matrix steps  ·  `⌘⇧Space` play",
  "`⌘1` to `⌘7` colour  ·  `⌘0` automatic colour",
].join("  \n");

/**
 * Equations down the left, the plot on the right, and the search bar as the
 * input. Every line is analysed together, so functions, sliders and
 * differential equations defined on one line are available to all the others.
 *
 * The search bar holds either a new line or the line being edited. An edited
 * line stays in the list the whole time, showing the text as it is typed, so
 * moving away from it can only ever save it or leave it as it was.
 */
export default function Command(props: { arguments?: { expression?: string } }) {
  const [scene, setScene] = useState<Scene>(emptyScene());
  const [camera, setCamera] = useState<Camera2D>(scene.camera2d);
  const [orbit, setOrbit] = useState<Camera3D>(DEFAULT_ORBIT);
  const [draft, setDraft] = useState(props.arguments?.expression ?? "");
  const [editingId, setEditingId] = useState<string | null>(null);
  // A colour chosen for the line being typed, applied when it is added.
  const [draftColorIndex, setDraftColorIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumped when the view should jump rather than glide, as when the saved view loads.
  const [viewEpoch, setViewEpoch] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Mouse mode: a line chosen by clicking its curve, the last clicked point, and corner calibration.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [clicked, setClicked] = useState<{ x: number; y: number } | null>(null);
  const [calibration, setCalibration] = useState<{ step: 1 } | { step: 2; left: number; top: number } | null>(null);
  const [plotRect, setPlotRect] = useCachedState<PlotRect>("mouse-plot-rect", DEFAULT_PLOT_RECT);
  const [activeSlider, setActiveSlider] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  // Transformation view: how many of a matrix product's steps are applied, and where that is heading.
  // Null means all of them, which is what a matrix line shows until you step through it.
  const [stepProgress, setStepProgress] = useState<number | null>(null);
  const [stepTarget, setStepTarget] = useState<number | null>(null);
  const [showHelp, setShowHelp] = useCachedState("show-key-help", true);
  const playheadRef = useRef<number | null>(null);
  playheadRef.current = playhead;
  const preferences = getPreferenceValues<{ frameRate?: string; strictCalls?: boolean }>();
  // The mouse helper only observes, so it needs no permission and runs whenever Grapher is open.
  const mouseMode = true;
  const frameRate = parseFrameRate(preferences.frameRate);
  const strictCalls = preferences.strictCalls ?? false;

  useEffect(() => {
    void loadScene().then((loaded) => {
      setScene(loaded);
      setCamera(loaded.camera2d);
      setOrbit(sanitizeOrbit(loaded.camera3d));
      setViewEpoch((e) => e + 1);
      setLoading(false);
    });
  }, []);

  // Slider steps and camera nudges arrive many times a second; write them back lazily.
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (loading) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveScene({ ...scene, camera2d: camera, camera3d: orbit }), 400);
  }, [scene, camera, orbit]);

  const trimmed = draft.trim();
  const drafting = trimmed !== "" && !editingId;
  const draftColor = (draftColorIndex !== null ? SERIES_COLORS[draftColorIndex] : undefined) ?? nextColor(scene.expressions.length);
  const editing = editingId ? (scene.expressions.find((e) => e.id === editingId) ?? null) : null;

  const lines = useMemo<DocumentLine[]>(
    () => [
      ...scene.expressions.flatMap((e) => {
        if (e.id !== editingId) return [{ id: e.id, source: e.source, color: lineColor(e), visible: e.visible }];
        // The edited line previews what is typed; cleared, it drops out until saved or abandoned.
        return trimmed ? [{ id: e.id, source: trimmed, color: lineColor(e), visible: true }] : [];
      }),
      ...(trimmed && !editingId ? [{ id: DRAFT_ID, source: trimmed, color: draftColor, visible: true }] : []),
    ],
    [scene.expressions, trimmed, draftColor, editingId],
  );
  const linesKey = JSON.stringify(lines);
  const analysis = useMemo(() => analyzeDocument(lines, { strictCalls }), [linesKey, strictCalls]);
  const byId = new Map(analysis.entries.map((e) => [e.id, e] as const));
  const inputId = editingId ?? DRAFT_ID;
  const inputEntry = trimmed ? (byId.get(inputId) ?? null) : null;
  const selectedEntry = selectedId ? byId.get(selectedId) : undefined;

  // The hint reads the statement before any trailing brackets as a line of the
  // document, so an unfinished range or condition doesn't hide what the line is.
  const hint = useMemo<Hint | null>(() => {
    if (!trimmed) return null;
    const others = lines.filter((l) => l.id !== inputId);
    const seen = new Map<string, EntryAnalysis | null>();
    const analyze = (statement: string): EntryAnalysis | null => {
      if (statement === trimmed) return inputEntry;
      if (!seen.has(statement)) {
        const line = { id: HINT_ID, source: statement, color: draftColor, visible: true };
        const entries = analyzeDocument([...others, line], { strictCalls }).entries;
        seen.set(statement, entries[entries.length - 1] ?? null);
      }
      return seen.get(statement) ?? null;
    };
    return hintFor(draft, { analyze, functions: analysis.functions });
  }, [draft, linesKey, strictCalls]);
  const ghost = hint && hint.parts.length > 0 ? formatHintParts(hint.parts) : undefined;
  const complete = (): void => {
    if (hint?.next != null) setDraft(hint.next);
  };

  // A line that applies numeric matrices is shown as the plane, or space, being moved.
  const transformEntry = [inputEntry, selectedEntry].find((e) => !!e && !e.error && e.transform !== null) ?? null;
  const transform = transformEntry?.transform ?? null;
  const stepCount = transform?.steps.length ?? 0;
  const progress = stepProgress ?? stepCount;
  const stepsPlaying = stepProgress !== null && stepTarget !== null && stepProgress !== stepTarget;
  useEffect(() => {
    setStepProgress(null);
    setStepTarget(null);
  }, [transformEntry?.id, transformEntry?.source]);
  useEffect(() => {
    if (!stepsPlaying || stepTarget === null) return;
    const perFrame = 1 / (STEP_SECONDS * frameRate);
    const timer = setInterval(() => {
      setStepProgress((current) => {
        if (current === null) return current;
        return current < stepTarget ? Math.min(stepTarget, current + perFrame) : Math.max(stepTarget, current - perFrame);
      });
    }, 1000 / frameRate);
    return () => clearInterval(timer);
  }, [stepsPlaying, stepTarget, frameRate]);

  // The line being typed wins; otherwise the selected line, if it draws anything.
  const focus = [inputEntry, selectedEntry].find(plottable) ?? null;
  const lastDimension = useRef<2 | 3>(2);
  if (transform) lastDimension.current = transform.dimension;
  else if (focus) lastDimension.current = focus.dimension;
  const dimension = transform?.dimension ?? focus?.dimension ?? lastDimension.current;

  // Playback belongs to whichever line has a time axis.
  const timeRange = focus?.timeRange ?? null;
  const timeName = focus?.ode?.independent ?? focus?.pde?.time ?? focus?.system?.time ?? focus?.field?.time ?? null;
  useEffect(() => {
    setPlaying(false);
    setPlayhead(null);
  }, [focus?.id]);
  useEffect(() => {
    if (!playing || !timeRange) return;
    const span = timeRange.hi - timeRange.lo;
    const startAt = playheadRef.current ?? timeRange.lo;
    const began = performance.now() - ((startAt - timeRange.lo) / span) * PLAYBACK_MS;
    const timer = setInterval(() => {
      const fraction = (performance.now() - began) / PLAYBACK_MS;
      if (fraction >= 1) {
        setPlayhead(timeRange.hi);
        setPlaying(false);
      } else {
        setPlayhead(timeRange.lo + fraction * span);
      }
    }, 1000 / frameRate);
    return () => clearInterval(timer);
  }, [playing, timeRange?.lo, timeRange?.hi, frameRate]);

  // A PDE shown as a heatmap plays back as its profile moving through time.
  const profileEntry = playhead !== null && focus?.pde?.display === "heatmap" ? focus : null;
  // A 3D system grows its orbits up to the playhead.
  const orbitEntry = playhead !== null && focus?.system && focus.dimension === 3 ? focus : null;
  // A PDE in two or three space variables plays as its frames moving through time.
  const fieldEntry = playhead !== null && focus?.field ? focus : null;
  const visibleEntries = analysis.entries.filter((e) => e.visible && !e.error && e.dimension === dimension);
  const transformColors = transformEntry
    ? { grid: KANAGAWA_DRAGON.grid, square: transformEntry.color, basis: [SERIES_COLORS[1]!, SERIES_COLORS[2]!, SERIES_COLORS[3]!], vector: transformEntry.color }
    : null;
  const plots: Plot2D[] =
    dimension !== 2
      ? []
      : transform && transformColors
        ? transformPlots(transform, progress, transformColors)
        : visibleEntries.flatMap((e) =>
            e === profileEntry ? [profilePlot(e, playhead!)] : e === fieldEntry ? fieldPlots(e.field!, playhead!, e.color) : e.plots,
          );
  const surfaces =
    dimension !== 3
      ? []
      : transform && transformColors
        ? transformSurfaces(transform, progress, transformColors)
        : visibleEntries.flatMap((e) =>
            e === orbitEntry ? orbitSurfaces(e.system!, e.color, playhead) : e === fieldEntry ? fieldSurfaces(e.field!, playhead!, e.color) : e.surfaces,
          );
  const axisNames = transform
    ? transform.dimension === 3
      ? ["x", "y", "z"]
      : ["x", "y"]
    : profileEntry
    ? [profileEntry.pde!.space, profileEntry.pde!.dependent]
    : (focus?.axes ?? (dimension === 3 ? ["x", "y", "z"] : ["x", "y"]));

  const plot = usePlot({
    contentKey: transform ? `${linesKey}|steps|${progress}` : profileEntry || orbitEntry || fieldEntry ? `${linesKey}|profile|${playhead}` : linesKey,
    findCrossings: !transform,
    dimension,
    plots,
    surfaces,
    camera,
    orbit,
    epoch: viewEpoch,
    axisNames,
    playhead: profileEntry ? null : playhead,
    highlight,
  });
  const points = plot.intersections;
  const shownHighlight = highlight !== null && highlight < points.length ? highlight : null;

  useMouse(mouseMode, (event) => {
    if (calibration && event.type === "click") {
      const fx = event.x / event.width;
      const fy = event.y / event.height;
      if (calibration.step === 1) {
        setCalibration({ step: 2, left: fx, top: fy });
        void showToast({ style: Toast.Style.Animated, title: "Now click the plot's bottom-right corner" });
        return;
      }
      setCalibration(null);
      const width = fx - calibration.left;
      const height = fy - calibration.top;
      if (width > 0.05 && height > 0.05) {
        setPlotRect({ left: calibration.left, top: calibration.top, width, height });
        void showToast({ style: Toast.Style.Success, title: "Mouse calibrated" });
      } else {
        void showToast({ style: Toast.Style.Failure, title: "Click the top-left corner first, then the bottom-right" });
      }
      return;
    }

    const at = plotFraction(event, plotRect);
    const pixels = plotRect.height * event.height;
    const aspect = PLOT_DISPLAY.width / PLOT_DISPLAY.height;
    const pointIn = (c: Camera2D) =>
      at ? { x: c.cx + (at.u - 0.5) * c.spanY * aspect, y: c.cy + (0.5 - at.v) * c.spanY } : { x: c.cx, y: c.cy };
    // Dragging carries the plot with the pointer; in 3D it turns the view.
    const drag = (dx: number, dy: number): void => {
      if (dimension === 3) setOrbit((o) => orbitBy(o, dx * 0.012, -dy * 0.012));
      else setCamera((c) => panBy(c, (dx * c.spanY) / pixels, (-dy * c.spanY) / pixels));
    };
    const zoomBy = (factor: number): void => {
      if (dimension === 3) setOrbit((o) => dollyBy(o, factor));
      else
        setCamera((c) => {
          const p = pointIn(c);
          return zoomAbout(c, factor, p.x, p.y);
        });
    };

    switch (event.type) {
      case "drag":
        if (at || event.x / event.width > plotRect.left) drag(event.dx, event.dy);
        return;
      case "scroll":
        if (!at) return;
        // Two fingers on a trackpad pan; holding cmd or option zooms, as does a mouse wheel.
        // In 3D, scrolling turns the view the opposite way to dragging, which reads as natural.
        if (event.precise && !event.zooming) {
          const flip = dimension === 3 ? -1 : 1;
          drag(flip * event.dx, flip * event.dy);
        }
        else zoomBy(Math.exp(-event.dy * (event.precise ? 0.01 : 0.08)));
        return;
      case "pinch":
        if (at) zoomBy(1 / (1 + event.amount));
        return;
      case "click": {
        if (!at || dimension === 3) return;
        const p = pointIn(camera);
        const perUnit = PLOT_DISPLAY.height / camera.spanY;
        const crossing = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) * perUnit < 10);
        if (crossing >= 0) {
          setHighlight(crossing);
          setClicked(null);
          return;
        }
        const id = transform ? null : pickPlot(visibleEntries.map((e) => ({ id: e.id, plots: e.plots })), p.x, p.y, 8 / perUnit);
        if (id && id !== DRAFT_ID) {
          setPickedId(id);
          setSelectedId(id);
        }
        setClicked(p);
      }
    }
  });

  // Sliders: the selected slider line, else the ones the focused line reads, else all.
  const sliders = analysis.sliders;
  const selectedSlider = sliders.find((s) => s.id === selectedId);
  const relevant = selectedSlider ? [selectedSlider] : focus ? sliders.filter((s) => focus.uses.includes(s.name)) : [];
  const pool = relevant.length ? relevant : sliders;
  const currentSlider = pool.find((s) => s.name === activeSlider) ?? pool[0] ?? null;

  /** Slider lines for every name the line reads that nothing defines yet. */
  const sliderLinesFor = (entry: EntryAnalysis, stamp: number) =>
    entry.missing.map((name, i) => ({
      id: `${stamp}-${i}`,
      source: `${name} = 1`,
      color: KANAGAWA_DRAGON.axis,
      visible: true,
    }));

  const announceSliders = (entry: EntryAnalysis): void => {
    if (entry.missing.length === 0) return;
    void showToast({
      style: Toast.Style.Success,
      title: `Added slider${entry.missing.length > 1 ? "s" : ""}`,
      message: entry.missing.join(", "),
    });
  };

  /**
   * Leaves edit mode. A valid edit is kept when `keep` is set; anything else,
   * including a cleared or broken line, leaves the saved line as it was.
   */
  const finishEdit = (keep: boolean): Scene => {
    if (!editingId) return scene;
    const entry = byId.get(editingId);
    let next = scene;
    if (keep && trimmed && entry && !entry.error) {
      next = {
        ...scene,
        expressions: [
          ...scene.expressions.map((e) => (e.id === editingId ? { ...e, source: trimmed } : e)),
          ...sliderLinesFor(entry, Date.now()),
        ],
      };
      announceSliders(entry);
    }
    setScene(next);
    setEditingId(null);
    setDraft("");
    return next;
  };

  const startEdit = (id: string): void => {
    const next = finishEdit(true);
    const entry = next.expressions.find((e) => e.id === id);
    if (!entry) return;
    setEditingId(id);
    setDraft(entry.source);
  };

  const add = (): void => {
    if (!inputEntry) return;
    if (inputEntry.error) {
      void showToast({ style: Toast.Style.Failure, title: "Can't plot that yet", message: inputEntry.error });
      return;
    }
    const stamp = Date.now();
    setScene({
      ...scene,
      expressions: [
        ...scene.expressions,
        {
          id: `${stamp}`,
          source: trimmed,
          color: nextColor(scene.expressions.length),
          visible: true,
          ...(draftColorIndex !== null ? { colorIndex: draftColorIndex } : {}),
        },
        // Names nothing defines become sliders, so they can be stepped straight away.
        ...sliderLinesFor(inputEntry, stamp),
      ],
    });
    setDraft("");
    setDraftColorIndex(null);
    announceSliders(inputEntry);
  };

  const save = (): void => {
    if (inputEntry?.error) {
      void showToast({ style: Toast.Style.Failure, title: "Can't save that yet", message: inputEntry.error });
      return;
    }
    finishEdit(true);
  };

  const removeLine = (id: string): void => {
    const entry = scene.expressions.find((e) => e.id === id);
    setScene({ ...scene, expressions: scene.expressions.filter((e) => e.id !== id) });
    if (entry) void showToast({ style: Toast.Style.Success, title: "Deleted", message: entry.source });
  };

  const nudgeSlider = (direction: 1 | -1) => (): void => {
    if (!currentSlider) {
      void showToast({ style: Toast.Style.Failure, title: "No sliders yet", message: "Define one like a = 2 [0, 10]" });
      return;
    }
    const value = stepSlider(currentSlider, direction);
    setActiveSlider(currentSlider.name);
    if (currentSlider.id === inputId) {
      setDraft(setSliderValue(trimmed, currentSlider, value));
      return;
    }
    setScene({
      ...scene,
      expressions: scene.expressions.map((e) =>
        e.id === currentSlider.id ? { ...e, source: setSliderValue(e.source, currentSlider, value) } : e,
      ),
    });
  };

  /** Sets the colour of the line being typed, edited or selected; null goes back to automatic. */
  const chooseColor = (index: number | null) => (): void => {
    if (drafting) {
      setDraftColorIndex(index);
      return;
    }
    const id = editingId ?? selectedId;
    if (!id) return;
    setScene({
      ...scene,
      expressions: scene.expressions.map((e) => {
        if (e.id !== id) return e;
        const { colorIndex: _previous, ...rest } = e;
        return index === null ? rest : { ...rest, colorIndex: index };
      }),
    });
  };

  const cycleSlider = (direction: 1 | -1) => (): void => {
    if (pool.length === 0 || !currentSlider) return;
    const index = pool.indexOf(currentSlider);
    setActiveSlider(pool[(index + direction + pool.length) % pool.length]!.name);
  };

  /** Plays every step from the start, or pauses a play in progress. */
  const playSteps = (): void => {
    if (stepsPlaying) {
      setStepTarget(stepProgress);
      return;
    }
    setStepProgress(progress >= stepCount ? 0 : progress);
    setStepTarget(stepCount);
  };
  /** Moves to the next or previous whole step. */
  const stepThrough = (direction: 1 | -1): void => {
    const at = stepTarget ?? progress;
    const next = direction > 0 ? Math.min(stepCount, Math.floor(at + 1e-9) + 1) : Math.max(0, Math.ceil(at - 1e-9) - 1);
    setStepProgress(progress);
    setStepTarget(next);
  };

  const stepIntersection = (direction: 1 | -1) => (): void => {
    if (transform) {
      stepThrough(direction);
      return;
    }
    if (dimension === 3 || points.length === 0) {
      void showToast({ style: Toast.Style.Failure, title: "No intersections in view" });
      return;
    }
    setHighlight((i) => {
      const from = i !== null && i < points.length ? i : direction > 0 ? -1 : 0;
      return (from + direction + points.length) % points.length;
    });
  };

  const togglePlay = (): void => {
    if (transform) {
      playSteps();
      return;
    }
    if (!timeRange || !focus) {
      void showToast({ style: Toast.Style.Failure, title: "Nothing to play", message: "Differential equations with starting values can be played" });
      return;
    }
    if (playing) {
      setPlaying(false);
      return;
    }
    if (playhead === null || playhead >= timeRange.hi) setPlayhead(timeRange.lo);
    const solution = focus.pde?.display === "heatmap" ? focus.pde.solution : null;
    if (solution) setCamera(fitCamera(solution.space, { lo: solution.min, hi: solution.max }, camera));
    setPlaying(true);
  };

  const showWhole = (): void => {
    if (transform) {
      setStepProgress(null);
      setStepTarget(null);
      return;
    }
    setPlaying(false);
    setPlayhead(null);
    if (focus?.pde?.display === "heatmap" && focus.fit) setCamera(fitCamera(focus.fit.h, focus.fit.v, camera));
  };

  const aspect = PLOT_DISPLAY.width / PLOT_DISPLAY.height;
  // Keys move the plot the way they point. In 2D that pans the camera the
  // opposite way; in 3D raising yaw carries the front of the plot to the left.
  const move = (dx: number, dy: number) => (): void => {
    if (dimension === 3) {
      setOrbit((o) => orbitBy(o, dx * ORBIT_STEP, dy * ORBIT_STEP));
    } else {
      setCamera((c) => panBy(c, dx * c.spanY * aspect * PAN_FRACTION, dy * c.spanY * PAN_FRACTION));
    }
  };
  const zoom = (factor: number) => (): void => {
    if (dimension === 3) setOrbit((o) => dollyBy(o, factor));
    else setCamera((c) => zoomAbout(c, factor, c.cx, c.cy));
  };
  const resetView = (): void => {
    if (dimension === 3) setOrbit(DEFAULT_ORBIT);
    else setCamera(emptyScene().camera2d);
  };
  const zoomToFit = (): void => {
    if (dimension === 3) {
      setOrbit(DEFAULT_ORBIT);
    } else if (focus?.fit) {
      setCamera(fitCamera(focus.fit.h, focus.fit.v, camera));
    } else {
      void showToast({ style: Toast.Style.Failure, title: "Nothing to fit", message: "Give the line a range, like [-2, 2]" });
    }
  };

  const threeD = dimension === 3;
  const plotActions = (
    <>
      <ActionPanel.Section title="View">
        <Action title={threeD ? "Rotate Left" : "Move Plot Left"} icon={Icon.ArrowLeft} shortcut={{ modifiers: ["cmd", "shift"], key: "n" }} onAction={move(1, 0)} />
        <Action title={threeD ? "Tilt Down" : "Move Plot Down"} icon={Icon.ArrowDown} shortcut={{ modifiers: ["cmd", "shift"], key: "e" }} onAction={move(0, 1)} />
        <Action title={threeD ? "Tilt Up" : "Move Plot Up"} icon={Icon.ArrowUp} shortcut={{ modifiers: ["cmd", "shift"], key: "i" }} onAction={move(0, -1)} />
        <Action title={threeD ? "Rotate Right" : "Move Plot Right"} icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd", "shift"], key: "o" }} onAction={move(-1, 0)} />
        <Action title="Zoom In" icon={Icon.MagnifyingGlass} shortcut={{ modifiers: ["opt"], key: "=" }} onAction={zoom(1 / ZOOM_FACTOR)} />
        <Action title="Zoom Out" icon={Icon.MagnifyingGlass} shortcut={{ modifiers: ["opt"], key: "-" }} onAction={zoom(ZOOM_FACTOR)} />
        <Action title="Zoom to Fit" icon={Icon.Maximize} shortcut={{ modifiers: ["opt"], key: "f" }} onAction={zoomToFit} />
        <Action title="Reset View" icon={Icon.ArrowCounterClockwise} shortcut={{ modifiers: ["opt"], key: "0" }} onAction={resetView} />
      </ActionPanel.Section>
      <ActionPanel.Section title="Plot">
        <Action title="Increase Slider" icon={Icon.Plus} shortcut={{ modifiers: ["cmd"], key: "]" }} onAction={nudgeSlider(1)} />
        <Action title="Decrease Slider" icon={Icon.Minus} shortcut={{ modifiers: ["cmd"], key: "[" }} onAction={nudgeSlider(-1)} />
        <Action title="Next Slider" icon={Icon.ChevronRight} shortcut={{ modifiers: ["cmd", "shift"], key: "]" }} onAction={cycleSlider(1)} />
        <Action title="Previous Slider" icon={Icon.ChevronLeft} shortcut={{ modifiers: ["cmd", "shift"], key: "[" }} onAction={cycleSlider(-1)} />
        <Action title={transform ? "Next Step" : "Next Intersection"} icon={Icon.ArrowRightCircle} shortcut={{ modifiers: ["cmd"], key: "u" }} onAction={stepIntersection(1)} />
        <Action title={transform ? "Previous Step" : "Previous Intersection"} icon={Icon.ArrowLeftCircle} shortcut={{ modifiers: ["cmd"], key: "l" }} onAction={stepIntersection(-1)} />
        <Action
          title={transform ? (stepsPlaying ? "Pause Steps" : "Play Steps") : playing ? "Pause" : "Play Over Time"}
          icon={playing || stepsPlaying ? Icon.Pause : Icon.Play}
          shortcut={{ modifiers: ["cmd", "shift"], key: "space" }}
          onAction={togglePlay}
        />
        <Action title={transform ? "Show Final Result" : "Show Whole Solution"} icon={Icon.Stop} shortcut={{ modifiers: ["cmd", "shift"], key: "p" }} onAction={showWhole} />
        <Action title={showHelp ? "Hide Key Help" : "Show Key Help"} icon={Icon.QuestionMarkCircle} shortcut={{ modifiers: ["cmd"], key: "/" }} onAction={() => setShowHelp(!showHelp)} />
        <Action
          title="Show Frame Rate"
          icon={Icon.Gauge}
          shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
          onAction={() =>
            void showToast({
              style: Toast.Style.Success,
              title: plot.stats ? "Last movement" : "Move the view first",
              ...(plot.stats ? { message: describeStats(plot.stats) } : {}),
            })
          }
        />
        {mouseMode ? (
          <Action
            title="Calibrate Mouse"
            icon={Icon.Maximize}
            shortcut={{ modifiers: ["cmd", "shift"], key: "m" }}
            onAction={() => {
              setCalibration({ step: 1 });
              void showToast({ style: Toast.Style.Animated, title: "Click the plot's top-left corner" });
            }}
          />
        ) : null}
      </ActionPanel.Section>
      <ActionPanel.Section title="Colour">
        {COLOR_NAMES.map((name, i) => (
          <Action
            key={name}
            title={name}
            icon={{ source: Icon.CircleFilled, tintColor: SERIES_COLORS[i] }}
            shortcut={{ modifiers: ["cmd"], key: String(i + 1) as "1" }}
            onAction={chooseColor(i)}
          />
        ))}
        <Action title="Automatic Colour" icon={Icon.Wand} shortcut={{ modifiers: ["cmd"], key: "0" }} onAction={chooseColor(null)} />
      </ActionPanel.Section>
    </>
  );

  const completeAction = <Action title="Complete" icon={Icon.ArrowRight} shortcut={{ modifiers: [], key: "tab" }} onAction={complete} />;

  // While a new line is being typed, every row answers Enter with Add, so a
  // selection that has drifted onto a saved line can't swallow the new one.
  const draftPanel = (
    <ActionPanel>
      <Action title="Add Equation" icon={Icon.Plus} onAction={add} />
      {completeAction}
      {plotActions}
    </ActionPanel>
  );

  // Text under the plot: what the line resolved to, live readouts, then key help.
  const infoEntry = inputEntry ?? selectedEntry ?? null;
  const info: string[] = [];
  if (hint) info.push(`${hint.next !== null ? "⇥ " : ""}\`${hint.title}\`${ghost ? `  \`${ghost.trim()}\`` : ""}`);
  if (infoEntry?.error) info.push(`\`${infoEntry.error}\``);
  else {
    if (infoEntry?.resolved) info.push(`\`${infoEntry.resolved}\``);
    if (infoEntry?.note) info.push(infoEntry.note);
  }
  if (editing) info.push(trimmed ? "Editing: ↵ saves, choosing another line keeps it" : "Cleared: ↵ or choosing another line keeps the original");
  if (currentSlider && (relevant.length > 0 || selectedSlider)) {
    info.push(`${currentSlider.name} = ${formatSliderValue(currentSlider.value, currentSlider.step)}`);
  }
  if (playhead !== null && timeName) info.push(`${timeName} = ${formatCoordinate(playhead)}`);
  if (transform) info.push(describeTransform(transform, progress));
  if (clicked && dimension === 2) info.push(`clicked (${formatCoordinate(clicked.x)}, ${formatCoordinate(clicked.y)})`);
  const chosen = shownHighlight !== null ? points[shownHighlight] : undefined;
  if (chosen) {
    info.push(`intersection ${shownHighlight! + 1} of ${points.length}: (${formatCoordinate(chosen.x)}, ${formatCoordinate(chosen.y)})`);
  }
  const readout = info.join("  ·  ");
  // In mouse mode the pane holds only the plot, so scrolling over it has nothing to scroll; the readout moves to the title.
  const markdown = mouseMode
    ? (plot.markdownImage ?? "")
    : [plot.markdownImage ?? "", readout, showHelp ? `---\n${HELP}` : ""].filter(Boolean).join("\n\n");
  const title = mouseMode ? readout.replace(/`/g, "") : hint ? `${hint.title}${ghost ? `   ${ghost.trim()}` : ""}` : "";

  const detail = <List.Item.Detail markdown={markdown} />;
  // Frames are inline images, so every item carrying the pane would resend the
  // image once per line per frame. While moving, only the item on screen carries
  // it; once still, all of them do, so moving the selection never lands on an
  // empty pane.
  const detailOwner = trimmed && !editingId ? DRAFT_ID : (editingId ?? selectedId ?? scene.expressions[0]?.id ?? null);
  const animating = plot.moving || playing;
  const detailFor = (id: string) => (!animating || id === detailOwner ? { detail } : {});

  return (
    <List
      isLoading={loading}
      isShowingDetail
      // The search bar is the equation input, not a filter over saved equations.
      filtering={false}
      // The search bar's own placeholder disappears once there's text, so the hint also stays in the title.
      {...(title ? { navigationTitle: title } : {})}
      searchText={draft}
      onSearchTextChange={setDraft}
      onSelectionChange={(id) => {
        setSelectedId(id);
        if (id !== pickedId) setPickedId(null);
        // Moving off the edited line is a decision about it: keep a valid edit, drop anything else.
        if (editingId && id && id !== editingId) finishEdit(true);
      }}
      searchBarPlaceholder={editing ? `Editing ${editing.source}` : "y = sin(x),  f(x) = x^2,  y' = y [y(0) = 1]"}
      // While a new line is typed, Enter means add. Editing leaves the selection free.
      {...(trimmed && !editingId ? { selectedItemId: DRAFT_ID } : pickedId ? { selectedItemId: pickedId } : {})}
    >
      {trimmed && !editingId && inputEntry ? (
        <List.Item
          id={DRAFT_ID}
          title={trimmed}
          {...(ghost ? { subtitle: ghost } : {})}
          icon={iconFor(inputEntry, draftColor)}
          accessories={accessoriesFor(inputEntry, sliders, currentSlider)}
          {...detailFor(DRAFT_ID)}
          actions={draftPanel}
        />
      ) : null}

      {scene.expressions.map((entry) => {
        const isEditing = entry.id === editingId;
        const analysed = byId.get(entry.id);
        return (
          <List.Item
            key={entry.id}
            id={entry.id}
            title={isEditing ? trimmed || entry.source : entry.source}
            {...(isEditing && ghost ? { subtitle: ghost } : {})}
            icon={isEditing ? { source: Icon.Pencil, tintColor: lineColor(entry) } : analysed ? iconFor(analysed, lineColor(entry)) : Icon.Circle}
            accessories={analysed ? accessoriesFor(analysed, sliders, currentSlider) : []}
            {...detailFor(entry.id)}
            actions={
              drafting ? (
                draftPanel
              ) : isEditing ? (
                <ActionPanel>
                  <Action title="Save Edit" icon={Icon.Check} onAction={save} />
                  {completeAction}
                  <Action title="Cancel Edit" icon={Icon.XMarkCircle} shortcut={{ modifiers: ["cmd"], key: "." }} onAction={() => finishEdit(false)} />
                  {plotActions}
                </ActionPanel>
              ) : (
                <ActionPanel>
                  <Action title="Edit" icon={Icon.Pencil} onAction={() => startEdit(entry.id)} />
                  <ActionPanel.Section title="Line">
                    <Action
                      title="Delete Line"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["cmd"], key: "backspace" }}
                      onAction={() => removeLine(entry.id)}
                    />
                    <Action
                      title={entry.visible ? "Hide" : "Show"}
                      icon={entry.visible ? Icon.EyeDisabled : Icon.Eye}
                      shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
                      onAction={() =>
                        setScene({
                          ...scene,
                          expressions: scene.expressions.map((e) => (e.id === entry.id ? { ...e, visible: !e.visible } : e)),
                        })
                      }
                    />
                    <Action
                      title="Delete All Lines"
                      icon={Icon.XMarkCircle}
                      style={Action.Style.Destructive}
                      shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                      onAction={() => setScene({ ...scene, expressions: [] })}
                    />
                  </ActionPanel.Section>
                  {plotActions}
                </ActionPanel>
              )
            }
          />
        );
      })}

      <List.EmptyView
        icon={Icon.LineChart}
        title="Type an equation"
        description="y = sin(x),  (cos t, sin t),  z = x y,  u_t = u_xx [u(x, 0) = sin(x)]"
      />
    </List>
  );
}

function plottable(entry: EntryAnalysis | null | undefined): entry is EntryAnalysis {
  return !!entry && !entry.error && (entry.plots.length > 0 || entry.surfaces.length > 0);
}

function iconFor(entry: EntryAnalysis, color: string) {
  if (entry.error) return { source: Icon.Warning, tintColor: Color.Red };
  if (!entry.visible) return { source: Icon.Circle, tintColor: Color.SecondaryText };
  if (entry.kind === "slider") return { source: Icon.Gauge, tintColor: Color.SecondaryText };
  if (entry.kind === "constant" && !plottable(entry)) return { source: Icon.Hashtag, tintColor: Color.SecondaryText };
  if (entry.kind === "function" && !plottable(entry)) return { source: Icon.Code, tintColor: color };
  if (entry.dimension === 3) return { source: Icon.Box, tintColor: color };
  return { source: Icon.CircleFilled, tintColor: color };
}

function accessoriesFor(entry: EntryAnalysis, sliders: readonly SliderInfo[], current: SliderInfo | null): List.Item.Accessory[] {
  const slider = sliders.find((s) => s.id === entry.id);
  if (slider) {
    const position = Math.round(((slider.value - slider.min) / (slider.max - slider.min || 1)) * SLIDER_TRACK);
    const track = `${"━".repeat(position)}●${"─".repeat(SLIDER_TRACK - position)}`;
    const active = current?.id === slider.id;
    return [{ text: { value: track, ...(active ? { color: Color.Blue } : {}) }, tooltip: entry.description }];
  }
  return [{ icon: Icon.Info, tooltip: entry.error ?? entry.note ?? entry.description }];
}

function profilePlot(entry: EntryAnalysis, time: number): Plot2D {
  const solution = entry.pde!.solution;
  const { space, cols } = solution;
  const h = Float64Array.from({ length: cols }, (_, i) => space.lo + ((space.hi - space.lo) * i) / (cols - 1));
  // No starting marker: the profile is a snapshot, not a pinned solution.
  return { kind: "trajectory", color: entry.color, h, v: profileAt(solution, time), t0: Number.NaN, v0: Number.NaN };
}

/** A camera showing the given ranges with a little margin, keeping what isn't given. */
function fitCamera(h: Range | null, v: Range | null, current: Camera2D): Camera2D {
  const aspect = PLOT_DISPLAY.width / PLOT_DISPLAY.height;
  const pad = 1.15;
  let { cx, cy, spanY } = current;
  if (h) {
    cx = (h.lo + h.hi) / 2;
    spanY = ((h.hi - h.lo) * pad) / aspect;
  }
  if (v) {
    cy = (v.lo + v.hi) / 2;
    const vSpan = Math.max((v.hi - v.lo) * pad, 1e-6);
    spanY = h ? Math.max(spanY, vSpan) : vSpan;
  }
  return { cx, cy, spanY };
}

/** Saved 3D cameras from before the plotting cube used different units; fall back when out of range. */
function sanitizeOrbit(camera: Camera3D): Camera3D {
  return camera.distance >= 2 && camera.distance <= 12 ? camera : DEFAULT_ORBIT;
}
