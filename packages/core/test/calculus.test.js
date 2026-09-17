import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument } from "../dist/index.js";

const doc = (sources, options) =>
  analyzeDocument(
    sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" })),
    options,
  ).entries;

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

test("nested derivatives of an unknown combine into a higher order", () => {
  // y'' + y' = 0 with y(0) = 1, y'(0) = -1 is solved by y = e^(-x).
  const [entry] = doc(["d/dx(d/dx(y)) + d/dx(y) = 0 [0, 3] [y(0) = 1, y'(0) = -1]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.ode.order, 2);
  assert.ok(Math.abs(at(entry.ode.solutions[0], 2) - Math.exp(-2)) < 1e-5);
});

test("the chain rule applies to unknowns inside a derivative", () => {
  // d/dx(y^2) = x means 2y y' = x, so y^2 = x^2/2 + 1 from y(0) = 1.
  const [entry] = doc(["d/dx(y^2) = x [0, 3] [y(0) = 1]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.ode.order, 1);
  assert.match(entry.resolved, /2y/);
  assert.ok(Math.abs(at(entry.ode.solutions[0], 2) - Math.sqrt(3)) < 1e-5);
});

test("differentiating an implicit curve gives its differential equation", () => {
  // d/dx(x^2 + y^2) = 0 is 2x + 2y y' = 0: the circle through (0, 2).
  const [entry] = doc(["d/dx(x^2 + y^2) = 0 [0, 1.5] [y(0) = 2]"]);
  assert.equal(entry.error, null);
  assert.ok(Math.abs(at(entry.ode.solutions[0], 1) - Math.sqrt(3)) < 1e-5);
  const slopes = [];
  entry.plots.find((p) => p.kind === "slopes").slopes(1, 2, slopes);
  assert.ok(Math.abs(slopes[0] + 0.5) < 1e-9, "slope is -x/y");
});

test("products with an unknown use the product rule", () => {
  const [entry] = doc(["d/dx(x y') = -y [1, 4] [y(1) = 1, y'(1) = 0]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.ode.order, 2);
  assert.equal(entry.ode.independent, "x");
  assert.equal(entry.resolved, "dy/dx + x * d^2y/dx^2 = -y");
  // x y'' + y' + y = 0: check the residual numerically at x = 2. The step must be
  // several sample spacings wide, or the second difference measures interpolation noise.
  const s = entry.ode.solutions[0];
  const h = 1e-2;
  const y = (x) => at(s, x);
  const d1 = (y(2 + h) - y(2 - h)) / (2 * h);
  const d2 = (y(2 + h) - 2 * y(2) + y(2 - h)) / (h * h);
  assert.ok(Math.abs(2 * d2 + d1 + y(2)) < 1e-4, `residual ${2 * d2 + d1 + y(2)}`);
});

test("sliders stay constant inside a total derivative", () => {
  const [entry] = doc(["d/dt(k y') = -y [0, 7] [y(0) = 0, y'(0) = 1]", "k = 1"]);
  assert.equal(entry.error, null);
  // k y'' = -y with k = 1 is sin(t).
  assert.ok(Math.abs(at(entry.ode.solutions[0], Math.PI / 2) - 1) < 1e-5);
});

test("derivatives without unknowns keep their meaning", () => {
  const [curve, surface, fn] = doc(["y = d/dx(a x^3)", "z = d/dx(x y)", "g(x) = d/dx(sin(x))"]);
  assert.equal(curve.plots[0].kind, "explicit");
  assert.equal(curve.plots[0].f(2), 12, "a is an undefined slider worth 1");
  assert.equal(surface.surfaces[0].kind, "explicitSurface");
  assert.equal(surface.surfaces[0].f(3, 5), 5, "3D derivatives are partial");
  assert.equal(fn.error, null);
});

test("composition feeds the chain rule", () => {
  const [, entry] = doc(["f(x) = x^3", "d/dx(f(y)) = 3x^2 [0, 2] [y(0) = 0]"]);
  assert.equal(entry.error, null);
  // 3y^2 y' = 3x^2 means y = x.
  assert.match(entry.resolved, /y\^2/);
});

test("variable coefficients in PDEs use the product rule", () => {
  const [entry] = doc(["u_t = d/dx((1 + x^2) u_x) [0, 1; 0, 0.05] {x, t} [u(x, 0) = sin(pi x), u(0, t) = 0, u(1, t) = 0]"]);
  assert.equal(entry.error, null);
  assert.equal(entry.pde.solution.blewUpAt, null);
  assert.match(entry.resolved, /2x/);
});

test("mixing variables inside a derivative is reported", () => {
  const [entry] = doc(["u_t = d/dt(u_x) + u_xx [u(x, 0) = 1]"]);
  assert.match(entry.error, /Mixed derivatives/);
});

test("strict calls refuse juxtaposed multiplication", () => {
  const loose = doc(["y = a(x + 1)"]);
  assert.equal(loose[0].error, null);
  const strict = doc(["y = a(x + 1)", "f(x) = x^2", "y = f(x + 1)"], { strictCalls: true });
  assert.match(strict[0].error, /isn't a defined function/);
  assert.equal(strict[2].error, null, "defined functions still work");
});
