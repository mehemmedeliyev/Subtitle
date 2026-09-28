/* Collects mono PCM from the captured tab audio and posts it in ~40 ms blocks. */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const chans = input.length;
      const n = input[0].length;
      for (let i = 0; i < n; i++) {
        let v = 0;
        for (let c = 0; c < chans; c++) v += input[c][i];
        this.block[this.pos++] = v / chans;
        if (this.pos === this.block.length) {
          this.port.postMessage(this.block);
          this.block = new Float32Array(2048);
          this.pos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
