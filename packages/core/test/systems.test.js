import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument, orbitValueAt } from "../dist/index.js";

const doc = (sources) =>
  analyzeDocument(sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" }))).entries;

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);

const kinds = (entry) => entry.plots.map((p) => p.kind);

test("a harmonic oscillator as a system: field, orbit and a centre", () => {
  const [entry] = doc(["X' = [X(2); -X(1)] [0, 7] [X(0) = [1; 0]]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.system.size, 2);
  assert.ok(kinds(entry).includes("vectors"));
  assert.ok(kinds(entry).includes("orbit"));
  const orbit = entry.system.orbits[0];
  near(orbitValueAt(orbit.t, orbit.states[0], Math.PI), -1, 1e-6);
  near(orbitValueAt(orbit.t, orbit.states[1], Math.PI / 2), -1, 1e-6);
  const [rest] = entry.plots.filter((p) => p.kind === "equilibrium");
  assert.deepEqual([rest.x, rest.y, rest.stable], [0, 0, false]);
  assert.deepEqual(entry.timeRange, { lo: 0, hi: 7 });
});

test("a matrix system uses the named axes and marks a stable spiral", () => {
  const [, entry] = doc(["A = [0, 1; -2, -0.3]", "X' = A * X {x, v} [X(0) = [1; 0]]"]);
  assert.equal(entry.error, null);
  assert.deepEqual(entry.axes, ["x", "v"]);
  const [rest] = entry.plots.filter((p) => p.kind === "equilibrium");
  assert.equal(rest.stable, true);
});

test("a saddle draws its two eigenvector lines", () => {
  const [, entry] = doc(["B = [1, 0; 0, -1]", "X' = B * X"]);
  assert.equal(entry.error, null);
  assert.equal(entry.plots.filter((p) => p.kind === "parametric").length, 2);
  assert.equal(entry.plots.find((p) => p.kind === "equilibrium").stable, false);
});

test("the pendulum's equilibria are found without starting values", () => {
  const [entry] = doc(["X' = [X(2); -sin(X(1))]"]);
  assert.equal(entry.error, null);
  const rests = entry.plots.filter((p) => p.kind === "equilibrium").map((p) => p.x).sort((a, b) => a - b);
  assert.equal(rests.length, 3);
  near(rests[0], -Math.PI, 1e-9);
  near(rests[1], 0, 1e-9);
  near(rests[2], Math.PI, 1e-9);
});

test("three components draw in 3D", () => {
  const [entry] = doc(["X' = [10*(X(2) - X(1)); X(1)*(28 - X(3)) - X(2); X(1)*X(2) - 8/3*X(3)] [0, 2] [X(0) = [1; 1; 1]]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.dimension, 3);
  assert.ok(entry.surfaces.some((s) => s.kind === "curve3d"));
});

test("more components are drawn against time", () => {
  const [entry] = doc(["X' = [X(2); -X(1); X(4); -X(3)] [0, 3] [X(0) = [1; 0; 0; 1]]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.plots.filter((p) => p.kind === "trajectory").length, 4);
});

test("scalar equations are still differential equations, and bad starts are explained", () => {
  const [scalar, bad] = doc(["y' = y [0, 1] [y(0) = 1]", "X' = [X(2); -X(1)] [X(0) = [1; 0; 0]]"]);
  assert.equal(scalar.system, null);
  assert.ok(scalar.ode);
  assert.match(bad.error, /needs 3 numbers|one rate per component/);
});
