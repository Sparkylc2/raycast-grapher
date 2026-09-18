import { Toast, environment, showToast } from "@raycast/api";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { useEffect, useRef } from "react";

/**
 * Mouse mode: a Swift helper watches the mouse over Raycast's window and
 * reports it here, one JSON object per line. Positions are in points from the
 * window's top-left, with the window's size, since Raycast doesn't tell an
 * extension where its detail image sits.
 *
 * The helper belongs to the module rather than to one mount. Raycast keeps a
 * warm worker for a few minutes and reuses it when the command opens again,
 * which doesn't always run the command's effects a second time, so a helper
 * tied to mounting stayed dead until a preference change restarted the worker.
 * Every render checks instead, and starts one whenever there isn't one.
 */

interface Located {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type PointerEvent =
  | (Located & { readonly type: "drag"; readonly dx: number; readonly dy: number })
  | (Located & { readonly type: "click" })
  | (Located & { readonly type: "up" })
  | (Located & { readonly type: "scroll"; readonly dx: number; readonly dy: number; readonly precise: boolean; readonly zooming: boolean })
  | (Located & { readonly type: "pinch"; readonly amount: number });

/** Where the plot image sits in Raycast's window, as fractions of the window's width and height. */
export interface PlotRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A guess for Raycast's default layout, until Calibrate Mouse measures it. */
export const DEFAULT_PLOT_RECT: PlotRect = { left: 0.41, top: 0.15, width: 0.57, height: 0.67 };

const TYPES = new Set(["drag", "click", "up", "scroll", "pinch"]);

export function parsePointerLine(line: string): PointerEvent | null {
  try {
    const value = JSON.parse(line) as { type?: unknown; width?: unknown };
    return typeof value.type === "string" && TYPES.has(value.type) && typeof value.width === "number" ? (value as PointerEvent) : null;
  } catch {
    return null;
  }
}

/** The pointer as fractions across and down the plot image, or null when it's outside. */
export function plotFraction(event: Located, rect: PlotRect): { u: number; v: number } | null {
  const u = (event.x / event.width - rect.left) / rect.width;
  const v = (event.y / event.height - rect.top) / rect.height;
  return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { u, v } : null;
}

type Listener = (event: PointerEvent) => void;

/**
 * The handler is replaced on every render rather than on mount. Raycast reuses
 * a warm worker when the command reopens without always running mount effects
 * again, which left events arriving with nobody to hand them to until a
 * preference change forced a remount.
 */
let current: Listener | null = null;
let helper: ChildProcess | null = null;
let announced = false;

function startHelper(): void {
  if (helper) return;
  const binary = join(environment.assetsPath, "mouse-helper");
  if (!existsSync(binary)) {
    // Mouse input is optional; without the helper, keys still do everything.
    if (!announced) {
      announced = true;
      console.log("[grapher] no mouse helper: building it needs swiftc, from Xcode's command line tools");
    }
    return;
  }
  try {
    // Copying assets can drop the executable bit.
    chmodSync(binary, 0o755);
  } catch {
    // Already executable, or not ours to change; spawning will say.
  }

  const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
  helper = child;
  console.log(`[grapher] mouse helper started, pid ${child.pid}`);
  let buffer = "";
  let seen = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const event = parsePointerLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (!event) continue;
      if (seen++ === 0) console.log(`[grapher] first mouse event: ${event.type}, handler ${current ? "attached" : "missing"}`);
      current?.(event);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => console.log(`[grapher] mouse helper: ${chunk.trim()}`));
  child.on("exit", (code, signal) => {
    console.log(`[grapher] mouse helper exited, code ${code}, signal ${signal}`);
    if (helper === child) helper = null;
  });
  child.on("error", (error) => {
    console.log(`[grapher] mouse helper failed to start: ${error.message}`);
    if (helper === child) helper = null;
    void showToast({ style: Toast.Style.Failure, title: "Mouse mode couldn't start its helper", message: error.message });
  });
}

/** Stops the helper with the worker, not with a mount: Raycast reuses a worker across opens. */
function stopHelper(): void {
  const child = helper;
  helper = null;
  child?.stdin?.end();
  child?.kill();
}
process.once("exit", stopHelper);

/** Runs the helper while `enabled`, handing each event to the latest `onEvent`. */
export function useMouse(enabled: boolean, onEvent: Listener): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  // No dependencies: a reused worker may skip mount effects, but it always renders.
  useEffect(() => {
    if (!enabled) return;
    current = (event) => handler.current(event);
    startHelper();
    return () => {
      current = null;
    };
  });
}
