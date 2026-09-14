import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument, setSliderValue, stepSlider } from "../dist/index.js";
import { profileAt } from "../dist/pde.js";

const doc = (...sources) =>
  analyzeDocument(sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" })));

/** Linear interpolation of a sampled solution at time t. */
const at = (solution, t) => {
  const { t: ts, y } = solution;
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] >= t) {
      const w = (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
      return y[i - 1] * (1 - w) + y[i] * w;
    }
  }
  return NaN;
};

// Differential equations, checked against exact solutions

test("y' = y from y(0) = 1 follows e^t in both directions", () => {
  const [entry] = doc("y' = y [-2, 2] [y(0) = 1]").entries;
  assert.equal(entry.error, null);
  assert.equal(entry.ode.order, 1);
  assert.equal(entry.ode.linear, true);
  const [solution] = entry.ode.solutions;
  assert.ok(Math.abs(at(solution, 1) - Math.E) < 1e-6);
  assert.ok(Math.abs(at(solution, -1.5) - Math.exp(-1.5)) < 1e-6);
});

test("y'' = -y is simple harmonic motion", () => {
  const [entry] = doc("d^2y/dx^2 = -y [0, 7] [y(0) = 0, y'(0) = 1]").entries;
  assert.equal(entry.error, null);
  assert.equal(entry.ode.order, 2);
  const [solution] = entry.ode.solutions;
  for (const t of [Math.PI / 2, Math.PI, 5]) {
    // Linear interpolation between samples alone is worth about 1e-6 here.
    assert.ok(Math.abs(at(solution, t) - Math.sin(t)) < 1e-5, `sin at ${t}`);
  }
});

test("an equation that can't be rearranged for y' is solved implicitly", () => {
  // (y')^3 + y' = 2 has the single real root y' = 1, so y = t.
  const [entry] = doc("(y')^3 + y' = 2 [0, 3] [y(0) = 0]").entries;
  assert.equal(entry.error, null);
  assert.equal(entry.ode.linear, false);
  assert.ok(Math.abs(at(entry.ode.solutions[0], 2.5) - 2.5) < 1e-6);
});

test("implicit equations with several branches report every slope", () => {
  const [entry] = doc("(y')^2 = x^2 + y^2").entries;
  const slopes = entry.plots.find((p) => p.kind === "slopes");
  const out = [];
  slopes.slopes(3, 4, out);
  out.sort((a, b) => a - b);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0] + 5) < 1e-6 && Math.abs(out[1] - 5) < 1e-6);
});

test("the user's example line: q is time, p is plotted, p_0 is a slider", () => {
  const { entries } = doc("p^2 + 3q^2 + dp/dq + p_0 = 0 [-5, 5; -5, 5] {p, q} [p0 = 5]");
  const [entry] = entries;
  assert.equal(entry.error, null);
  assert.deepEqual(entry.axes, ["q", "p"]);
  assert.equal(entry.ode.independent, "q");
  assert.deepEqual(entry.missing, ["p_0"]);
  assert.equal(entry.ode.solutions.length, 1);
  assert.equal(entry.ode.solutions[0].t0, 0);
  // dp/dq at the starting point is -(25 + 0 + p_0) with p_0 = 1.
  const field = entry.plots.find((p) => p.kind === "slopes");
  const out = [];
  field.slopes(0, 5, out);
  assert.ok(Math.abs(out[0] + 26) < 1e-9);
});

test("several starting values give several solution curves", () => {
  const [entry] = doc("y' = -y [0, 3] [y(0) = 1, y(0) = 2, y(0) = -1]").entries;
  assert.equal(entry.ode.solutions.length, 3);
});

test("differential equation mistakes explain themselves", () => {
  assert.match(doc("y'' = -y").entries[0].error, /needs starting values/);
  assert.match(doc("y' = y [z(0) = 1]").entries[0].error, /starting values like y\(0\)/);
  assert.match(doc("y' = x' ").entries[0].error, /One unknown function/);
});

// Partial differential equations

test("heat equation matches its exact solution", () => {
  const [entry] = doc("u_t = u_xx [0, pi; 0, 1] {x, t} [u(x, 0) = sin(x), u(0, t) = 0, u(pi, t) = 0]").entries;
  assert.equal(entry.error, null);
  assert.equal(entry.pde.display, "heatmap");
  const profile = profileAt(entry.pde.solution, 1);
  const mid = profile[(profile.length - 1) / 2];
  // u = e^(-t) sin(x); the grid error is second order in dx.
  assert.ok(Math.abs(mid - Math.exp(-1)) < 2e-3, `u(pi/2, 1) = ${mid}`);
});

test("wave equation matches its exact solution", () => {
  const [entry] = doc("u_tt = u_xx [0, pi; 0, 2] {x, t} [u(x, 0) = sin(x), u(0, t) = 0, u(pi, t) = 0]").entries;
  assert.equal(entry.error, null);
  const profile = profileAt(entry.pde.solution, 1.5);
  const mid = profile[(profile.length - 1) / 2];
  assert.ok(Math.abs(mid - Math.cos(1.5)) < 2e-3, `u(pi/2, 1.5) = ${mid}`);
});

test("Leibniz notation works for PDEs, and three axes ask for a surface", () => {
  const [entry] = doc("du/dt = d^2u/dx^2 [0, 1; 0, 0.1] {x, t, u} [u(x, 0) = x(1 - x)]").entries;
  assert.equal(entry.error, null);
  assert.equal(entry.pde.display, "surface");
  assert.equal(entry.dimension, 3);
});

test("PDE mistakes explain themselves", () => {
  assert.match(doc("u_t = u_xx").entries[0].error, /starting profile/);
  assert.match(doc("u_tx = u_xx [u(x, 0) = 1]").entries[0].error, /Mixed derivatives/);
});

// Documents: functions, sliders, parametrics, axes

test("sliders define values, carry bounds and rewrite in place", () => {
  const { entries, sliders, params } = doc("a = 2 [0, 10]", "y = a x");
  assert.equal(entries[0].kind, "slider");
  assert.equal(params.a, 2);
  assert.equal(entries[1].plots[0].f(3), 6);
  assert.deepEqual(entries[1].uses, ["a"]);

  const [slider] = sliders;
  assert.equal(slider.min, 0);
  assert.equal(slider.max, 10);
  assert.equal(slider.step, 0.5);
  assert.equal(stepSlider(slider, 1), 2.5);
  assert.equal(setSliderValue("a = 2 [0, 10]", slider, 2.5), "a = 2.5 [0, 10]");
  assert.equal(stepSlider({ ...slider, value: 10 }, 1), 10, "clamped to the top");
});

test("undefined names are reported and evaluate as 1 until defined", () => {
  const { entries, params } = doc("y = k x + b");
  assert.deepEqual(entries[0].missing, ["b", "k"]);
  assert.equal(params.k, 1);
});

test("user functions, their derivatives and parameterizations", () => {
  const { entries } = doc("f(x) = x^3 + a", "g(t) = cos(t)", "y = f'(x)", "(g(t), f(t))", "a = 0");
  assert.equal(entries[0].kind, "function");
  assert.equal(entries[0].plots.length, 1, "a function of x plots itself");
  assert.equal(entries[1].plots.length, 0, "a function of t does not");
  assert.equal(entries[2].plots[0].f(2), 12);
  assert.equal(entries[2].resolved, "y = 3x^2");
  const curve = entries[3].plots[0];
  assert.equal(curve.kind, "parametric");
  assert.ok(Math.abs(curve.x(0) - 1) < 1e-12 && Math.abs(curve.y(2) - 8) < 1e-12);
  assert.ok(Math.abs(curve.range.hi - 2 * Math.PI) < 1e-12);
});

test("juxtaposition still multiplies when the name isn't a function", () => {
  const { entries } = doc("y = a(x + 1)", "a = 3");
  assert.equal(entries[0].plots[0].f(1), 6);
});

test("ranges restrict what is drawn", () => {
  const [explicit, curve] = doc("y = x^2 [-1, 2]", "(cos t, sin t) [0, pi]").entries;
  assert.deepEqual(explicit.plots[0].domain, { lo: -1, hi: 2 });
  assert.ok(Math.abs(curve.plots[0].range.hi - Math.PI) < 1e-12);
});

test("custom axes plot against any variable names", () => {
  const [entry] = doc("p^2 + 3q^2 = 4 {q, p}").entries;
  assert.equal(entry.error, null);
  assert.deepEqual(entry.axes, ["q", "p"]);
  const F = entry.plots[0].F;
  assert.ok(Math.abs(F(1, 1)) < 1e-12, "q = 1, p = 1 lies on the curve");
});

test("points, 3D curves, surfaces and implicit surfaces", () => {
  const { entries } = doc("(1, 2)", "(cos t, sin t, t/4)", "(u cos v, u sin v, u)", "z = x y", "x^2 + y^2 + z^2 = 4");
  assert.equal(entries[0].plots[0].kind, "point");
  assert.equal(entries[1].surfaces[0].kind, "curve3d");
  assert.equal(entries[2].surfaces[0].kind, "parametricSurface");
  assert.equal(entries[3].surfaces[0].kind, "explicitSurface");
  assert.equal(entries[4].surfaces[0].kind, "implicitSurface");
  assert.ok(entries.slice(1).every((e) => e.dimension === 3));
});

test("definition mistakes explain themselves", () => {
  assert.match(doc("f(x) = f(x) + 1", "y = f(x)").entries[1].error, /in terms of itself/);
  assert.match(doc("y = g(x, 1)").entries[0].error, /isn't defined/);
  assert.match(doc("a = 1", "a = 2").entries[1].error, /already defined/);
  assert.match(doc("b = c", "c = b").entries[0].error, /in terms of itself/);
});
