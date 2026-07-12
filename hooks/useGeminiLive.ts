import { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Character, TranscriptItem } from '../types';
import { downsampleBuffer, createPcmBlob, base64DecodeToUint8Array, decodeAudioData } from '../utils/audioUtils';

const TARGET_SAMPLE_RATE = 16000; // What Gemini expects for input
const IDLE_TIMEOUT_MS = 45_000;   // 45 seconds of total silence → auto-disconnect

/**
 * Gemini Live–style hook.
 *
 * • Capture mic at browser's native sample rate, downsample to 16kHz.
 * • Stream ALL audio continuously — server-side VAD handles everything.
 * • Obey server `interrupted` signals for barge-in.
 * • Auto-disconnect after prolonged silence (like Gemini Live does).
 */
export const useGeminiLive = (character: Character) => {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Audio refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Playback scheduling
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const isModelSpeakingRef = useRef(false);

  // Volume (purely for UI)
  const smoothedRmsRef = useRef(0);
  const volumeThrottleRef = useRef(0);

  // Session
  const sessionRef = useRef<any>(null);

  // Transcript accumulation
  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  // Idle timeout — tracks last activity (user speech or model response)
  const lastActivityRef = useRef<number>(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Stop playback (server-driven interruption) ───
  const stopAudioPlayback = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (_e) { /* already stopped */ }
    });
    activeSourcesRef.current.clear();

    if (outputAudioContextRef.current) {
      nextStartTimeRef.current = outputAudioContextRef.current.currentTime;
    } else {
      nextStartTimeRef.current = 0;
    }

    setIsSpeaking(false);
    isModelSpeakingRef.current = false;
  }, []);

  // ─── Disconnect ───
  const disconnect = useCallback(() => {
    // Clear idle timer
    if (idleTimerRef.current) {
      clearInterval(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    stopAudioPlayback();
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }

    sessionRef.current = null;

    setIsActive(false);
    setIsSpeaking(false);
    isModelSpeakingRef.current = false;
    setVolume(0);
    currentInputTransRef.current = '';
    currentOutputTransRef.current = '';
  }, [stopAudioPlayback]);

  // ─── Connect ───
  const connect = useCallback(async () => {
    try {
      setError(null);
      setIsActive(true);
      setTranscripts([]);

      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Key is missing. Please check your settings.");
      }

      // 1. Audio contexts — use browser's NATIVE sample rate for input
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive',
      });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
        latencyHint: 'interactive',
      });

      // Mobile Safari fix
      if (inputAudioContextRef.current.state === 'suspended') {
        await inputAudioContextRef.current.resume();
      }
      if (outputAudioContextRef.current.state === 'suspended') {
        await outputAudioContextRef.current.resume();
      }

      const nativeSampleRate = inputAudioContextRef.current.sampleRate;
      console.log(`Mic native sample rate: ${nativeSampleRate} Hz → downsampling to ${TARGET_SAMPLE_RATE} Hz`);

      // 2. Gemini Live config (sent ONCE during WebSocket setup)
      const ai = new GoogleGenAI({ apiKey });

      const config = {
        // Reverting to the preview model as the newer 'gemini-live-2.5-flash-native-audio'
        // name was rejected by the API backend, causing the immediate websocket close.
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: character.voiceName } },
          },
          systemInstruction: {
            parts: [{ text: character.systemPrompt }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          
          // CRITICAL: Tune server-side VAD (Voice Activity Detection)
          // By default, the model waits too long before deciding you've finished speaking.
          // This makes it respond much faster and feels more natural.
          realtimeInputConfig: {
            automaticActivityDetection: {
              endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
              silenceDurationMs: 400 // Reacts after 400ms of silence
            }
          }
        },
      };

      let sessionPromise: Promise<any>;

      // 3. Start idle timer — auto-disconnect after silence
      lastActivityRef.current = Date.now();
      idleTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= IDLE_TIMEOUT_MS) {
          console.log(`Idle for ${Math.round(elapsed / 1000)}s — auto-disconnecting`);
          disconnect();
        }
      }, 5000);

      const callbacks = {
        onopen: async () => {
          console.log('Session Opened');

          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // If the connection was abruptly closed or model rejected, disconnect()
            // would have run, setting inputAudioContextRef to null. We must check this 
            // before trying to use it!
            const ctx = inputAudioContextRef.current;
            if (!ctx) {
               console.warn("Session was aborted before mic was initialized.");
               stream.getTracks().forEach(track => track.stop());
               return;
            }
            
            mediaStreamRef.current = stream;
            const source = ctx.createMediaStreamSource(stream);
            sourceRef.current = source;

            const processor = ctx.createScriptProcessor(2048, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const rawData = e.inputBuffer.getChannelData(0);

              // Downsample from native rate to 16kHz
              const downsampled = downsampleBuffer(rawData, nativeSampleRate, TARGET_SAMPLE_RATE);

              // Volume for visualizer (throttled to ~8fps)
              volumeThrottleRef.current++;
              if (volumeThrottleRef.current % 3 === 0) {
                let sum = 0;
                for (let i = 0; i < downsampled.length; i++) sum += downsampled[i] * downsampled[i];
                const rms = Math.sqrt(sum / downsampled.length);
                smoothedRmsRef.current = smoothedRmsRef.current * 0.7 + rms * 0.3;
                setVolume(Math.min(100, smoothedRmsRef.current * 500));
              }

              // Stream to Gemini
              const pcmBlob = createPcmBlob(downsampled, TARGET_SAMPLE_RATE);
              sessionPromise.then(session => {
                if (sessionRef.current) {
                  session.sendRealtimeInput({ media: pcmBlob });
                }
              });
            };

            source.connect(processor);
            processor.connect(ctx.destination);
          } catch (err) {
            console.error('Mic Error:', err);
            setError('Could not access microphone.');
            disconnect();
          }
        },

        onmessage: async (message: LiveServerMessage) => {
          // Server-driven interruption
          if (message.serverContent?.interrupted) {
            stopAudioPlayback();
            return;
          }

          // Audio playback
          const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audioData && outputAudioContextRef.current) {
            // Reset idle timer — model is responding
            lastActivityRef.current = Date.now();

            setIsSpeaking(true);
            isModelSpeakingRef.current = true;

            const ctx = outputAudioContextRef.current;
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

            const rawBytes = base64DecodeToUint8Array(audioData);
            const audioBuffer = await decodeAudioData(rawBytes, ctx, 24000);

            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);

            source.onended = () => {
              activeSourcesRef.current.delete(source);
              if (activeSourcesRef.current.size === 0) {
                setIsSpeaking(false);
                isModelSpeakingRef.current = false;
              }
            };

            source.start(nextStartTimeRef.current);
            activeSourcesRef.current.add(source);
            nextStartTimeRef.current += audioBuffer.duration;
          }

          // Transcriptions — reset idle timer on user speech too
          const outTrans = message.serverContent?.outputTranscription?.text;
          const inTrans = message.serverContent?.inputTranscription?.text;
          if (outTrans) currentOutputTransRef.current += outTrans;
          if (inTrans) {
            currentInputTransRef.current += inTrans;
            lastActivityRef.current = Date.now(); // User is speaking
          }

          if (message.serverContent?.turnComplete) {
            if (currentInputTransRef.current.trim()) {
              setTranscripts(prev => [...prev, { role: 'user', text: currentInputTransRef.current.trim() }]);
              currentInputTransRef.current = '';
            }
            if (currentOutputTransRef.current.trim()) {
              setTranscripts(prev => [...prev, { role: 'model', text: currentOutputTransRef.current.trim() }]);
              currentOutputTransRef.current = '';
            }
          }
        },

        onclose: () => {
          console.log('Session Closed');
          disconnect();
        },
        onerror: (err: any) => {
          console.error('Session Error', err);
          setError(err.message || 'Connection error');
          disconnect();
        },
      };

      // 4. Open WebSocket
      sessionPromise = ai.live.connect({ ...config, callbacks });
      const session = await sessionPromise;
      sessionRef.current = session;
    } catch (err) {
      console.error('Connection Failed', err);
      setError('Failed to connect. ' + (err instanceof Error ? err.message : ''));
      setIsActive(false);
    }
  }, [character, stopAudioPlayback, disconnect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => { disconnect(); };
  }, [disconnect]);

  return { connect, disconnect, isActive, isSpeaking, volume, transcripts, error };
};