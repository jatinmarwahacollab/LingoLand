class AudioRecorderWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    
    // Robust Hard Noise Gate
    this.gateOpen = false;
    this.holdFrames = 0;
    this.multiplier = 1.0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      
      let sum = 0;
      for (let i = 0; i < channelData.length; i++) {
        sum += channelData[i] * channelData[i];
      }
      const rms = Math.sqrt(sum / channelData.length);
      
      // Fixed safe threshold (0.008 is slightly above typical laptop mic noise floor)
      const threshold = 0.008; 
      
      if (rms > threshold) {
        this.gateOpen = true;
        this.holdFrames = 50; // hold gate open for ~50 blocks (approx 1 second) after speech stops
      } else {
        if (this.holdFrames > 0) {
          this.holdFrames--;
        } else {
          this.gateOpen = false;
        }
      }
      
      // Smoothly transition multiplier to avoid audio clicks
      const targetMultiplier = this.gateOpen ? 1.0 : 0.0;
      
      for (let i = 0; i < channelData.length; i++) {
        this.multiplier = this.multiplier * 0.95 + targetMultiplier * 0.05;
        
        // Mute audio completely if gate is closed, sending pure silence to Gemini
        this.buffer[this.bufferIndex++] = channelData[i] * this.multiplier;
        
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
