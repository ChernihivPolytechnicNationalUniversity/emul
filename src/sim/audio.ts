import * as React from "react"
import workletUrl from "./audio-worklet.ts?worker&url"
import { DT } from "./speeds"

export type SoundSettings = { muted: boolean; volume: number }

const SETTINGS_KEY = "emul.sound"
const DEFAULT_SETTINGS: SoundSettings = { muted: false, volume: 0.8 }

function loadSettings(): SoundSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<SoundSettings> | null
    if (!saved) return DEFAULT_SETTINGS
    return { muted: saved.muted === true, volume: typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : DEFAULT_SETTINGS.volume }
  } catch {
    return DEFAULT_SETTINGS
  }
}

function saveSettings(settings: SoundSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    return
  }
}

const perceivedGain = (volume: number) => volume * volume

class BenchAudio {
  private context: AudioContext | null = null
  private node: Promise<AudioWorkletNode> | null = null
  private gain: GainNode | null = null
  private settings = loadSettings()
  private readonly listeners = new Set<() => void>()

  get available() {
    return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined"
  }

  current = () => this.settings

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  set(patch: Partial<SoundSettings>) {
    this.settings = { ...this.settings, ...patch }
    saveSettings(this.settings)
    this.apply()
    for (const l of this.listeners) l()
  }

  async connect(): Promise<MessagePort | null> {
    if (!this.available) return null
    const node = await this.ensureNode()
    const channel = new MessageChannel()
    node.port.postMessage({ t: "port", port: channel.port2 }, [channel.port2])
    return channel.port1
  }

  wake() {
    if (this.context && !this.settings.muted) void this.context.resume()
  }

  private ensureNode(): Promise<AudioWorkletNode> {
    if (!this.node) {
      const context = new AudioContext({ latencyHint: "interactive" })
      this.context = context
      this.gain = context.createGain()
      this.gain.connect(context.destination)
      this.node = context.audioWorklet.addModule(workletUrl).then(() => {
        const node = new AudioWorkletNode(context, "emul-buzzers", { numberOfInputs: 0, outputChannelCount: [1], processorOptions: { sourceRate: 1 / DT } })
        node.connect(this.gain!)
        return node
      })
      this.apply()
    }
    return this.node
  }

  private apply() {
    if (!this.context || !this.gain) return
    this.gain.gain.setTargetAtTime(this.settings.muted ? 0 : perceivedGain(this.settings.volume), this.context.currentTime, 0.02)
    if (this.settings.muted) void this.context.suspend()
    else void this.context.resume()
  }
}

export const benchAudio = new BenchAudio()

export function useSoundSettings(): SoundSettings {
  return React.useSyncExternalStore(benchAudio.subscribe, benchAudio.current, benchAudio.current)
}
