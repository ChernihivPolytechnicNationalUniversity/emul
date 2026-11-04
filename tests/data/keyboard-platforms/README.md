# Real presses of emul's shortcuts on macOS, Windows and Linux

`presses.json` holds what real browsers on real operating systems did with emul's shortcuts on
2026-11-04. GitHub-hosted runners in the private repository `cerobreath/keyboard-layout-lab`
(workflow `platform-keys`) pressed the keys:

| Machine | Browsers | How a key was pressed |
|---|---|---|
| macOS 15.8.2 and 26.6.2, arm64 | Safari 27.2 / 26.6.2, Chrome 156, Firefox 159 / 158 | System Events `key code … using {command down, …}` on the ABC layout; clicks posted as `CGEvent`s at the HID tap |
| Windows Server 2025 Datacenter, build 26100 (24H2), interactive console session | Chrome 156, Edge 156, Firefox 159 | `SendInput` with scan codes, after a click into the page |
| Ubuntu 24.04, real Xorg with the dummy driver, openbox | Chrome 156, Firefox 158, Firefox 158 with `privacy.resistFingerprinting` | XTEST with evdev keycodes; layouts switched with `setxkbmap -rules evdev` |

The page (`probe/platform.html` in the lab) recorded every `keydown`, pointer event, `blur`,
`visibilitychange`, `resize`, `fullscreenchange`, `pagehide` and reload. Each shortcut was pressed
on a fresh page twice: once with the page cancelling every `keydown` (`cancel`), once letting it
through (`pass`), so the browser's own action shows when there is one.

**Format.**

- `browsers`: what each browser reported: `navigator.userAgent`, `navigator.platform`,
  `navigator.userAgentData.platform` (`null` where the browser has none), `maxTouchPoints`.
- `presses`: by machine, then by press (`mod-z` is the platform's command key with Z: Cmd on a Mac,
  Ctrl elsewhere), then by mode. `key` is the first non-modifier `keydown`: `[key, code, keyCode,
  modifiers, prevented|open]`, modifiers `s` shift, `m` meta, `c` ctrl, `a` alt, `g` AltGraph;
  `null` when the page never got the key. `reactions` is what the browser did: `blur` (a dialog,
  a bubble or the menu bar took focus), `visibilitychange` (a new tab), `pagehide` and `boot` (a
  reload), `resize` (zoom or full screen: the page's width changed), `toolbar` (only its height
  changed: an info bar or the menu bar slid in).
- `layouts`: Linux only, by `machine|layout`, then by the shortcut pressed (`Ctrl+Z`, `M`…), each
  `[key, code, keyCode, modifiers]`. The key pressed was the one that types the shortcut's letter on
  that layout, or its US place on a non-Latin layout.
- `clicks`: macOS only, the pointer events for a plain, Control-, Command-, Shift- and right click.

**Rebuilding.** Download the run's artifacts (`gh run download <run> -R cerobreath/keyboard-layout-lab`)
and run `python3 collect.py <artifact folders…> > presses.json`. The runs used here are 41849400490
(macOS), 41848108201 (Windows Chrome and Edge), 41849258448 (Windows Firefox) and 41847590545 (Linux).
