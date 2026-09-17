import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument, frameAt, profileAt, sampleFrame } from "../dist/index.js";

const doc = (sources) =>
  analyzeDocument(sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" }))).entries;

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);

/** u at a point and time from a 2D or 3D field line. */
const valueAt = (entry, point, t) => {
  const { solution } = entry.field;
  return sampleFrame(solution, frameAt(solution, t), point);
};

test("the 2D heat equation decays like its exact solution", () => {
  const [entry] = doc([
    "u_t = u_xx + u_yy [0, 1; 0, 1; 0, 0.05] {x, y, t} [u(x, y, 0) = sin(pi x) sin(pi y), u = 0 on boundary]",
  ]);
  assert.equal(entry.error, null);
  assert.equal(entry.field.display, "heatmap");
  assert.equal(entry.plots[0].kind, "heatmap");
  assert.deepEqual(entry.timeRange, { lo: 0, hi: 0.05 });
  near(valueAt(entry, [0.5, 0.5], 0.05), Math.exp(-2 * Math.PI * Math.PI * 0.05), 0.02);
});

test("lap(u) sums the space derivatives, and naming u in the axes draws a surface", () => {
  const [entry] = doc(["u_t = lap(u) [0, 1; 0, 1; 0, 0.05] {x, y, t, u} [u(x, y, 0) = sin(pi x) sin(pi y), u = 0 on boundary]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.field.display, "surface");
  assert.equal(entry.dimension, 3);
  assert.equal(entry.surfaces[0].kind, "gridSurface");
  near(valueAt(entry, [0.5, 0.5], 0.05), Math.exp(-2 * Math.PI * Math.PI * 0.05), 0.02);
});

test("a periodic wave in 2D comes back inverted after half a period", () => {
  const [entry] = doc(["u_tt = lap(u) [0, 1; 0, 1; 0, 0.5] {x, y, t} [u(x, y, 0) = sin(2 pi x), periodic]"]);
  assert.equal(entry.error, null);
  near(valueAt(entry, [0.25, 0.5], 0.5), -1, 0.05);
});

test("a periodic advection in 1D goes through the grid solver and shows like any 1D PDE", () => {
  const [entry] = doc(["u_t = -u_x [0, 2pi; 0, pi] [u(x, 0) = sin(x), periodic]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.pde.display, "heatmap");
  const { solution } = entry.pde;
  const profile = profileAt(solution, Math.PI);
  const index = Math.round((Math.PI / 2 / (2 * Math.PI)) * solution.cols);
  near(profile[index], -1, 0.05);
});

test("a 3D heat equation draws an isosurface", () => {
  const started = performance.now();
  const [entry] = doc([
    "u_t = lap(u) [-1, 1; -1, 1; -1, 1; 0, 0.02] {x, y, z, t} [u(x, y, z, 0) = exp(-10(x^2 + y^2 + z^2)), u = 0 on boundary]",
  ]);
  assert.equal(entry.error, null);
  assert.equal(entry.field.display, "isosurface");
  assert.equal(entry.surfaces[0].kind, "implicitSurface");
  // Heat spreads out, so the centre falls.
  assert.ok(valueAt(entry, [0, 0, 0], 0.02) < valueAt(entry, [0, 0, 0], 0));
  assert.ok(performance.now() - started < 20000);
});

test("a line's unknown wins over a constant of the same name elsewhere", () => {
  const line = "u_t = lap(u) [0, 1; 0, 1; 0, 0.1] {x, y, t} [u(x, y, 0) = 0]";
  for (const other of ["u = 1", "u = [1; 2]", "u = 3 + 4i"]) {
    const [, entry] = doc([other, line]);
    assert.equal(entry.error, null, `${other}: ${entry.error}`);
    assert.equal(entry.field.display, "heatmap");
  }
  const [, ode] = doc(["p = 2", "p' = -p [0, 1] [p(0) = 1]"]);
  assert.equal(ode.error, null);
  assert.ok(ode.ode);
});

test("face conditions go on a face", () => {
  const [entry] = doc(["u_t = lap(u) [0, 1; 0, 1; 0, 0.1] {x, y, t} [u(x, y, 0) = x, u(0.5, y, t) = 0]"]);
  assert.match(entry.error, /Boundary conditions go at x = 0 or 1/);
});
