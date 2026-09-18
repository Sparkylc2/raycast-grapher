/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Animation Frame Rate - Upper limit on frames per second while the plot moves. Lower it if motion stutters. */
  "frameRate": "15" | "30" | "45" | "60",
  /** Function Calls - When on, a(x + 1) is an error unless a is a defined function, instead of meaning a times (x + 1). */
  "strictCalls": boolean,
  /** Intersections - Don't look for or mark the crossings between curves. */
  "hideIntersections": boolean,
  /** Sliders - Show the sliders the selected line reads in the plot's corner, where the pointer can drag them. */
  "slidersOnPlot": boolean
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `graph` command */
  export type Graph = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `graph` command */
  export type Graph = {
  /** y = sin(x) */
  "expression": string
}
}

