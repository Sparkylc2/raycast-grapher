/**
 * Kanagawa Dragon, the palette this project is dressed in.
 *
 * Both renderers read from here. The GPU viewer and the CPU rasteriser had
 * already drifted apart once over gridline spacing, so colour lives in exactly
 * one place and each surface converts it to whatever form it needs.
 *
 * Role assignments follow the author's Neovim config rather than being invented:
 * gridlines take the `LineNr` grey, axis and tick labels take `dragonGray`, and
 * the series order follows the lualine mode accents, blue first.
 */

export interface GraphTheme {
  readonly name: string;
  readonly appearance: "dark" | "light";
  /** Plot ground. */
  readonly background: string;
  /** Raised surfaces such as the viewer's readout panel. */
  readonly surface: string;
  readonly grid: string;
  readonly axis: string;
  readonly text: string;
  readonly error: string;
  /** Cycled through as expressions are added. */
  readonly series: readonly string[];
}

export const KANAGAWA_DRAGON: GraphTheme = {
  name: "Kanagawa Dragon",
  appearance: "dark",
  background: "#181616", // dragonBlack3
  surface: "#0d0c0c", // dragonBlack0
  grid: "#625e5a", // the LineNr grey; gridlines are line numbers by another name
  axis: "#a6a69c", // dragonGray
  text: "#a6a69c", // dragonGray, legible at bitmap-font sizes where the grey is not
  error: "#e46876",
  series: [
    "#8ba4b0", // dragonBlue2
    "#c4746e", // dragonRed
    "#8a9a7b", // dragonGreen2
    "#c4b28a", // dragonYellow
    "#a292a3", // dragonPink
    "#b6927b", // dragonOrange
    "#8ea4a2", // dragonAqua
  ],
};

/** Kanagawa Lotus, the upstream light counterpart, for light-appearance Raycast. */
export const KANAGAWA_LOTUS: GraphTheme = {
  name: "Kanagawa Lotus",
  appearance: "light",
  background: "#f2ecbc",
  surface: "#e7dba0",
  grid: "#8a8980",
  axis: "#545464",
  text: "#545464",
  error: "#c84053",
  series: ["#4d699b", "#c84053", "#6f894e", "#77713f", "#624c83", "#cc6d00", "#597b75"],
};

export const DEFAULT_THEME = KANAGAWA_DRAGON;

export type RGB = readonly [number, number, number];

/** Parses "#rrggbb" to 0-255 channels. Falls back to the first series colour. */
export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [139, 164, 176];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Same, in the 0-1 range shaders want. */
export function hexToRgbUnit(hex: string): RGB {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/** Mixes two hex colours. t=0 returns a, t=1 returns b. */
export function blend(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const channel = (x: number, y: number): string =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

export function seriesColor(theme: GraphTheme, index: number): string {
  return theme.series[index % theme.series.length]!;
}
