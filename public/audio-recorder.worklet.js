class AudioRecorderWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      
      for (let i = 0; i < channelData.length; i++) {
        // Pure pass-through. No artificial silence, no noise gate.
        // The Gemini ML VAD expects the natural noise floor to operate correctly.
        this.buffer[this.bufferIndex++] = channelData[i];
        
        // When buffer is full, send it to the main thread
        if (this.bufferIndex >= this.bufferSize) {
          this.port.postMessage(new Float32Array(this.buffer));
          this.bufferIndex = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('audio-recorder-worklet', AudioRecorderWorklet);
