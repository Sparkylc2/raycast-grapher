import { Action, ActionPanel, Color, Icon, List, Toast, getPreferenceValues, showToast } from "@raycast/api";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type Camera2D,
  type Camera3D,
  type DocumentLine,
  type EntryAnalysis,
  type Plot2D,
  type Range,
  type Scene,
  type SliderInfo,
  DEFAULT_ORBIT,
  KANAGAWA_DRAGON,
  analyzeDocument,
  dollyBy,
  emptyScene,
  formatCoordinate,
  formatSliderValue,
  nextColor,
  orbitBy,
  panBy,
  profileAt,
  setSliderValue,
  stepSlider,
  zoomAbout,
} from "@grapher/core";
import { parseFrameRate } from "./motion.js";
import { loadScene, saveScene } from "./store.js";
import { PLOT_DISPLAY, describeStats, usePlot } from "./use-plot.js";

/** One step is a fifth of the viewport, which reads as a deliberate nudge. */
const PAN_FRACTION = 0.2;
const ZOOM_FACTOR = 1.35;
/** Fifteen degrees per press. */
const ORBIT_STEP = Math.PI / 12;
const DRAFT_ID = "draft";
const PLAYBACK_MS = 4000;
const SLIDER_TRACK = 10;

/**
 * Equations down the left, the plot on the right, and the search bar as the
 * input. Every line is analysed together, so functions, sliders and
 * differential equations defined on one line are available to all the others.
 */
export default function Command(props: { arguments?: { expression?: string } }) {
  const [scene, setScene] = useState<Scene>(emptyScene());
  const [camera, setCamera] = useState<Camera2D>(scene.camera2d);
  const [orbit, setOrbit] = useState<Camera3D>(DEFAULT_ORBIT);
  const [draft, setDraft] = useState(props.arguments?.expression ?? "");
  const [loading, setLoading] = useState(true);
  // Bumped when the view should jump rather than glide, as when the saved view loads.
  const [viewEpoch, setViewEpoch] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeSlider, setActiveSlider] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const playheadRef = useRef<number | null>(null);
  playheadRef.current = playhead;
  const frameRate = parseFrameRate(getPreferenceValues<{ frameRate?: string }>().frameRate);

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
  const draftColor = nextColor(scene.expressions.length);

  const lines = useMemo<DocumentLine[]>(
    () => [
      ...scene.expressions.map((e) => ({ id: e.id, source: e.source, color: e.color, visible: e.visible })),
      ...(trimmed ? [{ id: DRAFT_ID, source: trimmed, color: draftColor, visible: true }] : []),
    ],
    [scene.expressions, trimmed, draftColor],
  );
  const linesKey = JSON.stringify(lines);
  const analysis = useMemo(() => analyzeDocument(lines), [linesKey]);
  const byId = new Map(analysis.entries.map((e) => [e.id, e] as const));
  const draftEntry = trimmed ? (byId.get(DRAFT_ID) ?? null) : null;
  const selectedEntry = selectedId ? byId.get(selectedId) : undefined;

  // The line being typed wins; otherwise the selected line, if it draws anything.
  const focus = [draftEntry, selectedEntry].find(plottable) ?? null;
  const lastDimension = useRef<2 | 3>(2);
  if (focus) lastDimension.current = focus.dimension;
  const dimension = focus?.dimension ?? lastDimension.current;

  // Playback belongs to whichever line has a time axis.
  const timeRange = focus?.timeRange ?? null;
  const timeName = focus?.ode?.independent ?? focus?.pde?.time ?? null;
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
  const visibleEntries = analysis.entries.filter((e) => e.visible && !e.error && e.dimension === dimension);
  const plots: Plot2D[] =
    dimension === 2
      ? visibleEntries.flatMap((e) => (e === profileEntry ? [profilePlot(e, playhead!)] : e.plots))
      : [];
  const surfaces = dimension === 3 ? visibleEntries.flatMap((e) => e.surfaces) : [];
  const axisNames = profileEntry
    ? [profileEntry.pde!.space, profileEntry.pde!.dependent]
    : (focus?.axes ?? (dimension === 3 ? ["x", "y", "z"] : ["x", "y"]));

  const plot = usePlot({
    contentKey: profileEntry ? `${linesKey}|profile|${playhead}` : linesKey,
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

  // Sliders: the selected slider line, else the ones the focused line reads, else all.
  const sliders = analysis.sliders;
  const selectedSlider = sliders.find((s) => s.id === selectedId);
  const relevant = selectedSlider ? [selectedSlider] : focus ? sliders.filter((s) => focus.uses.includes(s.name)) : [];
  const pool = relevant.length ? relevant : sliders;
  const currentSlider = pool.find((s) => s.name === activeSlider) ?? pool[0] ?? null;

  const commit = (next: Scene): void => setScene(next);

  const add = (): void => {
    if (!draftEntry) return;
    if (draftEntry.error) {
      void showToast({ style: Toast.Style.Failure, title: "Can't plot that yet", message: draftEntry.error });
      return;
    }
    const stamp = Date.now();
    const added = [
      { id: `${stamp}`, source: trimmed, color: draftColor, visible: true },
      // Names nothing defines become sliders, so they can be dragged straight away.
      ...draftEntry.missing.map((name, i) => ({
        id: `${stamp}-${i}`,
        source: `${name} = 1`,
        color: KANAGAWA_DRAGON.axis,
        visible: true,
      })),
    ];
    commit({ ...scene, expressions: [...scene.expressions, ...added] });
    setDraft("");
    if (draftEntry.missing.length) {
      void showToast({ style: Toast.Style.Success, title: `Added slider${draftEntry.missing.length > 1 ? "s" : ""}`, message: draftEntry.missing.join(", ") });
    }
  };

  const nudgeSlider = (direction: 1 | -1) => (): void => {
    if (!currentSlider) {
      void showToast({ style: Toast.Style.Failure, title: "No sliders yet", message: "Define one like a = 2 [0, 10]" });
      return;
    }
    const value = stepSlider(currentSlider, direction);
    setActiveSlider(currentSlider.name);
    if (currentSlider.id === DRAFT_ID) {
      setDraft(setSliderValue(trimmed, currentSlider, value));
      return;
    }
    commit({
      ...scene,
      expressions: scene.expressions.map((e) =>
        e.id === currentSlider.id ? { ...e, source: setSliderValue(e.source, currentSlider, value) } : e,
      ),
    });
  };

  const cycleSlider = (direction: 1 | -1) => (): void => {
    if (pool.length === 0 || !currentSlider) return;
    const index = pool.indexOf(currentSlider);
    const next = pool[(index + direction + pool.length) % pool.length]!;
    setActiveSlider(next.name);
  };

  const stepIntersection = (direction: 1 | -1) => (): void => {
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
    setPlaying(false);
    setPlayhead(null);
    if (focus?.pde?.display === "heatmap" && focus.fit) setCamera(fitCamera(focus.fit.h, focus.fit.v, camera));
  };

  const aspect = PLOT_DISPLAY.width / PLOT_DISPLAY.height;
  // Arrows move the plot the way the key points. In 2D that pans the camera the
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

  const plotActions = (
    <>
      <ActionPanel.Section title="Plot">
        <Action title="Next Intersection" icon={Icon.ArrowRightCircle} shortcut={{ modifiers: ["cmd"], key: "u" }} onAction={stepIntersection(1)} />
        <Action title="Previous Intersection" icon={Icon.ArrowLeftCircle} shortcut={{ modifiers: ["cmd"], key: "l" }} onAction={stepIntersection(-1)} />
        <Action title="Increase Slider" icon={Icon.Plus} shortcut={{ modifiers: ["cmd"], key: "]" }} onAction={nudgeSlider(1)} />
        <Action title="Decrease Slider" icon={Icon.Minus} shortcut={{ modifiers: ["cmd"], key: "[" }} onAction={nudgeSlider(-1)} />
        <Action title="Next Slider" icon={Icon.ChevronRight} shortcut={{ modifiers: ["cmd", "shift"], key: "]" }} onAction={cycleSlider(1)} />
        <Action title="Previous Slider" icon={Icon.ChevronLeft} shortcut={{ modifiers: ["cmd", "shift"], key: "[" }} onAction={cycleSlider(-1)} />
        <Action title={playing ? "Pause" : "Play Over Time"} icon={playing ? Icon.Pause : Icon.Play} shortcut={{ modifiers: ["cmd"], key: "p" }} onAction={togglePlay} />
        <Action title="Show Whole Solution" icon={Icon.Stop} shortcut={{ modifiers: ["cmd", "shift"], key: "p" }} onAction={showWhole} />
      </ActionPanel.Section>
      <ActionPanel.Section title="View">
        <Action title={dimension === 3 ? "Rotate Left" : "Move Plot Left"} icon={Icon.ArrowLeft} shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }} onAction={move(1, 0)} />
        <Action title={dimension === 3 ? "Rotate Right" : "Move Plot Right"} icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd"], key: "arrowRight" }} onAction={move(-1, 0)} />
        <Action title={dimension === 3 ? "Tilt Up" : "Move Plot Up"} icon={Icon.ArrowUp} shortcut={{ modifiers: ["cmd"], key: "arrowUp" }} onAction={move(0, -1)} />
        <Action title={dimension === 3 ? "Tilt Down" : "Move Plot Down"} icon={Icon.ArrowDown} shortcut={{ modifiers: ["cmd"], key: "arrowDown" }} onAction={move(0, 1)} />
        <Action title="Zoom In" icon={Icon.MagnifyingGlass} shortcut={{ modifiers: ["cmd"], key: "=" }} onAction={zoom(1 / ZOOM_FACTOR)} />
        <Action title="Zoom Out" icon={Icon.MagnifyingGlass} shortcut={{ modifiers: ["cmd"], key: "-" }} onAction={zoom(ZOOM_FACTOR)} />
        <Action title="Zoom to Fit" icon={Icon.Maximize} shortcut={{ modifiers: ["cmd", "shift"], key: "0" }} onAction={zoomToFit} />
        <Action title="Reset View" icon={Icon.ArrowCounterClockwise} shortcut={{ modifiers: ["cmd"], key: "0" }} onAction={resetView} />
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
      </ActionPanel.Section>
    </>
  );

  // Text under the plot: what the line resolved to, and live readouts.
  const infoEntry = draftEntry ?? selectedEntry ?? null;
  const info: string[] = [];
  if (infoEntry?.error) info.push(`\`${infoEntry.error}\``);
  else {
    if (infoEntry?.resolved) info.push(`\`${infoEntry.resolved}\``);
    if (infoEntry?.note) info.push(infoEntry.note);
  }
  if (currentSlider && (relevant.length > 0 || selectedSlider)) {
    info.push(`${currentSlider.name} = ${formatSliderValue(currentSlider.value, currentSlider.step)}`);
  }
  if (playhead !== null && timeName) info.push(`${timeName} = ${formatCoordinate(playhead)}`);
  const chosen = shownHighlight !== null ? points[shownHighlight] : undefined;
  if (chosen) info.push(`intersection ${shownHighlight! + 1} of ${points.length}: (${formatCoordinate(chosen.x)}, ${formatCoordinate(chosen.y)})`);
  const markdown = [plot.markdownImage ?? "", info.join("  ·  ")].filter(Boolean).join("\n\n");

  const detail = <List.Item.Detail markdown={markdown} />;
  // Frames are inline images, so every item carrying the pane would resend the
  // image once per line per frame. While moving, only the item on screen carries
  // it; once still, all of them do, so moving the selection never lands on an
  // empty pane.
  const detailOwner = trimmed ? DRAFT_ID : (selectedId ?? scene.expressions[0]?.id ?? null);
  const animating = plot.moving || playing;
  const detailFor = (id: string) => (!animating || id === detailOwner ? { detail } : {});

  return (
    <List
      isLoading={loading}
      isShowingDetail
      // The search bar is the equation input, not a filter over saved equations.
      filtering={false}
      searchText={draft}
      onSearchTextChange={setDraft}
      onSelectionChange={(id) => setSelectedId(id)}
      searchBarPlaceholder="y = sin(x),  f(x) = x^2,  y' = y [y(0) = 1]"
      // Keep Enter meaning "add" for as long as something is being typed.
      {...(trimmed ? { selectedItemId: DRAFT_ID } : {})}
    >
      {trimmed && draftEntry ? (
        <List.Item
          id={DRAFT_ID}
          title={trimmed}
          icon={iconFor(draftEntry, draftColor)}
          accessories={accessoriesFor(draftEntry, sliders, currentSlider)}
          {...detailFor(DRAFT_ID)}
          actions={
            <ActionPanel>
              <Action title="Add Equation" icon={Icon.Plus} onAction={add} />
              {plotActions}
            </ActionPanel>
          }
        />
      ) : null}

      {scene.expressions.map((entry) => {
        const analysed = byId.get(entry.id);
        return (
          <List.Item
            key={entry.id}
            id={entry.id}
            title={entry.source}
            icon={analysed ? iconFor(analysed, entry.color) : Icon.Circle}
            accessories={analysed ? accessoriesFor(analysed, sliders, currentSlider) : []}
            {...detailFor(entry.id)}
            actions={
              <ActionPanel>
                <Action
                  title="Edit"
                  icon={Icon.Pencil}
                  onAction={() => {
                    // Lifting the line back into the search bar makes editing the
                    // same gesture as writing, and the plot tracks it live.
                    setDraft(entry.source);
                    commit({ ...scene, expressions: scene.expressions.filter((e) => e.id !== entry.id) });
                  }}
                />
                {plotActions}
                <ActionPanel.Section title="Line">
                  <Action
                    title={entry.visible ? "Hide" : "Show"}
                    icon={entry.visible ? Icon.EyeDisabled : Icon.Eye}
                    shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
                    onAction={() =>
                      commit({
                        ...scene,
                        expressions: scene.expressions.map((e) => (e.id === entry.id ? { ...e, visible: !e.visible } : e)),
                      })
                    }
                  />
                  <Action
                    title="Remove"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => commit({ ...scene, expressions: scene.expressions.filter((e) => e.id !== entry.id) })}
                  />
                  <Action
                    title="Remove All"
                    icon={Icon.XMarkCircle}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                    onAction={() => commit({ ...scene, expressions: [] })}
                  />
                </ActionPanel.Section>
              </ActionPanel>
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
  if (entry.kind === "constant") return { source: Icon.Hashtag, tintColor: Color.SecondaryText };
  if (entry.kind === "function" && entry.plots.length === 0) return { source: Icon.Code, tintColor: color };
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
