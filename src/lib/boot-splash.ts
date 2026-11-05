/**
 * Dismisses the boot splash from index.html once the app has painted its first frame.
 *
 * Fades from whatever opacity the splash is at right now (it may still be mid fade-in, or not
 * yet visible at all on a warm load) — a CSS transition can't do that off a keyframe animation.
 * Idempotent: StrictMode's double effects or a second call are no-ops.
 */
export function dismissBootSplash(): void {
  const boot = document.getElementById("boot")
  if (!boot || boot.dataset.leaving !== undefined) return
  boot.dataset.leaving = ""

  // The build loads the app's stylesheet non-blocking (vite.config.ts, inlineBootLoader), so the
  // app may have committed unstyled; keep it covered until every sheet is in. Then two frames:
  // the first lets the commit reach layout, the second is after it painted.
  void stylesheetsReady().then(() =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const from = Number(getComputedStyle(boot).opacity)
        boot.getAnimations().forEach((a) => a.cancel())
        if (from === 0) return boot.remove()
        boot.style.opacity = "0"
        boot
          .animate([{ opacity: from }, { opacity: 0 }], { duration: 200, easing: "ease-out" })
          .finished.catch(() => undefined)
          .finally(() => boot.remove())
      }),
    ),
  )
}

/** Resolves once every stylesheet in the document has loaded (or failed — never hold the cover forever). */
function stylesheetsReady(): Promise<unknown> {
  const pending = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].filter((l) => !l.sheet)
  return Promise.all(
    pending.map(
      (l) =>
        new Promise((done) => {
          l.addEventListener("load", done, { once: true })
          l.addEventListener("error", done, { once: true })
        }),
    ),
  )
}
