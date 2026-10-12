# Filter API

Every tool in the browser app is a **filter**: a function from one image (plus optionally other frames)
to one image. Filters are chained in the History panel; each step runs on the output of the step above it.

Filter files are classic scripts (no modules) in `js/filters/`. They are loaded in three places:

| Where | Why |
|---|---|
| Main thread | Metadata only: names, categories, parameter definitions, defaults, sample registrations |
| Engine worker (`js/worker.js`) | Runs the chain: calls `apply` / `gpu` |
| Pool workers (`js/pool.js`) | Run `apply` on horizontal strips for filters that declare `margin` |

So a filter file must not touch `document`/`window` at load time, and `apply` must not use DOM APIs.
Use `AD.img`, `AD.fft`, `AD.geom` and `AD.gpu` (see `js/lib/`). `OffscreenCanvas` is allowed.

## Registering

```js
AD.registerFilter({
  id: 'levels',                    // unique, kebab-case, stable (saved in project files)
  name: 'Levels',                  // shown in the Filters panel and History
  category: 'Adjust',              // one of AD.CATEGORIES (below)
  description: 'Map input black/white points to the full range, with gamma.',
  keywords: ['contrast', 'stretch'],   // optional, for the filter search box
  params: [ /* see Parameters */ ],
  actions: [ /* optional, see Actions */ ],

  // Required. CPU implementation. May be async. Must not mutate `input`.
  apply(input, p, ctx) { return outImageData; },

  // Optional. GPU implementation. When WebGL2 is available the engine times both paths once per filter and
  // keeps using the faster one. Must produce the same result as `apply` (within 8-bit rounding).
  gpu(input, p, ctx) { return outImageData; },

  // Optional. Local operator: output pixel (x, y) depends only on input within `margin` pixels of it,
  // output size equals input size, the filter does not read other frames, and it returns a plain ImageData
  // (strip workers return pixels only, so readout/overlay would be lost — don't declare margin if you return them).
  // Return NaN to disable striping for particular parameter values.
  // The engine then splits large images into horizontal strips (with `margin` overlap) across a worker pool.
  margin: (p, ctx) => 2 * p.radius,

  // Optional, for filters that change the number of frames (Select Frames, field split, ...).
  frameCount: (inputCount, p) => Math.ceil(inputCount / p.step),

  // Optional: true if apply() reads frames other than ctx.frameIndex via ctx.input(i).
  temporal: false,

  // Optional: id of the sample the smoke test should run this filter on (see Samples).
  testSample: 'motion-blur',
});
```

`AD.CATEGORIES`: `Select Frames`, `Interlace`, `Edit`, `Channels`, `Adjust`, `Sharpen`, `Denoise`,
`Deblurring`, `Stabilization`, `Integrate`, `Extract`, `Verify`, `Measure`, `Presentation`.

### Return value

Either an `ImageData`, or an object:

```js
{
  image: ImageData,                       // required
  overlay: [ /* shapes, output pixel coords, see Overlays */ ],
  readout: { 'Mean saturation': '0.046', 'Peak': '1.45 % at 0:05' },   // strings or numbers
}
```

Always return a **new** ImageData (alpha 255) — never the input object itself, never mutated input.
Returning `AD.img.clone(input)` is fine for analysis-only filters.

## Parameters

Values live in `p` keyed by `id`. `default` may be a value or a function `(input, info) => value`
where `input` is `{width, height}` of this step's input and `info` is `{frameCount, fps}`.
Optional on any parameter: `when: p => boolean` (hide unless true), `hint: 'text'`.

| type | fields | value |
|---|---|---|
| `range` | `min`, `max`, `step`, `unit?` | number. `max: 'lastFrame'` = input frame count − 1. `unit: 'px'` = a size in pixels (see Preview scale) |
| `number` | `min?`, `max?`, `step?`, `unit?` | number, typed in a box |
| `select` | `options: [{value, label}]` | the selected `value` |
| `bool` | | boolean |
| `text` | | string |
| `color` | | `'#rrggbb'` |
| `points` | `count` or `min`/`max`, `labels?`, `shape?: 'points'|'polygon'|'polyline'|'segments'`, `space?: 'input'|'output'` | `[{x, y}, ...]` in pixel coords of this step's input (or output if `space: 'output'`) |
| `rect` | `space?` | `{x, y, w, h}` |

`points` and `rect` are edited on the image with the Edit points tool. `shape: 'segments'` pairs points
(0-1, 2-3, ...) into line segments, e.g. for measurement. With `min`/`max` instead of `count`, a click on empty
image adds a point and a double-click on a point removes it.

## Preview scale

While the user drags sliders or plays video, the engine runs the chain on a downscaled copy of the source
(`ctx.scale` < 1), then re-renders at full resolution (`ctx.scale === 1`) when idle. Exports always use 1.

The engine pre-scales parameters before calling the filter, so filters work in their input's pixel units:
`points` and `rect` values, and `range`/`number` params with `unit: 'px'`, are multiplied by `ctx.scale`.
Anything else in pixel units that the engine cannot know about must be scaled by the filter itself.
Measurement filters that report pixel lengths should divide by `ctx.scale` to report full-resolution pixels.

## Context (`ctx`)

| member | |
|---|---|
| `frameIndex`, `frameCount` | this step's output frame index and count |
| `inputFrameCount`, `fps` | |
| `scale` | preview scale, see above |
| `input(i)` | `Promise<ImageData>`: this step's input at frame `i` (clamped to range). Set `temporal: true` when you use it |
| `original(i)` | `Promise<ImageData>`: the source frame `i`, before any filter |
| `memo(key, fn)` | `Promise`: `fn()` runs once per (step parameters, upstream chain, key); cached across frames. Use for reference templates, OTFs, tracking results |
| `checkpoint()` | `Promise`: yields so cancellation and messages can run; throws if this render was cancelled. Call every ~20 ms of work in long loops |
| `progress(fraction, label?)` | report progress for long work |
| `log(msg, level?)` | write to the Log panel |

## Actions

Buttons in the parameter panel that compute parameter values, e.g. "Detect peaks":

```js
actions: [{ id: 'detect', label: 'Detect peaks', run: async (input, p, ctx) => ({ notches: [...] }) }]
```

`run` gets the step's input at the current frame and returns a patch merged into the params.

## Overlays

Shapes drawn over the displayed output, in output pixel coordinates. `color` is `'accent'`, `'hit'`, `'warn'`
or any CSS color; default `'accent'`.

```js
{ type: 'line', x1, y1, x2, y2, label?, color?, dash? }
{ type: 'poly', points: [{x, y}], closed?, label?, color? }
{ type: 'rect', x, y, w, h, label?, color? }
{ type: 'circle', x, y, r, label?, color? }
{ type: 'text', x, y, text, color? }
```

## Samples

A filter file may register synthetic test material for its tools (runs on the main thread only):

```js
AD.registerSample({ id: 'motion-blur', name: 'Motion-blurred sign', category: 'Deblurring',
  make: async () => imageData /* or { frames: [ImageData...], fps } */ });
```

`make` may use `document.createElement('canvas')`. Guard it so the file still loads in workers:
call `AD.registerSample` only when `typeof document !== 'undefined'`.

## GPU helper (`AD.gpu`)

WebGL2 on an OffscreenCanvas, available on the main thread and in workers when the browser supports it.

```js
if (AD.gpu.available) {
  const out = AD.gpu.run(`
    vec4 fx(vec2 uv) { vec4 c = texture(u_img, uv); return vec4(pow(c.rgb, vec3(u_gamma)), 1.0); }`,
    { image: input, uniforms: { u_gamma: 1 / p.gamma } });
}
```

`AD.gpu.run(snippet, { image, width?, height?, uniforms?, textures? })`: `snippet` defines
`vec4 fx(vec2 uv)` returning the output colour (0..1) for normalised output coordinate `uv`. Available:
`u_img` (input, linear filtering, clamp to edge), `u_size` (input size in px), `u_out` (output size in px),
plus your uniforms (number → float, `[a,b]` → vec2, `[a,b,c]` → vec3, `[..9]` → mat3, `{int: n}` → int)
and extra textures (`textures: { u_lut: imageData }`). Output is 8-bit RGBA ImageData.

## Testing

`node --test test/unit/` runs the unit tests (Node built-in test runner, `node:test` + `node:assert`). `test/env.mjs` loads the libs and filter files
into a Node context with an `ImageData` polyfill and gives you `makeCtx({ frames, frameIndex, scale })`.
`node test/smoke.mjs [--only=id,id]` loads the real page in headless Chromium, adds each filter to a matching
sample and checks it runs without errors in reasonable time.
