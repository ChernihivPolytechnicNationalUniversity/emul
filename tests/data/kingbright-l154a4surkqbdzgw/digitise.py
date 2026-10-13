import hashlib
import json
import math
import sys

import re

import pikepdf

THIN_STROKE = 0.5
GRID_TOLERANCE = 0.05
JOIN = 0.05
OFF_GRID = 0.1
PEAK_GAP = 1.0


def multiply(a, b):
    return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]


def transform(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def bezier(p0, p1, p2, p3, steps=16):
    points = []
    for i in range(1, steps + 1):
        t = i / steps
        u = 1 - t
        points.append((
            u ** 3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t ** 3 * p3[0],
            u ** 3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t ** 3 * p3[1],
        ))
    return points


def page_paths(pdf, number):
    page = pdf.pages[number - 1]
    ctm = [1, 0, 0, 1, 0, 0]
    stack = []
    width = 1.0
    dashed = False
    pending = []
    current = None
    painted = []
    for operands, operator in pikepdf.parse_content_stream(page):
        op = str(operator)
        nums = lambda: [float(v) for v in operands]
        if op == "q":
            stack.append((ctm[:], width, dashed))
        elif op == "Q":
            ctm, width, dashed = stack.pop()
        elif op == "cm":
            ctm = multiply(nums(), ctm)
        elif op == "w":
            width = float(operands[0])
        elif op == "d":
            dashed = len(operands[0]) > 0
        elif op == "m":
            current = [transform(ctm, *nums())]
            pending.append(current)
        elif op == "l":
            current.append(transform(ctm, *nums()))
        elif op == "c":
            v = nums()
            current.extend(bezier(current[-1], transform(ctm, v[0], v[1]), transform(ctm, v[2], v[3]), transform(ctm, v[4], v[5])))
        elif op == "v":
            v = nums()
            current.extend(bezier(current[-1], current[-1], transform(ctm, v[0], v[1]), transform(ctm, v[2], v[3])))
        elif op == "y":
            v = nums()
            end = transform(ctm, v[2], v[3])
            current.extend(bezier(current[-1], transform(ctm, v[0], v[1]), end, end))
        elif op == "re":
            x, y, w, h = nums()
            pending.append([transform(ctm, x, y), transform(ctm, x + w, y), transform(ctm, x + w, y + h), transform(ctm, x, y + h), transform(ctm, x, y)])
        elif op == "h" and current:
            current.append(current[0])
        elif op in ("S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"):
            scale = math.hypot(ctm[0], ctm[1])
            for points in pending:
                painted.append({"paint": "stroke" if op in ("S", "s") else "fill", "width": width * scale, "dashed": dashed, "points": points})
            pending = []
            current = None
    return painted


def inside(path, box):
    xs = [p[0] for p in path["points"]]
    ys = [p[1] for p in path["points"]]
    return min(xs) >= box[0] and max(xs) <= box[2] and min(ys) >= box[1] and max(ys) <= box[3]


def extent(path):
    xs = [p[0] for p in path["points"]]
    ys = [p[1] for p in path["points"]]
    return max(xs) - min(xs), max(ys) - min(ys)


def grid_lines(paths, box):
    verticals, horizontals = set(), set()
    for path in paths:
        if not inside(path, box):
            continue
        w, h = extent(path)
        thin_stroke = path["paint"] == "stroke" and 0 < path["width"] < THIN_STROKE and len(path["points"]) == 2
        thin_fill = path["paint"] == "fill" and len(path["points"]) == 5 and min(w, h) < 0.3
        if not (thin_stroke or thin_fill):
            continue
        xs = [p[0] for p in path["points"]]
        ys = [p[1] for p in path["points"]]
        if w < 0.3 and h > 15:
            verticals.add(round((min(xs) + max(xs)) / 2, 2))
        if h < 0.3 and w > 15:
            horizontals.add(round((min(ys) + max(ys)) / 2, 2))
    return merge(sorted(verticals)), merge(sorted(horizontals))


def merge(values):
    merged = []
    for v in values:
        if merged and v - merged[-1] < 0.1:
            continue
        merged.append(v)
    return merged


def linear_fit(positions, values):
    n = len(positions)
    mx = sum(positions) / n
    my = sum(values) / n
    sxx = sum((p - mx) ** 2 for p in positions)
    slope = sum((p - mx) * (v - my) for p, v in zip(positions, values)) / sxx
    offset = my - slope * mx
    worst = max(abs(offset + slope * p - v) for p, v in zip(positions, values))
    return slope, offset, worst


def axis(lines, first, step):
    values = [first + step * i for i in range(len(lines))]
    skip = set()
    while True:
        used = [i for i in range(len(lines)) if i not in skip]
        slope, offset, _ = linear_fit([lines[i] for i in used], [values[i] for i in used])
        misses = {i: abs((values[i] - offset) / slope - lines[i]) for i in used}
        worst = max(misses, key=misses.get)
        if misses[worst] < OFF_GRID or len(used) <= 3:
            break
        skip.add(worst)
    off = {str(i): round((values[i] - offset) / slope - lines[i], 3) for i in sorted(skip)}
    return {"slope": slope, "offset": offset, "lines": lines, "values": values, "residualPt": round(max(misses.values()), 4), "offGridPt": off}


def value(ax, position):
    return ax["offset"] + ax["slope"] * position


def chain(segments):
    parent = list(range(len(segments)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    ends = [(i, p) for i, s in enumerate(segments) for p in s]
    ends.sort(key=lambda e: e[1][0])
    for k, (i, p) in enumerate(ends):
        for j, q in ends[k + 1:]:
            if q[0] - p[0] > JOIN:
                break
            if abs(q[1] - p[1]) <= JOIN:
                parent[find(i)] = find(j)
    groups = {}
    for i, s in enumerate(segments):
        groups.setdefault(find(i), []).extend(s)
    return list(groups.values())


def curve_segments(paths, box, minimum_width=THIN_STROKE):
    solid, dashed = [], []
    for path in paths:
        if not inside(path, box) or path["paint"] != "stroke" or path["width"] < minimum_width:
            continue
        pts = path["points"]
        for a, b in zip(pts, pts[1:]):
            if math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-6:
                (dashed if path["dashed"] else solid).append((a, b))
    return solid, dashed


def knots(segments):
    unique = {}
    for a, b in segments:
        for p in (a, b):
            unique[(round(p[0], 2), round(p[1], 2))] = p
    return list(unique.values())


def cartesian(paths, box, x_axis, y_axis, order):
    lines_x, lines_y = grid_lines(paths, box)
    ax = axis(lines_x, *x_axis)
    ay = axis(lines_y, *y_axis)
    solid, dashed = curve_segments(paths, box)
    width = max(p["width"] for p in paths if inside(p, box) and p["paint"] == "stroke" and p["width"] >= THIN_STROKE)

    def convert(points):
        out = sorted(([value(ax, p[0]), value(ay, p[1])] for p in points), key=order)
        return [[round(x, 4), round(y, 4)] for x, y in out]

    return {
        "grid": {"x": ax, "y": ay},
        "lineWidthPt": round(width, 3),
        "lineWidth": {"x": round(width * abs(ax["slope"]), 5), "y": round(width * abs(ay["slope"]), 5)},
        "points": convert(knots(solid)),
        "dashed": convert(knots(dashed)),
    }


def polar(paths, box):
    lobe = [p for path in paths if inside(path, box) and path["paint"] == "stroke" and path["width"] >= THIN_STROKE for p in path["points"]]
    origin = min(lobe, key=lambda p: p[1])
    rays = []
    for path in paths:
        if not inside(path, box) or path["paint"] != "stroke" or not (0 < path["width"] < THIN_STROKE) or len(path["points"]) != 2:
            continue
        near, far = sorted(path["points"], key=lambda p: math.hypot(p[0] - origin[0], p[1] - origin[1]))
        if math.hypot(near[0] - origin[0], near[1] - origin[1]) < 1 and math.hypot(far[0] - origin[0], far[1] - origin[1]) > 5:
            rays.append(round(math.degrees(math.atan2(far[0] - origin[0], far[1] - origin[1])), 2))
    on_axis = max(math.hypot(p[0] - origin[0], p[1] - origin[1]) for p in lobe if abs(p[0] - origin[0]) < 0.05)
    samples = {}
    for p in lobe:
        r = math.hypot(p[0] - origin[0], p[1] - origin[1])
        if r < 0.3:
            continue
        angle = math.degrees(math.atan2(p[0] - origin[0], p[1] - origin[1]))
        samples[round(angle, 2)] = round(r / on_axis, 4)
    width = max(path["width"] for path in paths if inside(path, box) and path["paint"] == "stroke" and path["width"] >= THIN_STROKE)
    return {
        "originPt": [round(origin[0], 3), round(origin[1], 3)],
        "onAxisRadiusPt": round(on_axis, 3),
        "raysDeg": sorted(set(rays)),
        "lineWidthPt": round(width, 3),
        "lineWidthRelative": round(width / on_axis, 4),
        "points": [[a, samples[a]] for a in sorted(samples)],
    }


def spectrum(paths, box, x_axis, y_axis, names):
    lines_x, lines_y = grid_lines(paths, box)
    ax = axis(lines_x, *x_axis)
    ay = axis(lines_y, *y_axis)
    segments = []
    widths = []
    for path in paths:
        if not inside(path, box) or path["paint"] != "fill" or len(path["points"]) != 4:
            continue
        a, b, c, d = path["points"]
        start = ((a[0] + d[0]) / 2, (a[1] + d[1]) / 2)
        end = ((b[0] + c[0]) / 2, (b[1] + c[1]) / 2)
        widths.append(math.hypot(a[0] - d[0], a[1] - d[1]))
        segments.append((start, end))
    fragments = sorted(chain(segments), key=lambda g: min(p[0] for p in g))
    joined = []
    for fragment in fragments:
        left = min(fragment, key=lambda p: p[0])
        tail = next((c for c in joined if math.hypot(max(c, key=lambda p: p[0])[0] - left[0], max(c, key=lambda p: p[0])[1] - left[1]) <= PEAK_GAP), None)
        if tail is None:
            joined.append(list(fragment))
        else:
            tail.extend(fragment)
    curves = {}
    for name, group in zip(names, sorted(joined, key=lambda g: max(g, key=lambda p: p[1])[0])):
        pts = sorted(([value(ax, p[0]), value(ay, p[1])] for p in group), key=lambda q: q[0])
        curves[name] = [[round(x, 3), round(y, 4)] for x, y in pts]
    width = sorted(widths)[len(widths) // 2]
    return {
        "grid": {"x": ax, "y": ay},
        "lineWidthPt": round(width, 3),
        "lineWidth": {"x": round(width * abs(ax["slope"]), 4), "y": round(width * abs(ay["slope"]), 5)},
        "fragments": len(fragments),
        "curves": curves,
    }


PAGES = {"R": 3, "B": 4, "G": 5}
IV_AXIS = {"R": (1.5, 0.1), "B": (2.0, 0.2), "G": (2.0, 0.25)}
GRAPHS_RAISED_ON_PAGES_4_AND_5 = {"R": 0, "B": 203.0, "G": 203.0}
SPATIAL_BOX = {"R": (250, 110, 345, 215), "B": (250, 300, 345, 412), "G": (250, 300, 345, 412)}
SPECTRUM_BOX = (155, 620, 465, 714)


def boxes(die):
    shift = GRAPHS_RAISED_ON_PAGES_4_AND_5[die]
    return {
        "forwardVoltage": (150, 400 + shift, 255, 497 + shift),
        "luminousIntensityVsCurrent": (330, 400 + shift, 440, 497 + shift),
        "derating": (150, 235 + shift, 255, 340 + shift),
        "luminousIntensityVsTemperature": (330, 235 + shift, 465, 340 + shift),
        "spatialDistribution": SPATIAL_BOX[die],
    }


def digitise(path):
    pdf = pikepdf.open(path)
    out = {"source": path.rsplit("/", 1)[-1], "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(), "dies": {}}
    page3 = page_paths(pdf, 3)
    out["spectrum"] = spectrum(page3, SPECTRUM_BOX, (400, 50), (0, 0.5), ["B", "G", "R"])
    for die, number in PAGES.items():
        paths = page3 if number == 3 else page_paths(pdf, number)
        box = boxes(die)
        first, step = IV_AXIS[die]
        out["dies"][die] = {
            "page": number,
            "forwardVoltage": cartesian(paths, box["forwardVoltage"], (first, step), (0, 5), lambda q: (q[0], q[1])),
            "luminousIntensityVsCurrent": cartesian(paths, box["luminousIntensityVsCurrent"], (0, 5), (0, 0.25), lambda q: (q[0], q[1])),
            "derating": cartesian(paths, box["derating"], (0, 10), (0, 10), lambda q: (q[0], -q[1])),
            "luminousIntensityVsTemperature": cartesian(paths, box["luminousIntensityVsTemperature"], (-40, 10), (0, 0.5), lambda q: (q[0], q[1])),
            "spatialDistribution": polar(paths, box["spatialDistribution"]),
        }
    return out


NUMBER_LIST = re.compile(r"\[\s*(?:-?[\d.e+-]+\s*,\s*)*-?[\d.e+-]+\s*\]")


def number_lists_on_one_line(text):
    return NUMBER_LIST.sub(lambda m: "[" + ", ".join(v.strip() for v in m.group(0)[1:-1].split(",")) + "]", text)


if __name__ == "__main__":
    sys.stdout.write(number_lists_on_one_line(json.dumps(digitise(sys.argv[1]), indent=1)) + "\n")
