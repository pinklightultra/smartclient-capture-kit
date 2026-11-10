# Mark up the figure

`npm run annotate` runs `node annotate.js`. Pass the same flags after `npm run annotate --`.

The image in the doc is the capture cropped to the panel, with a box on the control and a numbered bubble.

```bash
node annotate.js --in screenshots/staging/users.png --out doc/users.png \
  --crop 0,56,1440,844 --highlight 120,200,300,48 --callout '270,190,1'
```

`--highlight`, `--arrow`, and `--callout` repeat. Boxes draw first, then arrows, then callouts. Colours, stroke, and type size come from the `annotate` block. `--accent` and `--font-size` override one run.

Every coordinate is measured after `--crop`. The crop is applied first, and every mark is relative to that frame's top-left. `--describe` prints the frame and writes nothing:

```bash
node annotate.js --in screenshots/staging/users.png --crop 0,56,1440,844 --describe
```

```text
<file> is <source width>x<source height>
after --crop you are working in <width>x<height>, origin at the crop's top-left
```

A capture at the shipped viewport is 1440 by 900. The shipped crop is 1440 by 844 at (0, 56). Passing that crop to `--describe` prints a working frame of 1440 by 844. Those numbers are `viewport` and `capture.crop` in `capture.config.json`.

`--focus x,y,w,h` blurs the pixels outside the box so the eye lands inside it. Publish a figure only after `safeShot()` has already covered the sensitive regions. A blur on a finished file covers whatever happened to be in the crop, can be partly reversed, and leaves the source PNG as it was. The smoke test asserts that the pixels inside the focus box stay byte-identical to the source.

A mark that falls outside the frame exits `1` and writes no file. SVG and sharp both clip without an error, so an off-image highlight used to produce an annotated PNG with no box on it. A callout whose point has no room above is drawn below the point. One near a side edge is shifted inward so the bubble stays on the canvas. The smoke test checks both by differencing the output against the unmarked image and measuring where the ink landed, on a 400 by 300 fixture. Bubble width is a per-character estimate, rounded up. Measuring the text would need a font this module does not load, so the bubble runs slightly wide of its text.

`annotate.js` draws on the capture. It does not change the text in a control. The figure is a record of what the application showed. Refusing to overwrite the source is tested: annotating a file onto itself throws `AnnotateError`.
