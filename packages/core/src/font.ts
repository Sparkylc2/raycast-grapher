/**
 * A 5x7 bitmap font covering just what axis labels need.
 *
 * Tick numbers are the difference between a picture and a graph, and there is
 * no text rendering available on this path, so the glyphs are inlined. The
 * earlier 3x5 set turned blocky once scaled to a readable size; 5x7 is the
 * smallest grid where digits keep their shapes.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  e: ["00000", "00000", "01110", "10001", "11111", "10000", "01110"],
};

export const GLYPH_WIDTH = 5;
export const GLYPH_HEIGHT = 7;
/** One blank column between glyphs, at unscaled size. */
export const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

export const textWidth = (text: string, scale: number): number =>
  Math.max(0, text.length * GLYPH_ADVANCE - 1) * scale;

export const textHeight = (scale: number): number => GLYPH_HEIGHT * scale;

/**
 * Calls `plot` for every lit pixel of `text`, with the top-left at (x, y).
 * Leaving the blending to the caller keeps this free of any pixel format.
 */
export function drawText(
  text: string,
  x: number,
  y: number,
  scale: number,
  plot: (px: number, py: number) => void,
): void {
  // Callers work in fractional pixel space, but a fractional index into a typed
  // array is silently dropped, so snap to the pixel grid before plotting.
  let cursor = Math.round(x);
  const top = Math.round(y);
  for (const char of text) {
    const glyph = GLYPHS[char];
    if (glyph) {
      for (let row = 0; row < GLYPH_HEIGHT; row++) {
        const bits = glyph[row]!;
        for (let col = 0; col < GLYPH_WIDTH; col++) {
          if (bits[col] !== "1") continue;
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              plot(cursor + col * scale + dx, top + row * scale + dy);
            }
          }
        }
      }
    }
    cursor += GLYPH_ADVANCE * scale;
  }
}
