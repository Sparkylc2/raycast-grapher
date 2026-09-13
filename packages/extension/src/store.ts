import { environment } from "@raycast/api";
import { type Scene, emptyScene, parseScene } from "@grapher/core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The scene file is the handoff point between Raycast and the viewer window.
 *
 * Raycast owns the expression list, the viewer owns the cameras, and both read
 * and write this one file, so "open in viewer" carries the full state across
 * and a later Raycast preview picks up wherever the camera was left.
 */
const scenePath = (): string => join(environment.supportPath, "scene.json");

export async function loadScene(): Promise<Scene> {
  try {
    return parseScene(await readFile(scenePath(), "utf8"));
  } catch {
    return emptyScene();
  }
}

export async function saveScene(scene: Scene): Promise<void> {
  await mkdir(environment.supportPath, { recursive: true });
  await writeFile(scenePath(), JSON.stringify(scene, null, 2), "utf8");
}
