# raycast-grapher

Plot 2D and 3D equations from Raycast: explicit and implicit curves, parametric
plots, sliders, your own functions, exact derivatives, intersections,
differential equations and PDEs.

## Writing plots

One line per plot. Every line sees every other line, so a function or slider
defined anywhere can be used everywhere.

| Line | Meaning |
| --- | --- |
| `y = sin(x)` | curve |
| `x^2 + y^2 = 9` | implicit curve |
| `y < x^2 - 2` | shaded region |
| `a = 2 [0, 10, 0.5]` | slider from 0 to 10 in steps of 0.5 |
| `a = 2 [0.1]` | slider stepping by 0.1 over the default range |
| `f(x) = x^3 - a x` | function; a function of x also plots itself |
| `f(x, y) = x^2 - y^2` | a function of x and y plots itself as the surface z = f(x, y) |
| `y = f'(x)` or `y = d/dx sin(x^2)` | exact derivative |
| `d/dx(x^2 + y^2) = 0 [y(0) = 2]` | implicit differentiation, solved as a differential equation |
| `d/dx(d/dx(y)) + d/dx(y) = 0` | nested derivatives combine into `y'' + y' = 0` |
| `y = x^2 [-1, 2]` | draw only for x from -1 to 2 |
| `(cos t, sin 2t) [0, pi]` | parametric curve in t, default range 0 to 2π |
| `(1, 2)` | point |
| `p^2 + 3q^2 = 4 {q, p}` | plot against other variables, horizontal first |
| `z = sin(x) cos(y)` | surface |
| `x^2 + y^2 + z^2 = 4` | implicit surface |
| `(cos u sin v, sin u sin v, cos v) [0, 2pi; 0, pi]` | parametric surface in u and v |
| `y' = y - x [-5, 5] [y(0) = 1]` | differential equation: slope field and solution |
| `y'' = -y [0, 10] [y(0) = 0, y'(0) = 1]` | second order |
| `p^2 + 3q^2 + dp/dq + k = 0 {q, p} [p0 = 5]` | implicit, solved without isolating dp/dq |
| `u_t = u_xx [0, pi; 0, 1] {x, t} [u(x, 0) = sin(x), u(0, t) = 0]` | PDE as a heatmap |
| the same line with `{x, t, u}` | PDE as a surface |
| `y = min(f(x, t), t, -2, 2)` | smallest value over a range of t, as a curve in x |
| `y = max(sin(t), t, 0, x)` | running maximum: the range can depend on x |
| `p = argmin((a-1)^2 + b^2, a, -5, 5, b, -5, 5)` | where the minimum is; one entry per variable |
| `A = [1, 1; -1, 1]` | matrix, MATLAB style; spaces also separate entries |
| `v = [1; 2]` | column vector, drawn as an arrow |
| `A * v`, `A \ v`, `A^2`, `A'` | matrix product, solve, power, transpose |
| `R = [cos t, -sin t; sin t, cos t]` | a matrix that follows the slider t |
| `[cos t; sin t]` | a vector with a free variable is a parametric curve |
| `[1, 1; 1, -1] * [x; y] = [3; 1]` | one equation per entry, drawn together; their crossing is the solution |
| `eig([0, -1; 1, 0])` | eigenvalues; complex ones draw as points on axes Re and Im |
| `I = int(exp(-x^2), x, -inf, inf)` | definite integral; `integral` works too |
| `y = int(sin(t)/t, t, 0, x)` | running integral, as a curve |
| `A = int(x y, y, 0, x, x, 0, 1)` | double integral, bounds innermost first; inner bounds may use outer variables |
| `D = int(1, x^2 + y^2 < 1, x, -1, 1, y, -1, 1)` | integral over a region: an inequality, then a bounding box |
| `y = int(x^2, x, 0, x)` | a bound may name the integration variable; there it means the outer x |
| `X' = [X(2); -sin(X(1))] {angle, speed} [X(0) = [2; 0]]` | state space: direction arrows, nullclines, equilibria and orbits |
| `X' = A * X [X(0) = [1; 0]]` | a linear system; its eigenvector lines are drawn too |
| `u_t = lap(u) [0, 1; 0, 1; 0, 0.1] {x, y, t} [u(x, y, 0) = sin(pi x) sin(pi y), u = 0 on boundary]` | 2D PDE as a heatmap over x and y, played over time |
| the same with `{x, y, t, u}` | 2D PDE as a moving surface |
| `u_t = lap(u) [-1, 1; -1, 1; -1, 1; 0, 0.1] {x, y, z, t} [u(x, y, z, 0) = exp(-10(x^2 + y^2 + z^2)), u = 0 on boundary]` | 3D PDE as an isosurface; define `level` to choose the value |
| `z = 3 + 4i` | complex number, drawn on axes Re and Im; `i` is the imaginary unit unless you define it |
| `exp(i t)` | a complex function of one variable is a curve in the complex plane |
| `z = abs((x + i y)^2 - 1)` | real functions of complex values plot as usual |

- **Sliders.** A name nothing defines evaluates as 1, and becomes a slider line when you add the equation. The sliders a line reads are drawn on its plot, up to four; click or drag one to set it. In the list, press on a slider row and drag sideways to set it. Settings can hide the plot's sliders, and its intersections.
- **Derivatives of unknowns.** Inside a derivative, y depends on x in a 2D line, as does any name written with derivative notation or given conditions, so the chain rule applies: `d/dx(y^2)` is `2y y'`. Everything else is held constant, and in 3D lines every derivative is partial.
- **Strict calls.** The Function Calls preference makes `a(x + 1)` an error unless `a` is a defined function.
- **Time.** In a differential equation, the variable you differentiate by is time and sits on the horizontal axis.
- **Starting values.** `p0 = 5` in a condition list means `p(0) = 5`. Several values for the same order give several solution curves.
- **Names with subscripts.** `p_0` is an ordinary name. `u_t` and `u_xx` are derivatives when u is clearly an unknown, for example because it has conditions.
- **Minimum and maximum.** `min`, `max`, `argmin` and `argmax` take an expression, then a name, low and high for up to three variables. With two arguments, `min(a, b)` still compares two numbers. The search samples the whole range and then refines, so a minimum on the edge counts. It isn't differentiable, and several variables inside an implicit curve are slow.
- **Matrices.** `[1 -2]` has two entries and `[1 - 2]` one, as in MATLAB. `.*`, `./` and `.^` work entry by entry, and scalar functions such as `sin` apply to each entry. Indices start at 1: `A(2, 1)`, or `v(2)` counting down each column. A prime on a matrix transposes it. Also `eye`, `zeros`, `ones`, `transpose`, `trace`, `det`, `inv`, `norm`, `dot`, `cross`, `eig` and `expm`; the last two, and `inv` beyond 3×3, need entries that are fixed numbers. Numeric vectors of length 2 or 3 draw as arrows; other matrices show their value.
- **Integrals.** Up to three variables. Infinite bounds and integrable singularities at the ends are fine. `d/dx` of an integral follows the fundamental theorem and the Leibniz rule, so `F(x) = int(g(t), t, 0, x)` makes `F'(x)` read as `g(x)`; the same goes for `min` and `max` over a range, through the envelope theorem.
- **Transformations.** Selecting a line that multiplies numeric 2×2 or 3×3 matrices, like `A * B * v` or just `A = [1, 1; 0, 1]`, shows the grid, unit square and basis being moved, one matrix at a time from the right. Each step turns and stretches together, and a reflection folds flat halfway.
- **State spaces.** A vector unknown with one first-order rate per component. Two components show the phase plane: direction arrows, nullclines in grey, equilibria filled when stable and hollow when not, and an orbit from each starting vector that plays over time. Three components draw in 3D, and more draw each component against time. The first range is the time span, then one window per component.
- **PDEs in more dimensions.** Up to three space variables and second order in time, with `lap(u)` for the Laplacian. Faces default to zero slope; `u = g on boundary` fixes every face, `u(0, y, t) = g` or `u_x(0, y, t) = g` fixes one, and `periodic` or `periodic(x)` wraps them. The solver is explicit, so grids shrink to keep time steps affordable: about 64² in 2D and 28³ in 3D.
- **Complex numbers.** Arithmetic, powers, `exp`, `ln`, `log`, `sqrt`, the trig and hyperbolic functions, and `re`, `im`, `conj`, `arg` and `abs`. Matrices with complex entries and comparisons with `<` aren't supported.
- **PDEs.** One space variable, time called `t` or listed second in braces, up to second order in time and fourth in space. Boundaries without a condition have zero slope.

## Keys

| Keys | Action |
| --- | --- |
| Enter | Add the typed line, edit the selected line, or save an edit |
| Tab | Complete: add the next piece the hint shows |
| Cmd + . | Cancel an edit |
| Cmd + Backspace | Delete the selected line |
| Cmd + Shift + H | Hide or show a line |
| Cmd + Shift + N, E, I, O | Move left, down, up and right in 2D, or rotate and tilt in 3D |
| Option + = and Option + - | Zoom |
| Option + F | Zoom to the line's own ranges |
| Option + 0 | Reset the view |
| Cmd + ] and Cmd + [ | Step the current slider |
| Cmd + Shift + ] and Cmd + Shift + [ | Switch which slider steps |
| Cmd + U and Cmd + L | Next and previous intersection, or matrix step on a transformation |
| Cmd + Shift + Space | Play a solution over time, or a transformation's steps, or pause |
| Cmd + Shift + P | Show the whole solution, or the final transformation |
| Cmd + / | Show or hide the key help under the plot |
| Ctrl + 1 to Ctrl + 7 | Colour the typed, edited or selected line |
| Ctrl + 0 | Back to its automatic colour |

While you type, the row and the window title show what can come next, with
values to fill in between ‹ and ›. Raycast hides the search bar's placeholder as
soon as there's text, so the title is where the hint stays visible. Tab adds the next piece:
`ddx` becomes `d/dx(`, a function name gets `(` and then `, ` between
arguments, and a finished statement gets its brackets one value at a time, such
as `[`, `, `, then `] [y(0) = ` for a differential equation. Raycast doesn't let
extensions move the cursor, so each piece is added at the end and you type the
value after it.

### Mouse mode

The pointer works on the plot alongside the keys, whenever Grapher is open. Drag to pan, or to turn the view in 3D; scroll with two
fingers to pan, and hold Cmd or Option while scrolling, or use a mouse wheel, to
zoom. Trackpad pinches are gesture events, which macOS may not deliver to a
process that only observes, so Cmd and scroll is the zoom that always works. Click an intersection to
highlight it, click a curve to select its line, or click anywhere else to read
the coordinates under the pointer.

Raycast doesn't tell extensions where the plot sits, so run Calibrate Mouse
(Cmd + Shift + M) once and click the plot's top-left and bottom-right corners.
The helper behind this, `packages/extension/swift/mouse-helper.swift`, is built
from source with the extension and only observes the mouse, so it needs no
permissions; Raycast still receives every event too. It acts only when a Raycast
window is on top under the pointer: Raycast opens as a panel that doesn't make it
the active app, so which app is frontmost can't tell. So that scrolling over the
plot can't scroll Raycast's pane instead, the pane shows only the plot, and the
readout and hints are in the window title.

Editing keeps the line in place. Choosing another line saves a valid edit and
leaves a broken or cleared one as it was, so moving around never loses a line.
The plot is 3D when the line you are typing or have selected is 3D.

## Packages

| Package | What it is |
| --- | --- |
| `packages/core` | Language, analyzer, solvers and both renderers. No Raycast, no DOM. |
| `packages/extension` | The Raycast extension. |
| `packages/viewer` | WebGL2 window that draws single graphs and handles the mouse. |

## Getting started

```bash
npm install
npm run build
npm test
```

To poke at the viewer on its own:

```bash
npx esbuild packages/viewer/src/main.ts --bundle --format=esm --outfile=packages/viewer/public/main.js --watch --servedir=packages/viewer/public
```

## Theme

Everything is dressed in Kanagawa Dragon, matching the author's Neovim setup.
The palette lives in `packages/core/src/theme.ts` and both renderers read it
from there.

`themes/kanagawa-dragon.json` is the matching Raycast theme. Raycast will not
load it off disk, so generate its install link and open that:

```bash
node scripts/theme-url.mjs themes/kanagawa-dragon.json
```

## Status

Not yet: implicit solvers for stiff systems and PDEs, complex matrices and
domain colouring, mixed partial derivatives in time, 3D inequalities, integrals
of differential equation solutions, and the window shell for the WebGL viewer. The viewer still only
understands single-graph lines without functions, ranges or conditions.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together.
