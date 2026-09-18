import { Canvas, makeInk, paletteOf } from "./render.js";
import { type GraphTheme, hexToRgb } from "./theme.js";
import type { Typeface } from "./typeface.js";

/**
 * Sliders drawn into the plot image, so the pointer can grab them. Raycast
 * gives an extension no controls of its own on the plot, but the picture is
 * ours, and mouse input already knows where on it a click lands.
 *
 * Positions are in display points, the size the image is shown at, from its
 * top-left; drawing multiplies by the pixel ratio.
 */

export interface SliderGlyph {
  readonly id: string;
  readonly name: string;
  /** The value as the line shows it, already rounded to the step. */
  readonly valueText: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly active: boolean;
  readonly color: string;
}

export interface SliderTrack {
  readonly id: string;
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
}

const MAX_SLIDERS = 4;
const ROW = 22;
const MARGIN = 12;
const LABEL = 78;
const TRACK = 140;

/** Where each slider's track runs, stacked up from the bottom-left corner, first slider on top. */
export function sliderTracks(sliders: readonly { readonly id: string }[], displayHeight: number): SliderTrack[] {
  const shown = sliders.slice(0, MAX_SLIDERS);
  return shown.map((slider, i) => ({
    id: slider.id,
    x0: MARGIN + LABEL,
    x1: MARGIN + LABEL + TRACK,
    y: displayHeight - MARGIN - (shown.length - i - 0.5) * ROW,
  }));
}

/** Draws the sliders over a rendered frame and returns the new pixels. */
export function drawSliders(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  ratio: number,
  sliders: readonly SliderGlyph[],
  theme: GraphTheme,
  typeface?: Typeface,
): Uint8ClampedArray {
  const tracks = sliderTracks(sliders, height / ratio);
  if (tracks.length === 0) return rgba;
  const canvas = new Canvas(width, height, null);
  canvas.data.set(rgba);
  const palette = paletteOf(theme);

  // A translucent panel keeps labels and tracks readable over whatever is plotted.
  const left = Math.floor((MARGIN - 6) * ratio);
  const right = Math.ceil((MARGIN + LABEL + TRACK + 10) * ratio);
  const top = Math.floor((tracks[0]!.y - ROW / 2 - 4) * ratio);
  const bottom = Math.ceil((tracks[tracks.length - 1]!.y + ROW / 2 + 2) * ratio);
  for (let py = Math.max(0, top); py < Math.min(height, bottom); py++) {
    for (let px = Math.max(0, left); px < Math.min(width, right); px++) canvas.blend(px, py, palette.background, 0.78);
  }

  const ink = makeInk(canvas, typeface, 10.5 * ratio, ratio, palette);
  tracks.forEach((track, i) => {
    const slider = sliders[i]!;
    const color = hexToRgb(slider.color);
    const y = track.y * ratio;
    const x0 = track.x0 * ratio;
    const x1 = track.x1 * ratio;

    // A long value falls back to the name alone rather than running into the track.
    const full = `${slider.name} = ${slider.valueText}`;
    const label = ink.width(full) <= (LABEL - 8) * ratio ? full : slider.name;
    ink.stamp(label, MARGIN * ratio, y - ink.height / 2);

    const f = slider.max > slider.min ? Math.min(1, Math.max(0, (slider.value - slider.min) / (slider.max - slider.min))) : 0;
    const knob = x0 + f * (x1 - x0);
    const thickness = Math.max(1, Math.round(1.5 * ratio));
    for (let dy = -thickness; dy <= thickness; dy++) {
      const row = Math.round(y) + dy;
      const cover = 1 - Math.abs(dy) / (thickness + 1);
      for (let px = Math.floor(x0); px <= Math.ceil(x1); px++) {
        canvas.blend(px, row, px <= knob ? color : palette.grid, (px <= knob ? 0.95 : 0.8) * cover);
      }
    }
    const radius = (slider.active ? 6 : 5) * ratio;
    canvas.disc(knob, y, radius + ratio, palette.background, 0.9);
    canvas.disc(knob, y, radius, color);
  });
  return canvas.data;
}
