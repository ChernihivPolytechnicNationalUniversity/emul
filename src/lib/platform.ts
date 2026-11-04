export type Platform = "apple" | "windows" | "linux" | "chromeos"

export type PlatformHints = {
  userAgent?: string
  maxTouchPoints?: number
  userAgentData?: { platform?: string } | null
}

const APPLE_DESKTOP = /Macintosh/
const APPLE_TOUCH = /iPad|iPhone/
const CHROME_OS = /\bCrOS\b/
const WINDOWS = /Windows/

export function detectPlatform(hints: PlatformHints = globalThis.navigator ?? {}): Platform {
  const agent = hints.userAgent ?? ""
  if (APPLE_DESKTOP.test(agent) || (APPLE_TOUCH.test(agent) && (hints.maxTouchPoints ?? 0) > 0)) return "apple"
  const declared = hints.userAgentData?.platform
  if (declared === "Chrome OS" || declared === "Chromium OS" || CHROME_OS.test(agent)) return "chromeos"
  if (declared === "Windows" || WINDOWS.test(agent)) return "windows"
  return "linux"
}

let detected: Platform | undefined

export function currentPlatform(): Platform {
  detected ??= detectPlatform()
  return detected
}
