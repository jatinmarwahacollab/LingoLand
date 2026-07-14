class AudioPlaybackWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.currentBuffer = null;
    this.currentIndex = 0;

    // Listen for incoming audio chunks from the main thread
    this.port.onmessage = (e) => {
      if (e.data === 'clear') {
        // Drop all pending audio (e.g. for server-driven interruption)
        this.queue = [];
        this.currentBuffer = null;
        this.currentIndex = 0;
      } else if (e.data instanceof Float32Array) {
        // Enqueue the new audio chunk
        this.queue.push(e.data);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const channel = output[0]; // Assume mono playback

    for (let i = 0; i < channel.length; i++) {
      // If we don't have a buffer, or we've finished the current one, grab the next
      if (!this.currentBuffer || this.currentIndex >= this.currentBuffer.length) {
        if (this.queue.length > 0) {
          this.currentBuffer = this.queue.shift();
          this.currentIndex = 0;
        } else {
          this.currentBuffer = null;
        }
      }

      // If we have a buffer to play, play it. Otherwise, output silence.
      if (this.currentBuffer) {
        channel[i] = this.currentBuffer[this.currentIndex++];
      } else {
        channel[i] = 0;
      }
    }
    
    // Return true to keep the worklet alive
    return true;
  }
}

registerProcessor('audio-playback-worklet', AudioPlaybackWorklet);
