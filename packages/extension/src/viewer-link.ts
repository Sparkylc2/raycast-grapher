import type { Scene } from "@grapher/core";

/**
 * The one place that knows where the interactive window lives.
 *
 * Raycast itself cannot host a draggable canvas: extensions render native
 * List/Grid/Detail/Form components and there is no webview or canvas element.
 * So the pannable graph has to live in a window Raycast launches rather than
 * one it draws. Everything above this seam is shell-agnostic; swapping the
 * host means rewriting only this file.
 */
export interface ViewerHost {
  readonly name: string;
  open(scene: Scene): Promise<void>;
}

export function sceneUrl(base: string, scene: Scene): string {
  return `${base}#${encodeURIComponent(JSON.stringify(scene))}`;
}
