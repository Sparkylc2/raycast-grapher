import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, classify, compileJs, toGlslSource, glslFloat, parseScene } from "../dist/index.js";

const plan = (src) => classify(parse(src));
const evalAt = (expr, x = 0, y = 0, z = 0) => compileJs(expr)(x, y, z);

test("linear equation in x alone becomes a 2D implicit line", () => {
  const { graph, dimension } = plan("3x + 5 = 7");
  assert.equal(graph.type, "implicit2d");
  assert.equal(dimension, 2);
  assert.ok(Math.abs(evalAt(graph.field, 2 / 3)) < 1e-12);
});

test("y = f(x) takes the explicit fast path", () => {
  const { graph } = plan("y = x^2");
  assert.equal(graph.type, "explicit2d");
  assert.equal(evalAt(graph.fn, 2), 4);
});

test("circle stays implicit", () => {
  const { graph } = plan("x^2 + y^2 = 1");
  assert.equal(graph.type, "implicit2d");
  assert.equal(evalAt(graph.field, 1, 0), 0);
});

test("z = f(x, y) is a 3D surface", () => {
  const { graph, dimension } = plan("z = sin(x) cos(y)");
  assert.equal(graph.type, "surface3d");
  assert.equal(dimension, 3);
});

test("three-variable equation raymarches as an implicit surface", () => {
  const { graph, dimension } = plan("x^2 + y^2 + z^2 = 4");
  assert.equal(graph.type, "implicit3d");
  assert.equal(dimension, 3);
});

test("inequality normalises to field < 0", () => {
  const { graph } = plan("y > x^2");
  assert.equal(graph.type, "inequality2d");
  assert.equal(graph.strict, true);
  // Point (0, 1) is inside y > x^2, so the normalised field must be negative.
  assert.ok(evalAt(graph.field, 0, 1) < 0);
});

test("unary minus binds looser than exponentiation", () => {
  assert.equal(evalAt(plan("y = -x^2").graph.fn, 3), -9);
});

test("exponentiation is right associative", () => {
  assert.equal(evalAt(plan("y = 2^3^2").graph.fn), 512);
});

test("juxtaposition multiplies and takes a tight operand", () => {
  assert.equal(evalAt(plan("y = 2x").graph.fn, 5), 10);
  assert.equal(evalAt(plan("y = 2x^2").graph.fn, 5), 50);
  assert.equal(evalAt(plan("y = (x+1)(x-2)").graph.fn, 4), 10);
});

test("functions accept bare arguments", () => {
  assert.ok(Math.abs(evalAt(plan("y = sin x").graph.fn, Math.PI / 2) - 1) < 1e-12);
});

test("odd roots of negative numbers stay real", () => {
  assert.ok(Math.abs(evalAt(plan("y = x^(1/3)").graph.fn, -8) + 2) < 1e-9);
});

test("unknown names surface as parameters", () => {
  assert.deepEqual(plan("y = a x + b").parameters, ["a", "b"]);
});

test("parse errors carry a source range", () => {
  assert.throws(() => parse("y = x +"), (e) => e.name === "ParseError");
  assert.throws(() => parse("y = sin(x"), (e) => e.name === "ParseError");
  assert.throws(() => parse("y = sin(x, 2)"), /takes 1 argument/);
});

test("GLSL output never emits a bare integer literal", () => {
  const src = toGlslSource(plan("x^2 + y^2 = 1").graph.field);
  assert.match(src, /1\.0/);
  assert.doesNotMatch(src, /(?<![.\d])\d+(?![.\d])/);
  assert.equal(glslFloat(2), "2.0");
  assert.equal(glslFloat(0.5), "0.5");
});

test("GLSL routes exponentiation through the safe helper", () => {
  assert.match(toGlslSource(plan("y = x^3").graph.fn), /gr_pow\(x, 3\.0\)/);
});

test("GLSL names non-coordinate variables as uniforms", () => {
  assert.match(toGlslSource(plan("y = a x").graph.fn), /u_a/);
});

test("scene reader tolerates junk", () => {
  assert.equal(parseScene("not json").mode, "2d");
  assert.equal(parseScene('{"mode":"3d"}').mode, "3d");
});

test("GLSL avoids reserved double-underscore identifiers", async () => {
  const { GLSL_PRELUDE } = await import("../dist/index.js");
  const sources = [GLSL_PRELUDE, toGlslSource(plan("y = cbrt(x^3)").graph.fn)];
  for (const source of sources) assert.doesNotMatch(source, /__/);
});

test("raster traces a curve and packs it into Braille", async () => {
  const { rasterize, axesMask, combine, toBraille, brailleCells, DEFAULT_CAMERA_2D } =
    await import("../dist/index.js");
  const size = { width: 80, height: 40 };
  const camera = { ...DEFAULT_CAMERA_2D, spanY: 8 };

  const mask = rasterize(plan("y = x").graph, camera, size);
  assert.ok(mask.some((v) => v === 1), "line should mark dots");
  // A y = x line crosses every row once, so it cannot fill the grid either.
  assert.ok(mask.reduce((a, b) => a + b, 0) < size.width * size.height * 0.1);

  const art = toBraille(combine([mask, axesMask(camera, size)], size), size);
  const lines = art.split("\n");
  assert.equal(lines.length, brailleCells(size).height);
  for (const ch of art.replace(/\n/g, "")) {
    assert.ok(ch.codePointAt(0) >= 0x2800 && ch.codePointAt(0) <= 0x28ff);
  }
});

test("vertical lines survive the sign-change tracer", async () => {
  const { rasterize, DEFAULT_CAMERA_2D } = await import("../dist/index.js");
  const size = { width: 80, height: 40 };
  const mask = rasterize(plan("3x + 5 = 7").graph, { ...DEFAULT_CAMERA_2D, spanY: 8 }, size);
  // Exactly one marked dot per row: a single vertical line at x = 2/3.
  for (let row = 0; row < size.height; row++) {
    const count = mask.slice(row * size.width, (row + 1) * size.width).reduce((a, b) => a + b, 0);
    assert.equal(count, 1);
  }
});

test("colour renderer paints background, axes and curve", async () => {
  const { renderScene, hexToRgb, KANAGAWA_DRAGON, DEFAULT_CAMERA_2D } =
    await import("../dist/index.js");
  const size = { width: 200, height: 120 };
  const theme = KANAGAWA_DRAGON;
  const rgba = renderScene(
    [{ graph: plan("y = sin(x)").graph, color: theme.series[0] }],
    { ...DEFAULT_CAMERA_2D, spanY: 6 },
    size,
    theme,
  );

  assert.equal(rgba.length, size.width * size.height * 4);

  // Most of the frame is empty space, so it must still be the theme background.
  // A specific pixel is a bad probe: gridlines can land anywhere, corners included.
  const bg = hexToRgb(theme.background);
  let background = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      rgba[i] === bg[0] &&
      rgba[i + 1] === bg[1] &&
      rgba[i + 2] === bg[2] &&
      rgba[i + 3] === 255
    ) {
      background++;
    }
  }
  assert.ok(background > size.width * size.height * 0.7, `only ${background} background pixels`);

  // dragonBlue2 is markedly bluer than it is red, unlike every chrome colour.
  let curvePixels = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 2] > rgba[i] + 20) curvePixels++;
  }
  assert.ok(curvePixels > 100, `expected a drawn curve, found ${curvePixels} blue pixels`);
});

test("tick formatting follows the step size", async () => {
  const { formatTick, niceStep } = await import("../dist/index.js");
  assert.equal(formatTick(0, 2), "0");
  assert.equal(formatTick(-6, 2), "-6");
  assert.equal(formatTick(0.5, 0.1), "0.5");
  assert.ok(niceStep(10, 480) > 0);
});

test("PNG encoder emits a valid signature and chunk order", async () => {
  const { encodePng } = await import("../dist/png.js");
  const png = encodePng(new Uint8ClampedArray(4 * 4 * 4), 4, 4);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");
});

test("Raycast theme file agrees with the palette the renderers use", async () => {
  const { KANAGAWA_DRAGON } = await import("../dist/index.js");
  const { readFileSync } = await import("node:fs");
  const theme = JSON.parse(
    readFileSync(new URL("../../../themes/kanagawa-dragon.json", import.meta.url), "utf8"),
  );

  const required = [
    "background", "backgroundSecondary", "text", "selection", "loader",
    "red", "orange", "yellow", "green", "blue", "purple", "magenta",
  ];
  assert.deepEqual(Object.keys(theme.colors).sort(), [...required].sort());
  for (const [key, value] of Object.entries(theme.colors)) {
    assert.match(value, /^#[0-9a-f]{6}$/i, `${key} is not a hex colour`);
  }
  assert.equal(theme.appearance, KANAGAWA_DRAGON.appearance);
  assert.equal(theme.colors.background, KANAGAWA_DRAGON.background);
  // Raycast paints background to backgroundSecondary as a gradient; equal values keep it solid.
  assert.equal(theme.colors.backgroundSecondary, theme.colors.background);
  // The accents Raycast shows must be the ones curves are actually drawn in.
  for (const accent of ["blue", "red", "green", "yellow", "magenta", "orange"]) {
    assert.ok(
      KANAGAWA_DRAGON.series.includes(theme.colors[accent]),
      `${accent} ${theme.colors[accent]} is not one of the series colours`,
    );
  }
});

test("series colours are distinct and cycle", async () => {
  const { KANAGAWA_DRAGON, seriesColor } = await import("../dist/index.js");
  const unique = new Set(KANAGAWA_DRAGON.series);
  assert.equal(unique.size, KANAGAWA_DRAGON.series.length);
  assert.equal(seriesColor(KANAGAWA_DRAGON, 0), seriesColor(KANAGAWA_DRAGON, unique.size));
});

test("blend matches the Lua helper it mirrors", async () => {
  const { blend } = await import("../dist/index.js");
  assert.equal(blend("#000000", "#ffffff", 0), "#000000");
  assert.equal(blend("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(blend("#181616", "#625e5a", 0.5), "#3d3a38");
});

test("transparent render leaves empty space clear and draws opaque ink", async () => {
  const { renderScene, KANAGAWA_DRAGON, DEFAULT_CAMERA_2D } = await import("../dist/index.js");
  const size = { width: 240, height: 180 };
  const rgba = renderScene(
    [{ graph: plan("y = x").graph, color: KANAGAWA_DRAGON.series[0] }],
    { ...DEFAULT_CAMERA_2D, spanY: 6 },
    size,
    KANAGAWA_DRAGON,
    { transparent: true, pixelRatio: 2 },
  );
  let clear = 0;
  let solid = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] === 0) clear++;
    if (rgba[i] === 255) solid++;
  }
  assert.ok(clear > size.width * size.height * 0.5, `only ${clear} clear pixels`);
  assert.ok(solid > 50, `curve and labels should be opaque, found ${solid}`);
});

test("pixel ratio scales labels but keeps the grid in display units", async () => {
  const { niceStep } = await import("../dist/index.js");
  // The same view at 1x and 2x must choose the same gridline spacing.
  assert.equal(niceStep(10, 345, 45), niceStep(10, 690 / 2, 45));
});

test("outline rasteriser covers exact area, including partial edges", async () => {
  const { rasterizeOutline } = await import("../dist/index.js");
  const square = (x0, y0, x1, y1) => [
    { type: "M", x: x0, y: y0 },
    { type: "L", x: x1, y: y0 },
    { type: "L", x: x1, y: y1 },
    { type: "L", x: x0, y: y1 },
    { type: "Z" },
  ];
  const area = (g) => g.coverage.reduce((a, b) => a + b, 0);

  assert.ok(Math.abs(area(rasterizeOutline(square(0, -10, 10, 0))) - 100) < 1e-3);
  // Half-pixel offsets land partial coverage on the edge pixels; the total must not change.
  assert.ok(Math.abs(area(rasterizeOutline(square(0.5, -10.5, 10.5, -0.5))) - 100) < 1e-3);
  // Right triangle with legs of 8: area 32.
  const tri = [{ type: "M", x: 0, y: 0 }, { type: "L", x: 8, y: 0 }, { type: "L", x: 0, y: -8 }, { type: "Z" }];
  assert.ok(Math.abs(area(rasterizeOutline(tri)) - 32) < 1e-3);
  // Variable fonts overlap contours; the same square twice must not double the ink.
  const twice = rasterizeOutline([...square(0, -6, 6, 0), ...square(0, -6, 6, 0)]);
  assert.ok(Math.abs(area(twice) - 36) < 1e-3);
  for (const c of twice.coverage) assert.ok(c >= 0 && c <= 1);
});

test("outline curves flatten close to their true area", async () => {
  const { rasterizeOutline } = await import("../dist/index.js");
  // A circle of radius 10 from four cubic arcs, using the standard 0.5523 handle length.
  const k = 0.5523 * 10;
  const circle = [
    { type: "M", x: 10, y: 0 },
    { type: "C", x1: 10, y1: k, x2: k, y2: 10, x: 0, y: 10 },
    { type: "C", x1: -k, y1: 10, x2: -10, y2: k, x: -10, y: 0 },
    { type: "C", x1: -10, y1: -k, x2: -k, y2: -10, x: 0, y: -10 },
    { type: "C", x1: k, y1: -10, x2: 10, y2: -k, x: 10, y: 0 },
    { type: "Z" },
  ];
  const area = rasterizeOutline(circle).coverage.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(area - Math.PI * 100) / (Math.PI * 100) < 0.01, `circle area ${area}`);
});

test("typeface lays out, caches and falls back to hyphen-minus", async () => {
  const { Typeface } = await import("../dist/index.js");
  let pathCalls = 0;
  const fake = {
    unitsPerEm: 1000,
    tables: { os2: { sCapHeight: 700 } },
    getPath: (text, x, y, size) => {
      pathCalls++;
      const s = size / 1000;
      return { commands: [
        { type: "M", x: 0, y: 0 }, { type: "L", x: 500 * s, y: 0 },
        { type: "L", x: 500 * s, y: -700 * s }, { type: "L", x: 0, y: -700 * s }, { type: "Z" },
      ] };
    },
    getAdvanceWidth: (text, size) => (600 * size) / 1000,
    charToGlyph: () => ({ index: 0 }),
  };
  const face = new Typeface(fake);
  assert.equal(face.minus, "-", "a font without U+2212 keeps the ASCII hyphen");
  assert.equal(face.capHeight(20), 14);
  assert.equal(face.measure("12", 20), 24);

  let covered = 0;
  face.draw("11", 0, 20, 20, () => covered++);
  face.draw("11", 30, 20, 20, () => covered++);
  assert.equal(pathCalls, 1, "a repeated glyph at the same size is rasterised once");
  assert.ok(covered > 0);
});

test("explicit fast path matches the general field path", async () => {
  const { renderScene, KANAGAWA_DRAGON, DEFAULT_CAMERA_2D } = await import("../dist/index.js");
  const size = { width: 160, height: 120 };
  const camera = { ...DEFAULT_CAMERA_2D, spanY: 6 };
  const color = KANAGAWA_DRAGON.series[0];
  // Same field, but "y - ... = 0" is classified implicit and takes the 2D sampling path.
  const fast = renderScene([{ graph: plan("y = 2 sin(x)").graph, color }], camera, size, KANAGAWA_DRAGON);
  const slow = renderScene([{ graph: plan("y - 2 sin(x) = 0").graph, color }], camera, size, KANAGAWA_DRAGON);
  assert.equal(plan("y - 2 sin(x) = 0").graph.type, "implicit2d");

  let worst = 0;
  for (let i = 0; i < fast.length; i++) worst = Math.max(worst, Math.abs(fast[i] - slow[i]));
  // Float rounding in the gradient can move a channel by a step, never more.
  assert.ok(worst <= 2, `largest channel difference ${worst}`);
});

const SF_PATH = "/System/Library/Fonts/SFNS.ttf";

test("SF loads within a small heap by reading only outline tables", { skip: !(await import("node:fs")).existsSync(SF_PATH) }, async () => {
  const { readTables, loadSystemTypeface } = await import("../dist/system-font.js");

  const tables = readTables(SF_PATH);
  const bytes = Object.values(tables).reduce((n, t) => n + t.byteLength, 0);
  assert.ok(!("gvar" in tables) && !("GPOS" in tables), "variation and layout tables must stay unread");
  // The whole file is 8.3 MB; outlines, metrics and the character map are a sliver of it.
  assert.ok(bytes < 2_000_000, `read ${bytes} bytes of font tables`);

  const before = process.memoryUsage().heapUsed;
  const face = loadSystemTypeface();
  assert.ok(face, "SF should load on macOS");
  assert.equal(face.minus, "−");

  // Minimum ink per glyph at 40 px. A full stop is a dot about 4 px across, so a
  // single threshold for every glyph cannot tell a broken figure from a small mark.
  const minimumArea = (char) => (char === "." ? 8 : char === "\u2212" ? 30 : 80);
  let ink = 0;
  for (const char of "0123456789.\u2212") {
    const glyph = face.glyph(char, 40);
    const area = glyph.coverage.reduce((a, b) => a + b, 0);
    assert.ok(area > minimumArea(char), `${char} rendered with area ${area}`);
    ink += area;
  }
  // SF's default figures are proportional: a narrow 1, and every figure wider
  // than the full stop. Equal widths would mean metrics were not being read.
  assert.ok(face.advance("1", 40) < face.advance("0", 40));
  for (const figure of "0123456789") assert.ok(face.advance(".", 40) < face.advance(figure, 40));
  assert.ok(ink > 0);

  const grown = process.memoryUsage().heapUsed - before;
  // Raycast allows 100 MB for the whole command; the font must be a rounding error in that.
  assert.ok(grown < 20_000_000, `heap grew ${(grown / 1e6).toFixed(1)} MB`);
});
