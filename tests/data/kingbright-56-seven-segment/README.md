# Kingbright 0.56" seven-segment displays, transcribed and digitised

The sheets `seven-segment-ca`, `-cc`, `-4-ca` and `-4-cc` are modelled on
(`src/schematic/components/seven-segment.ts`) and `tests/sim/seven-segment.test.ts` checks them against.

| Part | Common | Colour (material) | Spec, rev, date |
|---|---|---|---|
| SA56-11EWA / SC56-11EWA | anode / cathode | High Efficiency Red (GaAsP/GaP), 617 nm | DSAP8372 V.1A 03/09/2020 / DSAP6671 V.1A 03/04/2019 |
| SA56-11SRWA / SC56-11SRWA | anode / cathode | Super Bright Red (GaAlAs), 640 nm | DSAP8375 V.1A 03/10/2020 / DSAP4629 V.1A 04/23/2018 |
| SA56-11GWA / SC56-11GWA | anode / cathode | Green (GaP), 568 nm | DSAP8374 V.1A 03/10/2020 / DSAP6672 V.1A 03/04/2019 |
| SA56-11SYKWA / SC56-11SYKWA | anode / cathode | Super Bright Yellow (AlGaInP), 590 nm | DSAM8434 V.3A 03/10/2020 / DSAM8450 V.3A 03/12/2020 |
| SA56-11CGKWA / SC56-11CGKWA | anode / cathode | Green (AlGaInP), 570 nm | DSAM8559 V.3A 03/09/2020 / DSAM8448 V.3A 03/12/2020 |
| CA56-12EWA / CC56-12EWA | anode / cathode, four digits | High Efficiency Red | DSAP8253 V.1A 02/26/2020 / DSAP8261 V.1A 02/26/2020 |
| CA56-12SRWA / CC56-12SRWA | anode / cathode, four digits | Super Bright Red | DSAP8254 V.1A 02/26/2020 / DSAP4626 V.2A 02/26/2020 |

Source: `https://www.kingbrightusa.com/images/catalog/SPEC/<part>.pdf`, fetched 2026-10-14; hashes in
`SHA256SUMS`. The PDFs are not in the repository.

Left out: CA56-12GWA / CC56-12GWA (their sheets are the 2011 layout, DSAA9621 V.10, characteristics
at 20 mA rather than 10 mA) and the four-digit SYKWA / CGKWA, for which Kingbright serves no sheet.
No blue or white part exists in the 0.56" family.

## Files

| File | What | How |
|---|---|---|
| `tables.json` | Spec, revision, date, VF typ/max at 10 mA, IF, IFM, PD, VR, I–V axis labels | `tables.py` over the text layer (pypdf); the fields it could not parse are `NaN`/absent and are not used |
| `curves/<part>.json` | The four graphs on page 3: forward current vs voltage, intensity vs current, derating, intensity vs ambient | `sevenseg.py <pdf> <first V> <V step>`, which uses `../kingbright-l154a4surkqbdzgw/digitise.py` (vector paths, grid fitted from the 0.48 pt grid lines; some sheets draw a graph's leftmost grid line as its frame, recorded as `leftGridLineInFrame`) |
| `fits.jsonl` | The engine's diode (junction drop at 10 mA, emission coefficient, series resistance) fitted to each I–V curve between 0.5 and 20 mA, and the worst miss in volts | `fit.py` (scipy least squares, VT = 25.852 mV as `src/sim/netlist.ts`) |

Read by hand from the page 1 drawings (internal circuit diagrams): single digit a–g, DP on leads
7 6 4 2 1 9 10 5, common on 3 and 8; four digits a–g, DP on 11 7 4 2 1 10 5 3, Dig1–Dig4 commons on
12 9 8 6. Dominant wavelengths are page 2's; the colours drawn are those wavelengths' points on the
CIE 1931 spectral locus (`../kingbright-l154a4surkqbdzgw/cie1931-locus.json` names the dataset).

The worst fits are the GaAsP/GaP red sheets (≤ 16 mV); the GaP green fits an emission coefficient
of 0.6, below the physical 1, because its drawn curve is steeper than a Shockley diode can be: the
fit follows the sheet, and only between 0.5 and 20 mA.
