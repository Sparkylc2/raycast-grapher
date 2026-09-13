import { Action, ActionPanel, Color, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import {
  type Camera2D,
  type Scene,
  emptyScene,
  nextColor,
  panBy,
  zoomAbout,
} from "@grapher/core";
import { loadScene, saveScene } from "./store.js";
import { PLOT_DISPLAY, type PlotEntry, describeStats, usePlot } from "./use-plot.js";

/** One step is a fifth of the viewport, which reads as a deliberate nudge. */
const PAN_FRACTION = 0.2;
const ZOOM_FACTOR = 1.35;
const DRAFT_ID = "draft";

/**
 * Equations down the left, the plot on the right, and the search bar as the
 * input. The plot redraws as you type, so there is no step between writing an
 * equation and looking at it.
 */
export default function Command(props: { arguments?: { expression?: string } }) {
  const [scene, setScene] = useState<Scene>(emptyScene());
  const [camera, setCamera] = useState<Camera2D>(scene.camera2d);
  const [draft, setDraft] = useState(props.arguments?.expression ?? "");
  const [loading, setLoading] = useState(true);
  // Bumped when the view should jump rather than glide, as when the saved view loads.
  const [viewEpoch, setViewEpoch] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void loadScene().then((loaded) => {
      setScene(loaded);
      setCamera(loaded.camera2d);
      setViewEpoch((e) => e + 1);
      setLoading(false);
    });
  }, []);

  // The camera changes on every nudge; write it back lazily.
  const saveTimer = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (loading) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveScene({ ...scene, camera2d: camera }), 400);
  }, [camera]);

  const commit = (next: Scene): void => {
    setScene(next);
    void saveScene({ ...next, camera2d: camera });
  };

  const trimmed = draft.trim();
  const draftColor = nextColor(scene.expressions.length);

  const visible = scene.expressions.filter((e) => e.visible);
  const entries: PlotEntry[] = visible.map((e) => ({ source: e.source, color: e.color }));
  if (trimmed) entries.push({ source: trimmed, color: draftColor });

  const { markdownImage, errors, stats, moving } = usePlot(entries, camera, viewEpoch);
  const draftError = trimmed ? errors[errors.length - 1] ?? null : null;
  const errorFor = (source: string): string | null => {
    const index = visible.findIndex((e) => e.source === source);
    return index === -1 ? null : errors[index] ?? null;
  };

  const detail = <List.Item.Detail markdown={detailMarkdown(markdownImage, draftError)} />;
  // Frames are inline images, so every item carrying the pane would resend the
  // image once per equation per frame. While moving, only the item on screen
  // carries it; once still, all of them do, so moving the selection never lands
  // on an empty pane.
  const detailOwner = trimmed ? DRAFT_ID : (selectedId ?? scene.expressions[0]?.id ?? null);
  const detailFor = (id: string) => (!moving || id === detailOwner ? { detail } : {});

  const add = (): void => {
    if (!trimmed) return;
    if (draftError) {
      void showToast({ style: Toast.Style.Failure, title: "Can't plot that yet", message: draftError });
      return;
    }
    commit({
      ...scene,
      expressions: [
        ...scene.expressions,
        { id: `${Date.now()}`, source: trimmed, color: draftColor, visible: true },
      ],
    });
    setDraft("");
  };

  const aspect = PLOT_DISPLAY.width / PLOT_DISPLAY.height;
  // Arrows move the plot the way the key points, like dragging it, so the
  // camera travels the opposite way.
  const nudge = (dx: number, dy: number) => () =>
    setCamera((c) => panBy(c, dx * c.spanY * aspect * PAN_FRACTION, dy * c.spanY * PAN_FRACTION));
  const zoom = (factor: number) => () => setCamera((c) => zoomAbout(c, factor, c.cx, c.cy));

  const viewActions = (
    <ActionPanel.Section title="View">
      <Action title="Move Plot Left" icon={Icon.ArrowLeft} shortcut={{ modifiers: ["cmd"], key: "arrowLeft" }} onAction={nudge(1, 0)} />
      <Action title="Move Plot Right" icon={Icon.ArrowRight} shortcut={{ modifiers: ["cmd"], key: "arrowRight" }} onAction={nudge(-1, 0)} />
      <Action title="Move Plot Up" icon={Icon.ArrowUp} shortcut={{ modifiers: ["cmd"], key: "arrowUp" }} onAction={nudge(0, -1)} />
      <Action title="Move Plot Down" icon={Icon.ArrowDown} shortcut={{ modifiers: ["cmd"], key: "arrowDown" }} onAction={nudge(0, 1)} />
      <Action title="Zoom In" icon={Icon.Plus} shortcut={{ modifiers: ["cmd"], key: "=" }} onAction={zoom(1 / ZOOM_FACTOR)} />
      <Action title="Zoom Out" icon={Icon.Minus} shortcut={{ modifiers: ["cmd"], key: "-" }} onAction={zoom(ZOOM_FACTOR)} />
      <Action title="Reset View" icon={Icon.ArrowCounterClockwise} shortcut={{ modifiers: ["cmd"], key: "0" }} onAction={() => setCamera(emptyScene().camera2d)} />
      <Action
        title="Show Frame Rate"
        icon={Icon.Gauge}
        shortcut={{ modifiers: ["cmd", "shift"], key: "f" }}
        onAction={() =>
          void showToast({
            style: Toast.Style.Success,
            title: stats ? "Last movement" : "Pan or zoom first",
            ...(stats ? { message: describeStats(stats) } : {}),
          })
        }
      />
    </ActionPanel.Section>
  );

  return (
    <List
      isLoading={loading}
      isShowingDetail
      // The search bar is the equation input, not a filter over saved equations.
      filtering={false}
      searchText={draft}
      onSearchTextChange={setDraft}
      onSelectionChange={(id) => setSelectedId(id)}
      searchBarPlaceholder="Type an equation, e.g. y = sin(x)"
      // Keep Enter meaning "add" for as long as something is being typed.
      {...(trimmed ? { selectedItemId: DRAFT_ID } : {})}
    >
      {trimmed ? (
        <List.Item
          id={DRAFT_ID}
          title={trimmed}
          icon={
            draftError
              ? { source: Icon.Warning, tintColor: Color.Red }
              : { source: Icon.CircleFilled, tintColor: draftColor }
          }
          {...detailFor(DRAFT_ID)}
          actions={
            <ActionPanel>
              <Action title="Add Equation" icon={Icon.Plus} onAction={add} />
              {viewActions}
            </ActionPanel>
          }
        />
      ) : null}

      {scene.expressions.map((entry) => {
        const error = entry.visible ? errorFor(entry.source) : null;
        return (
          <List.Item
            key={entry.id}
            id={entry.id}
            title={entry.source}
            icon={
              error
                ? { source: Icon.Warning, tintColor: Color.Red }
                : entry.visible
                  ? { source: Icon.CircleFilled, tintColor: entry.color }
                  : { source: Icon.Circle, tintColor: Color.SecondaryText }
            }
            {...detailFor(entry.id)}
            actions={
              <ActionPanel>
                <Action
                  title="Edit"
                  icon={Icon.Pencil}
                  onAction={() => {
                    // Lifting the equation back into the search bar makes editing the
                    // same gesture as writing, and the plot tracks it live.
                    setDraft(entry.source);
                    commit({ ...scene, expressions: scene.expressions.filter((e) => e.id !== entry.id) });
                  }}
                />
                <Action
                  title={entry.visible ? "Hide" : "Show"}
                  icon={entry.visible ? Icon.EyeDisabled : Icon.Eye}
                  shortcut={{ modifiers: ["cmd", "shift"], key: "h" }}
                  onAction={() =>
                    commit({
                      ...scene,
                      expressions: scene.expressions.map((e) =>
                        e.id === entry.id ? { ...e, visible: !e.visible } : e,
                      ),
                    })
                  }
                />
                <Action
                  title="Remove"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() =>
                    commit({ ...scene, expressions: scene.expressions.filter((e) => e.id !== entry.id) })
                  }
                />
                <Action
                  title="Remove All"
                  icon={Icon.XMarkCircle}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl", "shift"], key: "x" }}
                  onAction={() => commit({ ...scene, expressions: [] })}
                />
                {viewActions}
              </ActionPanel>
            }
          />
        );
      })}

      <List.EmptyView
        icon={Icon.LineChart}
        title="Type an equation"
        description="y = sin(x),  x^2 + y^2 = 9,  y < x^2 - 2"
      />
    </List>
  );
}

function detailMarkdown(image: string | null, draftError: string | null): string {
  if (!image) return "";
  return draftError ? `${image}\n\n\`${draftError}\`` : image;
}
