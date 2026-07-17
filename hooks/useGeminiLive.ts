import { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Character, TranscriptItem } from '../types';
import { downsampleBuffer, createPcmBlob, base64DecodeToUint8Array, pcm16ToFloat32 } from '../utils/audioUtils';

const TARGET_SAMPLE_RATE = 16000; // Gemini input rate
const IDLE_TIMEOUT_MS = 60_000;   // 60s of total silence -> disconnect

export const useGeminiLive = (character: Character) => {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);

  // Audio Contexts & Worklets
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  
  const recorderWorkletRef = useRef<AudioWorkletNode | null>(null);
  const playbackWorkletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // UI State Refs (so closures can access latest values)
  const isMutedRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const smoothedRmsRef = useRef(0);
  const volumeThrottleRef = useRef(0);
  const noiseFloorRef = useRef(0.005);

  // VAD & Turn Management
  const sessionRef = useRef<any>(null);
  const lastUserAudioRef = useRef<number>(Date.now());
  const vadTimeoutRef = useRef<any>(null);
  const userWasSpeakingRef = useRef<boolean>(false);
  const turnCompleteSentRef = useRef<boolean>(false); // CRITICAL: Prevent sending multiple turnCompletes
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setSpeakingState = useCallback((speaking: boolean) => {
    isSpeakingRef.current = speaking;
    setIsSpeaking(speaking);
  }, []);

  const stopAudioPlayback = useCallback(() => {
    if (playbackWorkletRef.current) {
      playbackWorkletRef.current.port.postMessage('clear');
    }
  }, []);

  const interrupt = useCallback(() => {
    stopAudioPlayback();
    // We cannot send turnComplete: true here while the model is generating,
    // as it violates the API protocol and crashes the WebSocket.
    // Instead, clearing the local playback buffer is enough to instantly silence it.
    // If you want to force the model to stop, the natural way is to speak (barge-in).
  }, [stopAudioPlayback]);

  const toggleMute = useCallback(() => {
    setIsMuted(prev => {
      const next = !prev;
      isMutedRef.current = next;
      return next;
    });
  }, []);

  const disconnect = useCallback(() => {
    if (idleTimerRef.current) clearInterval(idleTimerRef.current);
    if (vadTimeoutRef.current) clearTimeout(vadTimeoutRef.current);
    if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(track => track.stop());
    if (recorderWorkletRef.current) recorderWorkletRef.current.disconnect();
    if (sourceRef.current) sourceRef.current.disconnect();
    if (inputAudioContextRef.current) inputAudioContextRef.current.close();
    if (playbackWorkletRef.current) playbackWorkletRef.current.disconnect();
    if (outputAudioContextRef.current) outputAudioContextRef.current.close();
    
    sessionRef.current = null;
    setIsActive(false);
    setSpeakingState(false);
    setVolume(0);
  }, [setSpeakingState]);

  const connect = useCallback(async () => {
    try {
      setError(null);
      setIsActive(true);

      const apiKey = process.env.API_KEY;
      if (!apiKey) throw new Error("API Key is missing.");

      // --- 1. Audio Setup ---
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
        latencyHint: 'interactive',
      });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
        latencyHint: 'interactive',
      });

      if (inputAudioContextRef.current.state === 'suspended') await inputAudioContextRef.current.resume();
      if (outputAudioContextRef.current.state === 'suspended') await outputAudioContextRef.current.resume();

      await inputAudioContextRef.current.audioWorklet.addModule('/audio-recorder.worklet.js');
      await outputAudioContextRef.current.audioWorklet.addModule('/audio-playback.worklet.js');

      const nativeSampleRate = inputAudioContextRef.current.sampleRate;
      
      playbackWorkletRef.current = new AudioWorkletNode(outputAudioContextRef.current, 'audio-playback-worklet');
      playbackWorkletRef.current.connect(outputAudioContextRef.current.destination);

      // --- 2. Gemini Live Config ---
      const ai = new GoogleGenAI({ apiKey });
      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: character.voiceName } } },
          systemInstruction: { parts: [{ text: character.systemPrompt }] }
        },
      };

      // --- 3. Start Idle Timer ---
      lastUserAudioRef.current = Date.now();
      idleTimerRef.current = setInterval(() => {
        if (Date.now() - lastUserAudioRef.current >= IDLE_TIMEOUT_MS) {
          console.log(`Idle disconnected`);
          disconnect();
        }
      }, 5000);

      // --- 4. WebSocket Callbacks ---
      const callbacks = {
        onopen: async () => {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
            });
            
            const ctx = inputAudioContextRef.current;
            if (!ctx) return stream.getTracks().forEach(track => track.stop());
            
            mediaStreamRef.current = stream;
            sourceRef.current = ctx.createMediaStreamSource(stream);

            recorderWorkletRef.current = new AudioWorkletNode(ctx, 'audio-recorder-worklet');
            
            recorderWorkletRef.current.port.onmessage = (e) => {
              const rawData = e.data;
              const downsampled = downsampleBuffer(rawData, nativeSampleRate, TARGET_SAMPLE_RATE);
              
              // Volume UI and Dynamic Noise Floor
              volumeThrottleRef.current++;
              if (volumeThrottleRef.current % 3 === 0) {
                let sum = 0;
                for (let i = 0; i < downsampled.length; i++) sum += downsampled[i] * downsampled[i];
                const rms = Math.sqrt(sum / downsampled.length);
                smoothedRmsRef.current = smoothedRmsRef.current * 0.7 + rms * 0.3;
                
                // Adaptive Noise Floor: Drops quickly to true silence, rises incredibly slowly
                if (smoothedRmsRef.current < noiseFloorRef.current) {
                  noiseFloorRef.current = smoothedRmsRef.current;
                } else {
                  noiseFloorRef.current += 0.000005; 
                }
                
                // If muted, force UI volume to 0
                setVolume(isMutedRef.current ? 0 : Math.min(100, smoothedRmsRef.current * 500));
              }

              // Client-side VAD (Guaranteed Fallback if server VAD fails)
              // Only run VAD if not muted
              if (!isMutedRef.current) {
                const vadThreshold = noiseFloorRef.current + 0.008; // Speech is typically at least 0.008 above noise floor

                if (smoothedRmsRef.current > vadThreshold) {
                  lastUserAudioRef.current = Date.now();
                  userWasSpeakingRef.current = true;
                  turnCompleteSentRef.current = false; // User is speaking again, reset flag
                  if (vadTimeoutRef.current) clearTimeout(vadTimeoutRef.current);
                } else if (userWasSpeakingRef.current && !turnCompleteSentRef.current && !isSpeakingRef.current) {
                  // If user stopped speaking, wait 1.5s, then force turn complete
                  if (!vadTimeoutRef.current) {
                    vadTimeoutRef.current = setTimeout(() => {
                      // CRITICAL FIX: We MUST check !isSpeakingRef.current inside the timeout.
                      // If the server started responding during these 1.5 seconds, sending turnComplete will crash the socket!
                      if (!isSpeakingRef.current && Date.now() - lastUserAudioRef.current >= 1500 && sessionRef.current && !turnCompleteSentRef.current) {
                        try {
                          sessionRef.current.sendClientContent({ turnComplete: true });
                          turnCompleteSentRef.current = true; // DO NOT SEND MULTIPLE TIMES
                          userWasSpeakingRef.current = false;
                        } catch (e) {
                          console.error("VAD turn complete error:", e);
                        }
                      }
                      vadTimeoutRef.current = null;
                    }, 1500);
                  }
                }
              }

              if (sessionRef.current) {
                if (isMutedRef.current) {
                  downsampled.fill(0); // Safely mute the PCM payload
                }
                sessionRef.current.sendRealtimeInput({ media: createPcmBlob(downsampled, TARGET_SAMPLE_RATE) });
              }
            };

            sourceRef.current.connect(recorderWorkletRef.current);
          } catch (err) {
            setError('Could not access microphone.');
            disconnect();
          }
        },

        onmessage: (message: LiveServerMessage) => {
          // Server-driven interruption (Barge-in)
          if (message.serverContent?.interrupted) {
            stopAudioPlayback();
            setSpeakingState(false); // Server stopped generating
            turnCompleteSentRef.current = false; // Reset turn complete flag
            return;
          }

          if (message.serverContent?.modelTurn) {
             setSpeakingState(true);
             turnCompleteSentRef.current = false; // Reset turn complete flag because model is responding
             const audioData = message.serverContent.modelTurn.parts?.[0]?.inlineData?.data;
             if (audioData && playbackWorkletRef.current) {
                const rawBytes = base64DecodeToUint8Array(audioData);
                playbackWorkletRef.current.port.postMessage(pcm16ToFloat32(rawBytes));
             }
          }

          if (message.serverContent?.turnComplete) {
             setSpeakingState(false);
          }
        },

        onclose: () => disconnect(),
        onerror: (err: any) => { setError(err.message || 'Connection error'); disconnect(); },
      };

      sessionRef.current = await ai.live.connect({ ...config, callbacks });
    } catch (err) {
      setError('Failed to connect. ' + (err instanceof Error ? err.message : ''));
      setIsActive(false);
    }
  }, [character, stopAudioPlayback, disconnect, setSpeakingState]);

  useEffect(() => disconnect, [disconnect]);

  return { connect, disconnect, isActive, isSpeaking, volume, error, isMuted, toggleMute, interrupt };
};