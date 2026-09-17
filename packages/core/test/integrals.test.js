import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument, quadrature } from "../dist/index.js";

const lines = (sources) => sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" }));
const doc = (sources) => analyzeDocument(lines(sources)).entries;
/** Constant values by name, as the document computed them. */
const values = (sources) => {
  const analysis = analyzeDocument(lines(sources));
  for (const entry of analysis.entries) assert.equal(entry.error, null, `${entry.source}: ${entry.error}`);
  return analysis.params;
};

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);

const curve = (entry) => {
  assert.equal(entry.error, null);
  const plot = entry.plots.find((p) => p.kind === "explicit");
  assert.ok(plot, `no curve for ${entry.source}`);
  return plot.f;
};

// The quadrature itself

test("adaptive quadrature is exact to many digits on smooth integrands", () => {
  near(quadrature(Math.sin, 0, Math.PI).value, 2, 1e-12);
  near(quadrature((x) => Math.exp(-x * x), -Infinity, Infinity).value, Math.sqrt(Math.PI), 1e-10);
  near(quadrature((x) => 1 / (1 + x * x), 0, Infinity).value, Math.PI / 2, 1e-10);
  near(quadrature(Math.cos, 1, 0).value, -Math.sin(1), 1e-12);
});

test("an integrable singularity at an endpoint still converges", () => {
  near(quadrature((x) => 1 / Math.sqrt(x), 0, 1).value, 2, 1e-7);
  near(quadrature((x) => Math.log(x), 0, 1).value, -1, 1e-8);
});

// Integrals in the document

test("a definite integral over the whole line is a constant", () => {
  const params = values(["I = int(exp(-x^2), x, -inf, inf)"]);
  near(params.I, Math.sqrt(Math.PI), 1e-10);
  const [entry] = doc(["I = int(exp(-x^2), x, -inf, inf)"]);
  assert.equal(entry.description, "I = 1.77245");
});

test("integral is another name for int", () => {
  near(values(["k = integral(x^2, x, 0, 3)"]).k, 9, 1e-10);
});

test("a running integral draws as a curve", () => {
  const f = curve(doc(["y = int(sin(t)/t, t, 0, x)"])[0]);
  const si1 = 0.946083070367183;
  near(f(1), si1, 1e-9);
  near(f(-1), -si1, 1e-9);
  near(f(0), 0, 1e-12);
});

test("a bound can name the integration variable, meaning the outer one", () => {
  const [running, derivative] = doc(["y = int(t^2, t, 0, x) + int(x^2, x, 0, x)", "y = d/dx int(x^2, x, 0, x)"]);
  near(curve(running)(3), 18, 1e-9);
  near(curve(derivative)(3), 9, 1e-12);
  assert.equal(values(["k = int(x^2, x, 0, 2)"]).k.toFixed(6), (8 / 3).toFixed(6));
});

test("derivatives of integrals follow the fundamental theorem and the Leibniz rule", () => {
  const [F, derivative, leibniz] = doc(["F(x) = int(cos(t), t, 0, x)", "y = F'(x)", "y = d/dx int(x t, t, 0, x)"]);
  near(curve(F)(1), Math.sin(1), 1e-9);
  assert.equal(derivative.resolved, "y = cos(x)");
  near(curve(derivative)(0.5), Math.cos(0.5), 1e-12);
  // x·x from the moving end, plus the integral of t from 0 to x: 3x²/2.
  near(curve(leibniz)(2), 6, 1e-8);
});

test("double and triple integrals, with an inner bound that uses an outer variable", () => {
  const params = values(["A = int(x y, y, 0, x, x, 0, 1)", "V = int(x y z, z, 0, 1, y, 0, 1, x, 0, 1)"]);
  near(params.A, 1 / 8, 1e-9);
  near(params.V, 1 / 8, 1e-9);
});

test("integrals over a region", () => {
  const params = values([
    "D = int(1, x^2 + y^2 < 1, x, -1, 1, y, -1, 1)",
    "M = int(x^2 + y^2 + z^2, x^2 + y^2 + z^2 < 1, x, -1, 1, y, -1, 1, z, -1, 1)",
    "H = int(1, y > x^2, y, 0, 1, x, -1, 1)",
  ]);
  near(params.D, Math.PI, 1e-5);
  near(params.M, (4 * Math.PI) / 5, 1e-3);
  // The area above the parabola and below 1 is 4/3.
  near(params.H, 4 / 3, 1e-5);
});

test("an integral over a parameter is a surface", () => {
  const [entry] = doc(["z = int(exp(-(x - s)^2 - (y - s)^2), s, 0, 1)"]);
  assert.equal(entry.error, null);
  assert.equal(entry.dimension, 3);
  const f = entry.surfaces[0].f;
  const reference = quadrature((s) => Math.exp(-((0.3 - s) ** 2) - (-0.2 - s) ** 2), 0, 1).value;
  near(f(0.3, -0.2), reference, 1e-10);
});

test("integrals follow sliders", () => {
  const params = values(["a = 2 [0, 5]", "k = int(x^a, x, 0, 1)"]);
  near(params.k, 1 / 3, 1e-10);
});

test("badly formed integrals explain themselves", () => {
  const [short, inside, equals] = doc([
    "int(x, x, 0)",
    "k2 = int(x y, y, 0, 1, x, 0, y)",
    "k3 = int(1, x = 1, x, 0, 1)",
  ]);
  assert.match(short.error, /int takes an expression/);
  assert.match(inside.error, /integrated inside it/);
  assert.match(equals.error, /A region goes second/);
});

// Derivatives of minimum and maximum

test("the derivative of a minimum over a range uses the envelope theorem", () => {
  // min over t of (t - x)^2 + t is x - 1/4, so its derivative is 1.
  const f = curve(doc(["y = d/dx min((t - x)^2 + t, t, -5, 5)"])[0]);
  near(f(2), 1, 1e-5);
  near(f(-1), 1, 1e-5);
});

test("a running maximum's derivative follows the moving end until the peak", () => {
  const f = curve(doc(["y = d/dx max(sin(t), t, 0, x)"])[0]);
  near(f(1), Math.cos(1), 1e-5);
  near(f(3), 0, 1e-5);
});

test("argmin can't be differentiated", () => {
  const [entry] = doc(["y = d/dx argmin((t - x)^2, t, -5, 5)"]);
  assert.match(entry.error, /Can't differentiate argmin/);
});
