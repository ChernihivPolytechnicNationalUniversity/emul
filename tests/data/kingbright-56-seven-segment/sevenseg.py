"""Digitise page 3 of a Kingbright 0.56" seven-segment sheet: I-V, intensity vs current, derating, intensity vs temperature."""
import hashlib, json, sys
sys.path.insert(0, __import__("os").path.join(__import__("os").path.dirname(__file__), "..", "kingbright-l154a4surkqbdzgw"))
import digitise as d
import pikepdf

TOP, BOTTOM = 383, 477
BOXES = {
    "forwardVoltage": ((54, TOP, 155, BOTTOM), None),
    "luminousIntensityVsCurrent": ((198, TOP, 297, BOTTOM), (0, 4)),
    "derating": ((335, TOP, 436, BOTTOM), (-40, 20)),
    "luminousIntensityVsTemperature": ((479, TOP, 577, BOTTOM), (-40, 20)),
}
Y = {"forwardVoltage": (0, 4), "luminousIntensityVsCurrent": (0, 0.5), "derating": (0, 10), "luminousIntensityVsTemperature": (0, 0.5)}

GRID_WIDTH = 0.48


def graph_boxes(paths):
    """The four graphs' boxes from their 0.48 pt grid lines: six horizontals, then 6, 6, 8, 8 verticals left to right."""
    thin = [p for p in paths if p["paint"] == "stroke" and 0 < p["width"] < 0.5 and len(p["points"]) == 2]
    anchors = [p["points"][0][1] for p in thin if abs(p["width"] - GRID_WIDTH) < 0.01 and abs(p["points"][0][1] - p["points"][1][1]) < 0.1]
    low, high = min(anchors) - 25, max(anchors) + 25
    band = [p for p in thin if all(low <= q[1] <= high for q in p["points"])]
    hs = sorted({round(p["points"][0][1], 1) for p in band if abs(p["points"][0][1] - p["points"][1][1]) < 0.1 and abs(p["points"][0][0] - p["points"][1][0]) > 15})
    vs = sorted({round(p["points"][0][0], 1) for p in band if abs(p["points"][0][0] - p["points"][1][0]) < 0.1 and abs(p["points"][0][1] - p["points"][1][1]) > 15})
    vs = [v for i, v in enumerate(vs) if i == 0 or v - vs[i - 1] > 0.5]
    hs = [h for i, h in enumerate(hs) if i == 0 or h - hs[i - 1] > 0.5]
    assert len(hs) == 6, hs
    top, bottom = hs[0] - 3, hs[-1] + 3
    groups = [[vs[0]]]
    for v in vs[1:]:
        if v - groups[-1][-1] > 30:
            groups.append([v])
        else:
            groups[-1].append(v)
    assert len(groups) == 4, vs
    # Some sheets draw a graph's leftmost grid line as part of its frame, not as a grid line:
    # the box then starts a spacing further left and the axis one step further on.
    boxes = []
    for g, full in zip(groups, (6, 6, 8, 8)):
        missing = full - len(g)
        assert missing in (0, 1), g
        spacing = (g[-1] - g[0]) / (len(g) - 1)
        boxes.append(((g[0] - missing * spacing - 2, top, g[-1] + 2, bottom), missing))
    return boxes


def run(path, iv_axis):
    pdf = pikepdf.open(path)
    paths = d.page_paths(pdf, 3)
    found = graph_boxes(paths)
    out_missing = {}
    for (name, (_, xaxis)), (box, missing) in zip(list(BOXES.items()), found):
        axis_ = xaxis or iv_axis
        BOXES[name] = (box, (axis_[0] + missing * axis_[1], axis_[1]))
        out_missing[name] = missing
    out = {"source": path.rsplit("/", 1)[-1], "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest()}
    for name, (box, xaxis) in BOXES.items():
        order = (lambda q: (q[0], -q[1])) if name == "derating" else (lambda q: (q[0], q[1]))
        out[name] = d.cartesian(paths, box, xaxis, Y[name], order)
        out[name]["leftGridLineInFrame"] = bool(out_missing[name])
    return out

if __name__ == "__main__":
    first, step = float(sys.argv[2]), float(sys.argv[3])
    sys.stdout.write(d.number_lists_on_one_line(json.dumps(run(sys.argv[1], (first, step)), indent=1)) + "\n")
