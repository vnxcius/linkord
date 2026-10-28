// Mic noise suppression run inside the voice worker. RNNoise today; the interface is small so a
// heavier model (e.g. DeepFilterNet) can replace it later without touching the audio pipeline.

export interface Denoiser {
  /** Denoises a 20 ms, 48 kHz mono frame in place; returns the probability (0-1) that it contains speech. */
  process(frame: Float32Array): number;
  dispose(): void;
}

export type DenoiseKind = 'rnnoise';

export async function createDenoiser(kind: DenoiseKind): Promise<Denoiser> {
  switch (kind) {
    case 'rnnoise': {
      // Loaded on demand: the model and WASM are a few MB.
      const { Rnnoise } = await import('@shiguredo/rnnoise-wasm');
      const rnnoise = await Rnnoise.load();
      const state = rnnoise.createDenoiseState();
      const size = rnnoise.frameSize; // 480 samples = 10 ms
      const buf = new Float32Array(size);
      return {
        process(frame) {
          let voice = 0;
          for (let off = 0; off + size <= frame.length; off += size) {
            // RNNoise works on 16-bit-scale samples.
            for (let i = 0; i < size; i++) buf[i] = frame[off + i] * 32768;
            voice = Math.max(voice, state.processFrame(buf));
            for (let i = 0; i < size; i++) frame[off + i] = buf[i] / 32768;
          }
          return voice;
        },
        dispose: () => state.destroy(),
      };
    }
  }
}
