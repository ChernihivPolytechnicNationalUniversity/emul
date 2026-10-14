"""Read the sheet's tables from its text layer: header, selection guide, characteristics, absolute maxima, I-V axis."""
import json, re, sys
from pypdf import PdfReader
def num(s): return float(s)
out = {}
for path in sys.argv[1:]:
    r = PdfReader(path)
    t = [p.extract_text() for p in r.pages]
    pn = path.rsplit("/", 1)[-1][:-4]
    head = re.search(r"Spec No:\s*(\S+)\s*/\s*\S+\s*Rev No:\s*(\S+)\s*Date:\s*(\S+)", t[0])
    p2 = t[1]
    class Miss:
        def group(self, *_): return "nan"
        def groups(self): return ("nan", "nan")
    g = lambda pat: re.search(pat, p2, re.S) or Miss()
    m = {
        "spec": head.group(1), "rev": head.group(2), "date": head.group(3), "pages": len(t),
        "PD_mW": num(g(r"Power Dissipation\s*PD\s*([\d.]+)").group(1)),
        "VR_V": num(g(r"Reverse Voltage\s*VR\s*([\d.]+)").group(1)),
        "IF_mA": num(g(r"DC Forward Current\s*IF\s*([\d.]+)").group(1)),
        "IFM_mA": num(g(r"Peak Forward Current\s*IFM\s*(?:\[1\])?\s*([\d.]+)").group(1)),
        "Tj_C": num(g(r"Junction Temperature\s*Tj\s*([\d.]+)").group(1)),
        "VF_V": [num(x) for x in g(r"Forward Voltage\s+IF = 10mA\s*VF\s*(?:\[\d\])?\s*.*?([\d.]+)\s+([\d.]+)\s*V").groups()],
        "C_pF": num(g(r"Capacitance\s*C\s*.*?([\d.]+)\s*-?\s*pF").group(1)),
        "domNm": num(g(r"Dominant Wavelength.*?λdom.*?(\d{3})\s*-\s*nm").group(1)),
        "peakNm": num(g(r"Peak Emission.*?λpeak.*?(\d{3})\s*-\s*nm").group(1)),
    }
    sel = re.search(r"SELECTION GUIDE.*?" + re.escape(pn) + r".*?\(([^)]+)\).*?(\d+)\s+(\d+).*?Common (Anode|Cathode)", t[0], re.S)
    if sel:
        m["material"], m["IvMin_ucd"], m["IvTyp_ucd"], m["common"] = sel.group(1), int(sel.group(2)), int(sel.group(3)), sel.group(4).lower()
    else:
        m["selection"] = "not parsed"
    axis = re.findall(r"((?:[\d.]+\s+){5}[\d.]+)\s*Ta = 25 °C\s*Forward voltage", t[2])
    m["ivAxis"] = [num(x) for x in axis[0].split()] if axis else None
    out[pn] = m
def clean(v):
    if isinstance(v, float) and v != v: return None
    if isinstance(v, list): return [clean(x) for x in v]
    if isinstance(v, dict): return {k: clean(x) for k, x in v.items()}
    return v
print(json.dumps(clean(out), indent=1, ensure_ascii=False))
