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
| `f(x) = x^3 - a x` | function; a function of x also plots itself |
| `y = f'(x)` or `y = d/dx sin(x^2)` | exact derivative |
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

- **Sliders.** A name nothing defines evaluates as 1, and becomes a slider line when you add the equation.
- **Time.** In a differential equation, the variable you differentiate by is time and sits on the horizontal axis.
- **Starting values.** `p0 = 5` in a condition list means `p(0) = 5`. Several values for the same order give several solution curves.
- **Names with subscripts.** `p_0` is an ordinary name. `u_t` and `u_xx` are derivatives when u is clearly an unknown, for example because it has conditions.
- **PDEs.** One space variable, time called `t` or listed second in braces, up to second order in time and fourth in space. Boundaries without a condition have zero slope.

## Keys

| Keys | Action |
| --- | --- |
| Enter | Add the typed line |
| Cmd + arrows | Move the 2D plot, or rotate and tilt the 3D one |
| Cmd + = and Cmd + - | Zoom |
| Cmd + 0 | Reset the view |
| Cmd + Shift + 0 | Zoom to the line's own ranges |
| Cmd + ] and Cmd + [ | Step the current slider |
| Cmd + Shift + ] and Cmd + Shift + [ | Switch which slider steps |
| Cmd + U and Cmd + L | Next and previous intersection |
| Cmd + P | Play a solution over time, or pause |
| Cmd + Shift + P | Show the whole solution again |
| Cmd + Shift + H | Hide or show a line |
| Ctrl + X | Remove a line |

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

Not yet: systems of differential equations, mixed partial derivatives, 3D
inequalities, and the window shell for the WebGL viewer. The viewer still only
understands single-graph lines without functions, ranges or conditions.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it fits together.
