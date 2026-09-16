import { useEffect, useState } from "react"

/** Deploy-time settings served next to the app; edit public/config.json without a rebuild. */
export type AppConfig = {
  version: string
}

const FALLBACK: AppConfig = { version: "dev" }

let cached: Promise<AppConfig> | undefined

function load(): Promise<AppConfig> {
  cached ??= fetch("/config.json")
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
    .then((json: Partial<AppConfig>) => ({ ...FALLBACK, ...json }))
    .catch(() => FALLBACK)
  return cached
}

/** Resolves to the fallback until /config.json arrives, so callers never see undefined. */
export function useConfig(): AppConfig {
  const [config, setConfig] = useState<AppConfig>(FALLBACK)
  useEffect(() => {
    let live = true
    load().then((c) => live && setConfig(c))
    return () => {
      live = false
    }
  }, [])
  return config
}
