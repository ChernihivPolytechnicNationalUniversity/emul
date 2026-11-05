import json
import re
import sys
from pathlib import Path

MODIFIER_KEYS = {"Meta", "Shift", "Control", "Alt", "CapsLock", "OS", "Unidentified", "\x00"}
FLAGS = (("shiftKey", "s"), ("metaKey", "m"), ("ctrlKey", "c"), ("altKey", "a"), ("altGraph", "g"))
REACTIONS = {"blur", "pagehide", "fullscreenchange", "boot"}
LINUX_SHORTCUTS = [
    "Ctrl+Z", "Ctrl+Shift+Z", "Ctrl+Y", "Ctrl+A", "Ctrl+D", "Ctrl+Shift+D", "Ctrl+Shift+O", "Ctrl+J", "Ctrl+B", "Ctrl+0", "Ctrl+=", "Ctrl+-",
    "M", "O", "L", "R", "Shift+R", "X", "Y", "C", "Ctrl+O", "Ctrl+S",
]


def flags(event):
    return "".join(letter for field, letter in FLAGS if event.get(field))


def machine_of(folder: Path) -> str:
    match = re.match(r"platform-(macos-\d+|windows|linux)-(.+)", folder.name)
    system, browser = match.groups()
    name = {"windows": "Windows", "linux": "Linux"}.get(system, system.replace("macos-", "macOS "))
    return f"{name} {browser}"


def key_of(event):
    return [event["key"], event["code"], event["keyCode"], flags(event)]


machines, browsers, presses, layouts, clicks = {}, {}, {}, {}, {}
for folder in map(Path, sys.argv[1:]):
    machine = machine_of(folder)
    info = next(folder.glob("machine-*"), None)
    machines[machine] = info.read_text(encoding="utf-8", errors="replace").strip().splitlines()[:12] if info else []
    events = [json.loads(line) for line in (folder / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    boot = next(e for e in events if e["type"] == "boot" and e["run"] == "boot")
    browsers[machine] = {k: boot.get(k) for k in ("userAgent", "platform", "uaDataPlatform", "maxTouchPoints")}
    runs = {}
    widths = {}
    for e in events:
        if e["type"] == "boot":
            widths.setdefault(e["run"], e.get("width"))
    for e in events:
        run, label = e.get("run", ""), e.get("label", "")
        mode = run.rsplit("-", 1)[-1]
        if mode not in ("cancel", "pass") or not label or label.startswith("after-") or run != f"{label}-{mode}":
            continue
        row = runs.setdefault(label, {}).setdefault(mode, {"key": None, "reactions": []})
        if e["type"] == "keydown" and e.get("key") not in MODIFIER_KEYS and row["key"] is None:
            row["key"] = key_of(e) + ["prevented" if e.get("prevented") else "open"]
        elif e["type"] in REACTIONS or (e["type"] == "visibilitychange" and e.get("hidden")):
            row["reactions"].append(e["type"])
        elif e["type"] == "resize":
            row["reactions"].append("resize" if e.get("width") != widths.get(run) else "toolbar")
        elif e["type"] in ("pointerdown", "contextmenu", "auxclick", "click"):
            row.setdefault("pointer", []).append(f'{e["type"]} button={e["button"]} {flags(e)}')
    for label, modes in runs.items():
        for row in modes.values():
            row["reactions"] = list(dict.fromkeys(row["reactions"]))
    presses[machine] = dict(sorted(runs.items()))
    pointer = {}
    for e in events:
        if e.get("run") == "clicks" and e["type"] in ("pointerdown", "contextmenu", "auxclick", "click") and e.get("label") and not e["label"].startswith("after-"):
            pointer.setdefault(e["label"], []).append(f'{e["type"]} button={e["button"]} {flags(e)}'.strip())
    if pointer:
        clicks[machine] = pointer
    for run in sorted({e["run"] for e in events if e.get("run", "").startswith("layout-")}):
        downs = [e for e in events if e.get("run") == run and e["type"] == "keydown" and e.get("key") not in MODIFIER_KEYS and e.get("label") in LINUX_SHORTCUTS]
        group = {}
        if len(downs) == len(LINUX_SHORTCUTS):
            group = {label: key_of(e) for label, e in zip(LINUX_SHORTCUTS, sorted(downs, key=lambda e: e["t"]))}
        if group:
            layouts[f"{machine}|{run.removeprefix('layout-')}"] = group


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def block(name, value):
    return f'"{name}":{{\n' + ",\n".join(f"{compact(k)}:{compact(v)}" for k, v in sorted(value.items())) + "\n}"


sys.stdout.write(
    '{"fields":{"key":["key","code","keyCode","modifiers: s shift, m meta, c ctrl, a alt, g AltGraph","prevented or open"]},\n'
    + ",\n".join([block("machines", machines), block("browsers", browsers), block("presses", presses), block("layouts", layouts), block("clicks", clicks)])
    + "\n}\n"
)
