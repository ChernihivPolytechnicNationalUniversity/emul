# Real key presses on macOS

`presses.json` holds 3778 `keydown` events that real browsers on real macOS sent for real key
presses, on 26 keyboard layouts.

**Where they come from.** GitHub-hosted macOS runners ran the job on 2026-11-04:

- macOS 15.8.2 with Safari 27.2, Chrome 156.0.8078.74 and Firefox 159.0;
- macOS 26.6.2 with Safari 26.6.2, Chrome 156.0.8078.48 and Firefox 158.0.1.

The job lives in the private repository `cerobreath/keyboard-layout-lab`.

**How a key was pressed.** The job switched the system input source with the TIS API. For each
shortcut it chose the key that carries the shortcut's letter on that layout, using the layout's
own `UCKeyTranslate` table, or the key's US place on a non-Latin layout. It pressed that key
through System Events with real Command, Shift, Option and Control into a page that recorded the
`keydown`. A Command chord that would close, quit, hide or move focus from the browser was not
pressed.

**Format.** `presses` is keyed by `os|browser|layout`, then by the shortcut pressed (`Cmd+Z`, `M`,
`Shift+R`…). Each entry is `[key, code, keyCode, modifiers]`, and `modifiers` holds the letters
`s` Shift, `m` Meta, `c` Control, `a` Alt and `g` AltGraph.

`tests/sim/keyboard-macos.test.ts` replays every press through emul's matcher. Regenerate the file
from the job's artifacts:

```sh
python3 tests/data/keyboard-macos/collect.py <artifact folders…> > tests/data/keyboard-macos/presses.json
```
