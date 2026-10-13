# Kingbright L-154A4SURKQBDZGW, transcribed and digitised

The datasheet `rgb-led` is modelled on and `tests/sim/rgb-led.test.ts` checks it against.

| | |
|---|---|
| Part | L-154A4SURKQBDZGW, T-1 3/4 (5 mm) full color LED lamp, common cathode |
| Sheet | DSAF8941 rev. V.10A, JAN/29/2013, 8 pages |
| Source | https://www.kingbright.com/attachments/file/psearch/000/00/watermark00/L-154A4SURKQBDZGW(Ver.10A).pdf |
| sha256 | `249aac9c47b3251d361d30a04b0d875c56068adce361dd5d7f33b8fdd4f21304` |
| Local copy | `datasheets/parts/L-154A4SURKQBDZGW.pdf` in the coursework root, listed in `datasheets/MANIFEST.md` |
| Newer revision | V.12A, JAN/07/2015 (Farnell's copy, sha256 `0cccab56…a015b2`): every table number the same, the curves the same vector paths (`digitise.py` on it differs by ≤ 0.001), plus note 4 and a terms-of-use block |

## Files

| File | What | How it was read |
|---|---|---|
| `datasheet.json` | Every line of the sheet, 98 of them, each with its page, the text as printed and the numbers in SI units | By hand from `pdftotext -layout` (pages 1, 2, 6–8) and from 300–600 dpi renders of the drawings (`pdftoppm`) |
| `curves.json` | Every curve on pages 3–5, as points | `python3 -I digitise.py <pdf> > curves.json` (needs `pikepdf`) |
| `cie1931-locus.json` | The CIE 1931 2° spectral locus at the three dominant wavelengths ±1 nm | From CIE 018:2019 Table 6, `CIE_cc_1931_2deg.csv` (URL and sha256 inside) |

## How each table was read

- **Selection guide** (p. 2): two rows per die. The second, asterisked row is the one the sheet marks
  traceable to CIE127-2007; for blue and green the rows agree, for red they do not (300/700 against
  100/200 mcd). `mcdTraceable` is the asterisked row, `mcd` the other; the model uses the traceable one.
- **Electrical / optical characteristics** and **absolute maximum ratings** (p. 2): read straight
  from the text layer; the columns are Hyper Red, Blue, Green.
- **Package drawing** (p. 1): read off a 400 dpi render. The `what` of each dimension is our reading
  of where the drawing's arrows point; `dimension-lead-kink` (0.7 MAX) is not named on the drawing.
- **Pin-out** (p. 1): the end view numbers the leads 1–4 in a row; the symbol puts SURK on 1, QB-D on
  3, ZG on 4, each diode's cathode on the bus to lead 2, which the side view labels CATHODE and draws
  longest.
- **Pages 6–8** (packing, precautions, the wave-soldering profile): the text as printed. The
  soldering profile's curve is not digitised; nothing in εmul solders.

## How each curve was read (`digitise.py`)

Every graph on pages 3–5 is vector art, so nothing is read from pixels.

1. **Paths.** The content stream of each page is walked with its graphics state (`q`/`Q`/`cm`, line
   width, dash): every `m`/`l`/`re` is taken as drawn, every Bézier (`c`/`v`/`y`) sampled at 16 steps,
   all in page points.
2. **Grid.** The thin (0.28 pt) stroked lines, or the 0.24 pt filled bars of the spectrum, inside a
   graph's box are its grid lines. Their values come from the tick labels printed under and beside
   them (the labels are drawn as strokes, so they were read off the render once and written into
   `digitise.py`). Each axis is a least-squares line through (position, value); a grid line off the
   others by more than 0.1 pt is left out of the fit and listed in `offGridPt`. `residualPt` is the
   worst remaining miss: at most 0.009 pt.
3. **Curves.** The thick (0.85 pt) stroked paths inside the box are the curve; every vertex is a
   point, converted with the two axes. A dashed path (the I–V curves past the DC rating) goes in
   `dashed`. The spectrum's curves are filled quadrilaterals 0.76 pt wide: each one's centre line is
   taken, the pieces are chained where they meet (0.05 pt), the three peaks' gaps (≤ 1 pt, where the
   draftsman capped them) bridged, and the chains named B, G, R by where they peak.
4. **Spatial distribution.** The lobe's lowest vertex is the origin (the rays meet there, at 0°,
   ±10°…±90° to 0.01°); each lobe vertex becomes (angle from the axis, radius over the on-axis
   radius).

`lineWidthPt` and `lineWidth` (the same in the graph's units) are the printed curve's width: the
tolerance the test gives a model point, since a point inside it is on the printed line.

### What the drawing itself does

- The 0 mA axis of the red and green I–V graphs and of all three derating graphs is drawn
  0.53–0.60 pt above where the other grid lines put zero. Calibrated on the evenly spaced lines, the
  points drawn on that axis read 0.31–0.35 mA instead of 0: inside one printed line width (0.5 mA).
- The luminous-intensity-vs-current curves are straight lines through the origin to 1.5 (R, B) and
  1.25 (G) at the DC rating: intensity proportional to current.
- The derating curves are flat at the DC rating to 25 °C, fall to 6.04 (R), 6.14 (B) and 4.85 (G) mA
  at 85 °C (red with a knee at 75.5 °C, 10 mA) and drop vertically to the axis at 85 °C, the end of
  the operating range.
- The spectra peak at 644.4, 459.6 and 515.5 nm (table 645, 460, 515) and are 25.1, 22.3 and 29.9 nm
  wide at half height, where the table says 28, 25 and 30: the drawn red and blue are narrower than
  the table.
- The spatial distribution is the same lobe on all three pages, halving at ±30.0°: 2θ½ = 60°, as
  tabled.
