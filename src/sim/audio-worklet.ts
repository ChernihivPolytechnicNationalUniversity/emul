import { SoundStream, type SoundMessage } from "./sound-stream"

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
type ProcessorOptions = { processorOptions: { sourceRate: number } }
declare function registerProcessor(name: string, processor: new (options: ProcessorOptions) => AudioWorkletProcessor): void

class BuzzerSound extends AudioWorkletProcessor {
  private readonly stream: SoundStream

  constructor(options: ProcessorOptions) {
    super()
    this.stream = new SoundStream(options.processorOptions.sourceRate, sampleRate)
    this.port.onmessage = (e: MessageEvent<{ t: "port"; port: MessagePort }>) => {
      e.data.port.onmessage = (m: MessageEvent<SoundMessage>) => this.stream.receive(m.data)
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const channels = outputs[0]
    this.stream.render(channels[0])
    for (let c = 1; c < channels.length; c++) channels[c].set(channels[0])
    return true
  }
}

registerProcessor("emul-buzzers", BuzzerSound)
