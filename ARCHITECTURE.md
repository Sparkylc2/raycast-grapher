# Architecture

## The constraint that shapes everything

Raycast extensions render a fixed set of native components: `List`, `Grid`,
`Form`, `Detail`, `MenuBarExtra`. There is no canvas and no webview, and the
absence is deliberate rather than an oversight, so it will not be lifted by a
version bump. A mouse-draggable, orbitable graph cannot live inside the Raycast
panel.

### What the panel can and cannot do

| Capability | Available |
| --- | --- |
| Keyboard shortcuts, including arrow keys with a modifier | Yes |
| Selecting or activating a list or grid item | Yes |
| Images in `Detail` markdown, from an absolute path | Yes |
| Monospace text, inside a fenced code block | Yes |
| LaTeX in `Detail` markdown | Yes |
| Pointer position, drag, scroll wheel, hover | No |
| Fonts, colors, CSS, or any styling control | No |
| Canvas or webview | No |

There is no pointer API of any kind, so panning by drag cannot be approximated;
the closest equivalent is a modifier plus arrow keys nudging the camera and
re-rendering. Images do work, which makes a real rasterised preview possible,
but Raycast caches them by filename, so each frame needs a fresh name.

So the project is two surfaces over one engine:

| Surface | Role | Interaction |
| --- | --- | --- |
| Raycast panel | Type expressions, manage the list, jump to a saved graph | Keyboard |
| Viewer window | Pan, zoom, orbit, 60 fps | Mouse and keyboard |

`packages/extension/src/viewer-link.ts` is the only file that knows which window
hosts the viewer. The viewer itself is a plain WebGL2 page, so it runs unchanged
in a browser tab, a Tauri window, or a `WKWebView`.

## One parse, many backends

An expression is tokenised and parsed exactly once into an AST. Everything
downstream is a backend over that tree:

- `compile-js.ts` builds a JavaScript closure, used for CPU sampling, root
  finding, and the still images Raycast can show inline.
- `compile-glsl.ts` emits a GLSL ES 3.00 expression, used by the viewer.

Adding a function means one entry in `builtins.ts`, which carries its JS and
GLSL spellings side by side so the two backends cannot drift.

## A document, not a list of expressions

`document.ts` analyses every line together, because a line's meaning depends on
the others. `f(3)` is a call if some line defines `f(x) = ...` and f times 3
otherwise; `a` is a slider if a line says `a = 2`; `dp/dq` is an unknown only
when nothing defines p. So analysis runs in three passes:

1. **Parse.** `parser.ts` records what was written: statements, `[...]` ranges,
   `[...]` conditions and `{...}` axes. It never decides meaning.
2. **Collect definitions.** `name(args) = body` defines a function and
   `name = expression` defines a constant, a slider when the right side is a
   number. Duplicates and cycles become errors on every line involved.
3. **Resolve and classify.** Functions are expanded, derivatives worked out, and
   each remaining line becomes a curve, region, parametric plot, point, surface,
   differential equation or PDE.

Names nothing defines evaluate as 1 and are reported, so a half-written
document still draws and the extension can offer those names as sliders.
Compiled functions read every such name from a parameter object passed on each
call, so moving a slider re-runs analysis but reuses the compiled code.

| Input | Becomes |
| --- | --- |
| `y = sin(x)` | explicit curve |
| `x^2 + y^2 = 9`, `3x + 5 = 7` | implicit curve |
| `y < 0.3 x^2 - 4` | shaded region |
| `(cos t, sin t)`, `(1, 2)` | parametric curve, point |
| `z = sin(x) cos(y)`, `x^2 + y^2 + z^2 = 4` | surface, implicit surface |
| `y' = y [y(0) = 1]` | ordinary differential equation |
| `u_t = u_xx [u(x, 0) = sin(x)]` | partial differential equation |

Axes in braces rename the coordinates, so `{q, p}` plots p against q. Ranges map
to the axes in the same order, except for parametric plots, where they bound
the parameters instead.

## Exact derivatives

`symbolic.ts` differentiates on the tree, with simplifying constructors that
fold constants and drop zero and unit terms as the result is built. `f'(x)`,
`d/dx`, `d^2/dx^2` and primed built-ins all resolve before compiling, so a
derivative plots as exactly as the function does, at any zoom. A test checks
every built-in against finite differences.

The same machinery answers a question the solvers need: whether an equation is
linear in its highest derivative. It is when the second derivative with respect
to that derivative simplifies to zero.

## Differential equations

An ODE is kept in the implicit form F(t, y, y', ..., y⁽ⁿ⁾) = 0 and never
rearranged. At each RK4 stage `ode.ts` solves for the highest derivative: in
closed form when F is linear in it, otherwise by Newton's method seeded from
the previous step, which keeps a solution on one branch. When Newton fails it
scans for every real root and takes the nearest. First-order equations also
draw a slope field, with every real slope at each grid point, so an equation
like `(y')^2 = x^2 + y^2` shows both branches.

Solutions integrate backward and forward from wherever the starting values were
given, and stop cleanly where they blow up or leave the real numbers. Tests
compare against e^t, sin t and an equation that has no explicit form.

`pde.ts` handles one space variable evolving in time: central differences in
space and RK4 in time, the method of lines. The time step comes from probing
how strongly the solved time derivative responds to each spatial derivative,
which is the diffusion, advection, dispersion or wave-speed coefficient that sets
RK4's stability limit. When the step would need too many iterations the grid
coarsens instead. Tests compare the heat and wave equations against their exact
solutions to within 0.002.

## Intersections

`intersect.ts` reduces every visible curve to segments about two pixels long,
using marching squares for implicit curves, and intersects pairs of curves
through a spatial hash. A crossing between two curves that both have a field is
then polished with Newton's method, so a line meeting a circle reports √2 to
nine decimal places. Parametric curves and solution curves have no field and
stay at segment precision. Crossings are computed once the view settles and
reused until it moves.

## Why the 2D renderer has no polylines

Explicit and implicit curves share a single fragment shader, because `y = f(x)`
is just the zero set of `y - f(x)`. The curve is located by dividing the field
value by its screen-space gradient, which yields the distance to the zero set in
pixels:

```glsl
float d = abs(v) / length(vec2(dFdx(v), dFdy(v)));
```

That gives a constant, antialiased line width at any zoom level, with no
sampling, no adaptive subdivision, and no asymptote special-casing. The CPU
sampler in `compile-js.ts` exists for the still-image path, not for the
interactive one.

## 3D in the panel

`mesh.ts` turns surfaces into triangles once per equation: grids for height
fields, parametric surfaces and PDE solutions, and marching tetrahedra for
implicit surfaces, chosen over marching cubes because it needs no case table
and has no ambiguous cases. Implicit normals come from the field's gradient, so
shading follows the true surface rather than the facets.

`render3d.ts` scales the plotting box onto a cube, so a surface spanning
[-5, 5] by [0, 1] stays readable, then fills triangles with a depth buffer and
two-sided lighting. The box, curves and points are depth-tested against the
surfaces. Orbiting only re-projects the cached mesh, which is what makes
keyboard rotation cheap enough to animate: a draft mesh is used while moving
and a finer one once the view settles.

| Scene, 2x frame | Mesh | Draw |
| --- | --- | --- |
| `z = sin(x) cos(y)`, 18,000 triangles | 4 ms | 37 ms |
| implicit surface, 24,000 triangles | 51 ms | 32 ms |

Boxes derived from the data widen to round numbers so ticks land on the
corners, and an implicit surface with no ranges shrinks its box to the surface
it found.

## Painted plots in the panel

The command is a `List` with its detail pane open. Equations run down the
left, the plot fills the right, and the search bar is the equation input, so
the plot redraws on every keystroke with no navigation in between. Filtering is
switched off, otherwise typing would hide the saved equations.

`render.ts` rasterises to RGBA on the CPU and `png.ts` encodes it. Curves are
found exactly as the shader finds them, dividing the field value by its
gradient to get a pixel distance. Frames have a transparent ground so the
Raycast background shows through, and every size in the renderer is given in
display pixels and scaled by a pixel ratio, so a 1x and a 2x frame of the same
view differ only in sharpness.

### Motion

Pan and zoom set a target view, and the plot eases toward it with an 80 ms time
constant. Easing runs on elapsed time rather than frame count, so the pace is
the same at any frame rate. The arrow keys move the plot the way they point, as
if dragging it.

Frames are capped by the Animation Frame Rate preference, 30 per second by
default. The cap is measured from the last frame actually drawn, so key repeat
retargeting the view many times a second cannot push frames closer together.
Frames drawn while moving are 1x with fast compression; once the view settles, a
2x frame at normal compression replaces the last draft.

| Frame | Scene | Cost | Ceiling |
| --- | --- | --- | --- |
| Moving, 1x | three explicit curves | 2 ms | 600 fps |
| Moving, 1x | curve, circle and line | 8 ms | 125 fps |
| Settled, 2x | curve, circle and line | 33 ms | 31 fps |

Those are the extension's own costs, well inside the cap.

Two things keep drafts cheap. Explicit curves evaluate `f(x)` once per column
and touch only the rows near the curve, where the general path samples every
pixel, and a test holds both paths to the same output. Compiled functions are
cached per graph object and parsed graphs per source string, so V8 keeps its
optimised code across frames instead of recompiling for each one.

### Tick labels

Labels are set in SF Pro, read at runtime from the system font directory
because Apple's licence does not permit bundling it. Negative numbers use the
true minus sign.

`truetype.ts` reads the font itself rather than going through a font library.
Raycast caps each command's JavaScript heap at 100 MB, and SF's file is 8.3 MB,
7.2 MB of it variation data for every weight and width. A general parser turns
that into objects and exceeded the cap before drawing a single frame. Labels
need a dozen glyphs at one weight, so only the outline, metric and character
map tables are read from disk, a few hundred kilobytes, and the variation and
layout tables are never touched. Glyphs therefore come out at SF's default
Regular weight.

`typeface.ts` fills the outlines by signed-area accumulation, the method
font-rs uses, and caches each glyph bitmap per size. Loading the font now takes
under a millisecond and about a megabyte of heap, and a test holds that line.

### Why frames are inline images

Raycast draws a markdown image down one of two paths. Anything that is not an
`http`, `https` or `data:` URL counts as an extension asset, and assets go
through a component that supports `@dark` variants. On every change it hides
the image, tries `name@dark.png`, falls back to the real file when that fails,
and fades it in once loaded. For a still image that is invisible. During
animation it blanked every frame, which read as flashing, and lowering the
frame rate would only have made the flashes less frequent.

Frames are therefore PNG data URIs, which Raycast hands straight to a plain
image element. A draft is 25 to 40 KB of base64. So a list of equations does not
multiply that per frame, only the selected item carries the image while the
view moves; once still, every item does, so changing selection never lands on
an empty pane. A test replays Raycast's own handling of the image link to keep
it on the plain path.

This replaced frame files in the temp directory, along with pacing that waited
for Raycast to read each file. That pacing measured the asset path, so it went
with it.

## Text-mode plots

`raster.ts` renders a scene on the CPU to a boolean dot grid, then packs it into
Braille glyphs. Each glyph holds a 2x4 dot cell, so a fenced code block reaches
four times the vertical resolution its character grid would suggest. Curves are
traced by sign change against the right and lower neighbour, which needs no
gradient and handles vertical lines and closed curves alike.

This is the fallback for the Raycast panel when a pre-rendered image is not
wanted. The same dot grid feeds a PNG encoder for the higher-quality path.

## Theming

`theme.ts` holds the palette and both renderers read from it. Colour is the
second thing that drifted between the GPU and CPU paths after gridline spacing,
so it lives in exactly one place and each surface converts as needed: hex for
the viewer's CSS, unit floats for shader uniforms, 0-255 channels for the
rasteriser.

Roles follow the author's Neovim config rather than being invented. Gridlines
take the `LineNr` grey, axis and tick labels take `dragonGray`, and the series
order follows the lualine mode accents with blue first. A test asserts the
Raycast theme file in `themes/` still agrees with this palette.

The one colour not drawn from that config is `purple`. Raycast wants seven
distinct accents and the config exposes only `magenta`, so `purple` takes
`dragonViolet` from upstream Kanagawa Dragon.

Raycast does not read theme files from disk. Custom themes arrive through a
themes.ray.so link, whose format mirrors the serialiser inside Raycast 2.3:
twelve colours in a fixed order, plus an `addToRaycast` flag.
`scripts/theme-url.mjs` generates it from the JSON.

Two Raycast 2 behaviours shape the values. Theme Studio labels `background`
and `backgroundSecondary` as the start and end of a gradient, so both are set
to the same colour to keep the window solid. `selection` is applied as tints
between 5 and 60 percent, which is why the bundled dark theme uses white, so it
takes `dragonWhite` rather than a dark surface colour that would vanish.

No theme value controls the Liquid Glass material. Raycast only switches to an
opaque window when macOS reports Reduce Transparency, under System Settings,
Accessibility, Display, and that setting applies to every app.

## State handoff

`Scene` in `packages/core/src/scene.ts` is the shared document. Raycast owns the
expression list and writes it to `environment.supportPath`; the viewer owns the
cameras and writes them back. "Open in viewer" and "show me a still" are then
the same state seen two ways.

## Open questions

1. **Which window hosts the viewer.** A detached local server plus the default
   browser ships today with no extra binary. A Tauri or Swift `WKWebView` shell
   feels like an app and survives independently, at the cost of a build step and
   a signed binary.
2. **Teaching the viewer the document language.** It still classifies lines
   one at a time, so functions, sliders, ranges and differential equations only
   draw in Raycast.
3. **Systems of equations.** Coupled ODEs such as predator-prey models need
   more than one unknown per line, which the analyzer currently rejects.
