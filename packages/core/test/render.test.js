import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CAMERA_2D,
  DEFAULT_ORBIT,
  KANAGAWA_DRAGON,
  analyzeDocument,
  buildScene3D,
  findIntersections,
  renderPlots,
  renderScene3D,
} from "../dist/index.js";

const theme = KANAGAWA_DRAGON;
const size = { width: 240, height: 180 };
const doc = (...sources) =>
  analyzeDocument(sources.map((source, i) => ({ id: String(i), source, color: theme.series[i % theme.series.length] })));
const plotsOf = (...sources) => doc(...sources).entries.flatMap((e) => e.plots);

/** Counts opaque-ish pixels, optionally only in a column band. */
const ink = (rgba, { fromCol = 0, toCol = size.width } = {}) => {
  let n = 0;
  for (let row = 0; row < size.height; row++) {
    // Low enough to count region shading, which is deliberately faint.
    for (let col = fromCol; col < toCol; col++) if (rgba[(row * size.width + col) * 4 + 3] > 40) n++;
  }
  return n;
};
const render = (plots, options = {}) =>
  renderPlots(plots, { ...DEFAULT_CAMERA_2D, spanY: 10 }, size, theme, { transparent: true, ...options });

test("every 2D plot kind puts something on the canvas", () => {
  const empty = ink(render([]));
  for (const source of [
    "y = sin(x)",
    "x^2 + y^2 = 9",
    "y < x",
    "(2cos t, 2sin t)",
    "(1, 2)",
    "y' = y [y(0) = 1]",
    "u_t = u_xx [0, pi; 0, 1] {x, t} [u(x, 0) = sin(x)]",
  ]) {
    const plots = plotsOf(source);
    assert.ok(plots.length > 0, source);
    assert.ok(ink(render(plots)) > empty + 20, `${source} drew nothing`);
  }
});

test("a domain range stops the curve drawing outside it", () => {
  const full = render(plotsOf("y = 0.5"));
  const restricted = render(plotsOf("y = 0.5 [0, 5]"));
  // The left half of the view is x < 0, outside the range.
  const half = size.width / 2 - 4;
  assert.ok(ink(full, { toCol: half }) > ink(restricted, { toCol: half }) + 50);
});

test("the playhead reveals a trajectory from the left", () => {
  const plots = plotsOf("y' = 0.2 [-8, 8] [y(-8) = 1]").filter((p) => p.kind === "trajectory");
  const early = ink(render(plots, { playhead: -4 }));
  const late = ink(render(plots, { playhead: 6 }));
  assert.ok(late > early + 100, `${early} vs ${late}`);
});

test("intersections of a line and a circle are exact", () => {
  const plots = plotsOf("y = x", "x^2 + y^2 = 4");
  const points = findIntersections(plots, { ...DEFAULT_CAMERA_2D, spanY: 10 }, size);
  assert.equal(points.length, 2);
  const r = Math.SQRT2;
  assert.ok(Math.abs(points[0].x + r) < 1e-9 && Math.abs(points[0].y + r) < 1e-9);
  assert.ok(Math.abs(points[1].x - r) < 1e-9 && Math.abs(points[1].y - r) < 1e-9);
});

test("curves crossing several times report each crossing once", () => {
  const plots = plotsOf("y = sin(x)", "y = 0");
  const points = findIntersections(plots, { ...DEFAULT_CAMERA_2D, spanY: 10 }, size);
  // Visible x spans about ±6.67: crossings at 0, ±π and ±2π.
  assert.equal(points.length, 5);
  for (const p of points) assert.ok(Math.abs(Math.sin(p.x)) < 1e-9);
});

test("parametric curves intersect at segment precision", () => {
  const plots = plotsOf("(2cos t, 2sin t)", "y = 0");
  const points = findIntersections(plots, { ...DEFAULT_CAMERA_2D, spanY: 10 }, size);
  assert.equal(points.length, 2);
  for (const p of points) assert.ok(Math.abs(Math.abs(p.x) - 2) < 0.01);
});

test("a highlighted intersection draws its coordinates", () => {
  const plots = plotsOf("y = x", "y = 2 - x");
  const points = findIntersections(plots, { ...DEFAULT_CAMERA_2D, spanY: 10 }, size);
  const plain = ink(render(plots, { intersections: points }));
  const labelled = ink(render(plots, { intersections: points, highlight: 0 }));
  assert.ok(labelled > plain + 30);
});

test("implicit surfaces mesh onto the true surface", () => {
  const [entry] = doc("x^2 + y^2 + z^2 = 4").entries;
  const scene = buildScene3D(entry.surfaces, "draft");
  const [mesh] = scene.meshes;
  assert.ok(mesh.indices.length > 300);
  let worst = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const r = Math.hypot(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
    worst = Math.max(worst, Math.abs(r - 2));
  }
  assert.ok(worst < 0.05, `vertices stray ${worst} from the sphere`);
});

test("every 3D kind renders, and orbiting changes the picture", () => {
  for (const source of [
    "z = sin(x) cos(y)",
    "x^2 + y^2 + z^2 = 9",
    "(cos u sin v, sin u sin v, cos v) [0, 2pi; 0, pi]",
    "(cos t, sin t, t/5) [0, 12]",
    "u_t = u_xx [0, pi; 0, 1] {x, t, u} [u(x, 0) = sin(x)]",
  ]) {
    const [entry] = doc(source).entries;
    assert.equal(entry.error, null, source);
    const scene = buildScene3D(entry.surfaces, "draft");
    const a = renderScene3D(scene, DEFAULT_ORBIT, size, theme, { transparent: true });
    const b = renderScene3D(scene, { ...DEFAULT_ORBIT, yaw: DEFAULT_ORBIT.yaw + 1 }, size, theme, { transparent: true });
    assert.ok(ink(a) > 200, `${source} drew ${ink(a)} pixels`);
    let differ = 0;
    for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) differ++;
    assert.ok(differ > 100, `${source} looked the same after orbiting`);
  }
});
