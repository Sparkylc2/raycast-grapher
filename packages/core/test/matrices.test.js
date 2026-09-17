import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeDocument, describeTransform, determinantOf, matrixAt, transformPlots } from "../dist/index.js";

const doc = (sources, options) =>
  analyzeDocument(
    sources.map((source, i) => ({ id: String(i), source, color: "#8ba4b0" })),
    options,
  ).entries;

const near = (actual, expected, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `expected ${expected}, got ${actual}`);

/** The explicit curve a line draws, as a function of x. */
const curve = (entry) => {
  assert.equal(entry.error, null);
  const plot = entry.plots.find((p) => p.kind === "explicit");
  assert.ok(plot, `no curve for ${entry.source}`);
  return plot.f;
};

/** The tip of the 2D arrow a line draws. */
const arrow = (entry) => {
  assert.equal(entry.error, null);
  const plot = entry.plots.find((p) => p.kind === "arrow");
  assert.ok(plot, `no arrow for ${entry.source}`);
  return [plot.x1, plot.y1];
};

/** Compares an arrow tip with a small tolerance; entries go through symbolic arithmetic. */
const closeTo = (actual, expected, tolerance = 1e-9) =>
  expected.forEach((value, i) => near(actual[i], value, tolerance));

// Minimum and maximum over a range

test("min and argmin over a range find an interior minimum", () => {
  const [value, where] = doc(["min(x^2 - 2x, x, -2, 2)", "argmin(x^2 - 2x, x, -2, 2)"]);
  near(curve(value)(0), -1);
  near(curve(where)(0), 1);
});

test("an extreme on the edge of the range is found", () => {
  const [low, high, peak] = doc(["min(x, x, 1, 3)", "argmax(x, x, 1, 3)", "max(sin(x), x, 0, 3)"]);
  near(curve(low)(0), 1);
  near(curve(high)(0), 3);
  near(curve(peak)(0), 1);
});

test("the plot variable can appear inside, making an envelope curve", () => {
  // Minimising (t - x)^2 + t over t gives t = x - 1/2, so the curve is x - 1/4.
  const [entry] = doc(["y = min((t - x)^2 + t, t, -5, 5)"]);
  const f = curve(entry);
  near(f(2), 1.75);
  near(f(-1), -1.25);
});

test("the range can depend on the plot variable, as a running maximum", () => {
  const [entry] = doc(["y = max(sin(t), t, 0, x)"]);
  const f = curve(entry);
  near(f(1), Math.sin(1));
  near(f(3), 1);
});

test("two variables: the minimum value and the point where it happens", () => {
  const [m, p] = doc([
    "m = min((a - 1)^2 + (b + 2)^2 + 3, a, -5, 5, b, -5, 5)",
    "p = argmin((a - 1)^2 + (b + 2)^2 + 3, a, -5, 5, b, -5, 5)",
  ]);
  assert.equal(m.error, null);
  assert.equal(m.description, "m = 3");
  const [x, y] = arrow(p);
  near(x, 1, 1e-5);
  near(y, -2, 1e-5);
});

test("min and max with two arguments still compare numbers", () => {
  const [entry] = doc(["y = max(x, 0)"]);
  const f = curve(entry);
  assert.equal(f(-2), 0);
  assert.equal(f(3), 3);
});

test("badly formed reductions explain themselves", () => {
  const [notName, short, dependent] = doc(["min(x^2, 2, 0, 1)", "min(x, x, 0)", "argmin(t, t, 0, t)"]);
  assert.match(notName.error, /variable name/);
  assert.match(short.error, /min over a range takes/);
  assert.match(dependent.error, /range of t can't depend on t/);
});

// Matrices

test("spaces separate entries, but a spaced minus is subtraction", () => {
  const [pair, single] = doc(["v = [1 -2]", "w = [1 - 2]"]);
  assert.equal(pair.description, "v, 1×2 vector");
  assert.equal(single.description, "w = -1");
});

test("a vector constant draws as an arrow from the origin", () => {
  const [entry] = doc(["v = [1; 2]"]);
  assert.equal(entry.kind, "constant");
  closeTo(arrow(entry), [1, 2]);
});

test("matrix times vector, with the result shown", () => {
  const entries = doc(["A = [1, 1; -1, 1]", "v = [1; 2]", "A * v"]);
  assert.equal(entries[0].description, "A, 2×2 matrix");
  closeTo(arrow(entries[2]), [3, 1]);
  assert.equal(entries[2].resolved, "= [3; 1]");
});

test("entries are indexed from 1, down each column for a single index", () => {
  const [, , a, b, c] = doc(["A = [1, 1; -1, 1]", "v = [5; 7]", "a = A(2, 1)", "b = v(2)", "c = A(3)"]);
  assert.equal(a.description, "a = -1");
  assert.equal(b.description, "b = 7");
  assert.equal(c.description, "c = 1");
  const [, outside] = doc(["A = [1, 1; -1, 1]", "A(3, 1)"]);
  assert.match(outside.error, /outside a 2×2 matrix/);
});

test("determinant, inverse, left division and powers", () => {
  const entries = doc([
    "A = [1, 1; -1, 1]",
    "d = det(A)",
    "inv(A) * [3; 1]",
    "A \\ [3; 1]",
    "A^2 * [1; 0]",
    "A^-1 * [3; 1]",
    "[3; 1]' / A",
  ]);
  assert.equal(entries[1].description, "d = 2");
  closeTo(arrow(entries[2]), [1, 2]);
  closeTo(arrow(entries[3]), [1, 2]);
  closeTo(arrow(entries[4]), [0, -2]);
  closeTo(arrow(entries[5]), [1, 2]);
  // A row vector over A is [3, 1] * inv(A) = [2, -1].
  closeTo(arrow(entries[6]), [2, -1]);
});

test("a prime transposes a matrix, and so does transpose()", () => {
  const entries = doc(["A = [1, 1; -1, 1]", "B = A'", "B * [1; 0]", "transpose(A) * [0; 1]", "(A * A)' * [1; 0]"]);
  assert.equal(entries[1].description, "B, 2×2 matrix");
  closeTo(arrow(entries[2]), [1, 1]);
  closeTo(arrow(entries[3]), [-1, 1]);
  closeTo(arrow(entries[4]), [0, 2]);
});

test("elementwise operators, norms, dot and cross products", () => {
  const entries = doc([
    "A = [1, 2; 3, 4]",
    "(A .* A) * [1; 0]",
    "[6; 8] ./ [3; 4]",
    "[2; 3] .^ 2",
    "n = norm([3; 4])",
    "k = dot([1; 2], [3; 4])",
    "cross([1; 0; 0], [0; 1; 0])",
    "sqrt([4; 9])",
  ]);
  closeTo(arrow(entries[1]), [1, 9]);
  closeTo(arrow(entries[2]), [2, 2]);
  closeTo(arrow(entries[3]), [4, 9]);
  assert.equal(entries[4].description, "n = 5");
  assert.equal(entries[5].description, "k = 11");
  assert.equal(entries[6].dimension, 3);
  const tip = entries[6].surfaces.find((s) => s.kind === "arrow3d");
  assert.deepEqual([tip.x, tip.y, tip.z], [0, 0, 1]);
  closeTo(arrow(entries[7]), [2, 3]);
});

test("identity and filled matrices", () => {
  const [eye, zeros, ones] = doc(["eye(2) * [4; 5]", "Z = zeros(2, 3)", "ones(2, 1)"]);
  closeTo(arrow(eye), [4, 5]);
  assert.equal(zeros.description, "Z, 2×3 matrix");
  closeTo(arrow(ones), [1, 1]);
});

test("eigenvalues come out sorted, and complex ones draw as points", () => {
  const [real, complex, named, use] = doc(["eig([3, 0; 0, 2])", "eig([0, -1; 1, 0])", "ev = eig([1, -2; 2, 1])", "ev * 2"]);
  closeTo(arrow(real), [2, 3]);
  assert.equal(complex.error, null);
  assert.deepEqual(complex.axes, ["Re", "Im"]);
  assert.deepEqual(complex.plots.map((p) => [p.x, p.y]), [[0, 1], [0, -1]]);
  assert.equal(complex.resolved, "= 0 + 1i, 0 - 1i");
  assert.equal(named.error, null);
  assert.equal(named.resolved, "ev = 1 + 2i, 1 - 2i");
  assert.match(use.error, /complex eigenvalues/);
});

test("an equation between vectors is one equation per entry, drawn together", () => {
  const [system, partial, never] = doc(["[1, 1; 1, -1] * [x; y] = [3; 1]", "[x; 1] = [2; 1]", "[x; 1] = [2; 3]"]);
  assert.equal(system.error, null);
  assert.equal(system.description, "2 equations, drawn together");
  assert.equal(system.plots.length, 2);
  // Both curves pass through the solution, (2, 1).
  for (const plot of system.plots) near(plot.F(2, 1), 0, 1e-12);
  assert.equal(partial.plots.length, 1);
  assert.match(never.error, /Entry 2, 1 = 3, never holds/);
});

test("a product of matrices plays as steps, rightmost first", () => {
  const entries = doc(["A = [0, -1; 1, 0]", "B = [2, 0; 0, 1]", "A * B * [1; 1]"]);
  const transform = entries[2].transform;
  assert.deepEqual(transform.steps.map((s) => s.label), ["B", "A"]);
  assert.deepEqual(transform.vectors, [[1, 1]]);
  // Everything applied is A B.
  assert.deepEqual(matrixAt(transform, 2), [[0, -1], [2, 0]]);
  // Halfway through B, a stretch that has half grown.
  matrixAt(transform, 0.5).flat().forEach((value, i) => near(value, [1.5, 0, 0, 1][i]));
  // B done and A half turned: the first basis vector points at 45 degrees.
  const halfway = matrixAt(transform, 1.5);
  near(halfway[0][0], Math.SQRT2, 1e-12);
  near(halfway[1][0], Math.SQRT2, 1e-12);
  assert.match(describeTransform(transform, 1.5), /^Applying A, step 2 of 2/);
  assert.match(describeTransform(transform, 2), /^B then A applied/);
  const tip = transformPlots(transform, 2, { grid: "#000000", square: "#000000", basis: ["#000000", "#000000"], vector: "#ffffff" })
    .filter((p) => p.kind === "arrow" && p.color === "#ffffff")[0];
  near(tip.x1, -1, 1e-12);
  near(tip.y1, 2, 1e-12);
});

test("a reflection folds flat halfway, and a matrix constant is a single step", () => {
  const [flip] = doc(["C = [1, 0; 0, -1]"]);
  assert.equal(flip.transform.steps.length, 1);
  near(determinantOf(matrixAt(flip.transform, 0.5)), 0, 1e-12);
  near(determinantOf(matrixAt(flip.transform, 1)), -1, 1e-12);
  const [cube] = doc(["R = [0, -1, 0; 1, 0, 0; 0, 0, 2]"]);
  assert.equal(cube.transform.dimension, 3);
  near(determinantOf(matrixAt(cube.transform, 1)), 2, 1e-12);
  // A vector alone, or a matrix with a free variable, isn't a transformation.
  const [vector, symbolic] = doc(["[1; 2]", "[x, 0; 0, 1]"]);
  assert.equal(vector.transform, null);
  assert.equal(symbolic.transform, null);
});

test("the matrix exponential of a generator is a rotation", () => {
  const [entry] = doc(["expm([0, -pi/2; pi/2, 0]) * [1; 0]"]);
  const [x, y] = arrow(entry);
  near(x, 0, 1e-9);
  near(y, 1, 1e-9);
});

test("mismatched sizes say which sizes met", () => {
  const [product, sum] = doc(["[1, 2] * [3, 4]", "[1; 2] + [1; 2; 3]"]);
  assert.match(product.error, /Can't multiply a 1×2 by a 1×2/);
  assert.match(sum.error, /\+ needs matching sizes, but these are 2×1 and 3×1/);
});

test("a rotation matrix follows its slider", () => {
  const [, , entry] = doc(["t = 0.5 [0, 6]", "R = [cos t, -sin t; sin t, cos t]", "R * [1; 0]"]);
  const [x, y] = arrow(entry);
  near(x, Math.cos(0.5));
  near(y, Math.sin(0.5));
});

test("a vector with a free variable is a parametric curve", () => {
  const [entry] = doc(["[cos(t); sin(t)]"]);
  assert.equal(entry.error, null);
  const plot = entry.plots[0];
  assert.equal(plot.kind, "parametric");
  near(plot.x(0), 1);
  near(plot.y(Math.PI / 2), 1);
});

test("a three-vector draws in 3D", () => {
  const [entry] = doc(["[1; 2; 3]"]);
  assert.equal(entry.dimension, 3);
  assert.equal(entry.surfaces[0].kind, "arrow3d");
});

test("functions can take and return matrices", () => {
  const entries = doc([
    "A = [1, 1; -1, 1]",
    "f(M) = M * M",
    "R(s) = [cos s, -sin s; sin s, cos s]",
    "f(A) * [1; 0]",
    "R(pi/2) * [1; 0]",
  ]);
  assert.equal(entries[2].description, "function R(s), 2×2 matrix");
  closeTo(arrow(entries[3]), [0, -2]);
  const [x, y] = arrow(entries[4]);
  near(x, 0, 1e-12);
  near(y, 1, 1e-12);
});

test("equations between matrices, and matrices where a number belongs, are errors", () => {
  const [, relation, range, hint] = doc(["A = [1, 1; -1, 1]", "A * [1; 0] = [1; 1]", "y = x [0, A]", "A [1; 2]"]);
  assert.match(relation.error, /Entry 2, -1 = 1, never holds/);
  assert.match(range.error, /Expected a number here, but this is a 2×2 matrix/);
  assert.match(hint.error, /put \* before it/);
});
