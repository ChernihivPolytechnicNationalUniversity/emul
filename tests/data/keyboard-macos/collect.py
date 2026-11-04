import json
import sys
from pathlib import Path

MODIFIER_KEYS = {"Meta", "Shift", "Control", "Alt", "CapsLock", "OS"}
FLAGS = (("shiftKey", "s"), ("metaKey", "m"), ("ctrlKey", "c"), ("altKey", "a"), ("altGraph", "g"))

groups = {}
machines = {}
for folder in map(Path, sys.argv[1:]):
    os_name = "macOS 26" if "macos-26" in folder.name else "macOS 15"
    browser = folder.name.rsplit("-", 1)[-1]
    machines[f"{os_name} {browser}"] = (folder / "machine.txt").read_text().strip().splitlines()
    for line in (folder / "events.jsonl").read_text().splitlines():
        event = json.loads(line)
        if event.get("type") != "keydown" or event.get("page") != "/index.html" or event.get("key") in MODIFIER_KEYS or not event.get("label"):
            continue
        if event.get("pressedCode") and event["pressedCode"] != event.get("code"):
            continue
        group = groups.setdefault(f"{os_name}|{event['browser']}|{event['layout']}", {})
        flags = "".join(letter for field, letter in FLAGS if event.get(field))
        group.setdefault(event["label"], [event["key"], event["code"], event["keyCode"], flags])


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


lines = [f"{compact(name)}:{compact(dict(sorted(group.items())))}" for name, group in sorted(groups.items())]
sys.stdout.write('{"fields":["key","code","keyCode","modifiers: s shift, m meta, c ctrl, a alt, g AltGraph"],\n"machines":' + compact(machines) + ',\n"presses":{\n' + ",\n".join(lines) + "\n}}\n")
