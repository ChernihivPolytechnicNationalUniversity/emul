"""Fit the engine's diode (junction drop at 10 mA, emission n, series R) to a digitised I-V curve."""
import json, sys
import numpy as np
from scipy.optimize import least_squares
VT = 0.025852
def volts(p, i):
    vj, n, rs = p
    isat = 0.01 / np.expm1(vj / (n * VT))
    return n * VT * np.log1p(i / isat) + i * rs
for f in sys.argv[1:]:
    pts = np.array(json.load(open(f))["forwardVoltage"]["points"])
    pts = pts[pts[:, 1] > 0.5]
    v, i = pts[:, 0], pts[:, 1] / 1000
    r = least_squares(lambda p: volts(p, i) - v, [1.8, 2.0, 5.0], bounds=([0.5, 0.5, 0], [4, 10, 100]))
    worst = np.max(np.abs(r.fun))
    print(json.dumps({"file": f.rsplit("/", 1)[-1], "junctionVoltsAt10mA": round(r.x[0], 4), "emission": round(r.x[1], 3), "seriesOhms": round(r.x[2], 3), "worstMissV": round(float(worst), 4), "points": len(v)}))
