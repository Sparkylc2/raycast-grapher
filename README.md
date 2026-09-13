# raycast-grapher

Plot 2D and 3D equations, explicit or implicit, driven from Raycast.

Type `y = sin(x)`, `x^2 + y^2 = 9`, `3x + 5 = 7`, or `z = sin(x) cos(y)` into
Raycast and open it in an interactive window you can pan, zoom, and orbit.

## Packages

| Package | What it is |
| --- | --- |
| `packages/core` | Parser, classifier, and the JS and GLSL compilers. No I/O, no DOM. |
| `packages/viewer` | WebGL2 window that draws the graph and handles the mouse. |
| `packages/extension` | The Raycast extension. |

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

Working: expression language, classification, both compilers, the full 2D
renderer with pan and zoom, and a Raycast command where equations sit in a
sidebar and the plot beside them redraws as you type. Pan and zoom ease into
place under a configurable frame-rate cap, and tick labels are set in SF Pro.

Not yet: 3D rendering, the viewer window shell, and parameter sliders.

See [ARCHITECTURE.md](ARCHITECTURE.md) for why it is split this way.
