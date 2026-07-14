import { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Character, TranscriptItem } from '../types';
import { downsampleBuffer, createPcmBlob, base64DecodeToUint8Array, pcm16ToFloat32 } from '../utils/audioUtils';

const TARGET_SAMPLE_RATE = 16000; // Gemini input rate
const IDLE_TIMEOUT_MS = 45_000;   // 45s of total silence -> disconnect

export const useGeminiLive = (character: Character) => {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [liveInputText, setLiveInputText] = useState('');
  const [liveOutputText, setLiveOutputText] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Audio Contexts & Worklets
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  
  const recorderWorkletRef = useRef<AudioWorkletNode | null>(null);
  const playbackWorkletRef = useRef<AudioWorkletNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  // Volume UI
  const smoothedRmsRef = useRef(0);
  const volumeThrottleRef = useRef(0);

  // Session
  const sessionRef = useRef<any>(null);

  // Transcripts
  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  // Idle Timer
  const lastActivityRef = useRef<number>(Date.now());
  const idleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clear playback queue completely when interrupted
  const stopAudioPlayback = useCallback(() => {
    if (playbackWorkletRef.current) {
      playbackWorkletRef.current.port.postMessage('clear');
    }
    setIsSpeaking(false);
  }, []);

  const disconnect = useCallback(() => {
    if (idleTimerRef.current) {
      clearInterval(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    
    if (recorderWorkletRef.current) {
      recorderWorkletRef.current.disconnect();
      recorderWorkletRef.current = null;
    }

    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    
    if (playbackWorkletRef.current) {
      playbackWorkletRef.current.disconnect();
      playbackWorkletRef.current = null;
    }

    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }

    sessionRef.current = null;

    setIsActive(false);
    setIsSpeaking(false);
    setVolume(0);
    setLiveInputText('');
    setLiveOutputText('');
    currentInputTransRef.current = '';
    currentOutputTransRef.current = '';
  }, []);

  const connect = useCallback(async () => {
    try {
      setError(null);
      setIsActive(true);
      setTranscripts([]);

      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Key is missing. Please check your settings.");
      }

      // --- 1. Audio Setup with AudioWorklet ---
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 16000,
        latencyHint: 'interactive',
      });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: 24000,
        latencyHint: 'interactive',
      });

      // Mobile Safari context resume
      if (inputAudioContextRef.current.state === 'suspended') {
        await inputAudioContextRef.current.resume();
      }
      if (outputAudioContextRef.current.state === 'suspended') {
        await outputAudioContextRef.current.resume();
      }

      // Load Worklets
      await inputAudioContextRef.current.audioWorklet.addModule('/audio-recorder.worklet.js');
      await outputAudioContextRef.current.audioWorklet.addModule('/audio-playback.worklet.js');

      const nativeSampleRate = inputAudioContextRef.current.sampleRate;
      
      // Setup Playback Pipeline
      playbackWorkletRef.current = new AudioWorkletNode(outputAudioContextRef.current, 'audio-playback-worklet');
      playbackWorkletRef.current.connect(outputAudioContextRef.current.destination);

      // --- 2. Gemini Live Config ---
      const ai = new GoogleGenAI({ apiKey });
      const config = {
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
          outputAudioTranscription: {}
        },
      };

      let sessionPromise: Promise<any>;

      // --- 3. Start Idle Timer ---
      lastActivityRef.current = Date.now();
      idleTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= IDLE_TIMEOUT_MS) {
          console.log(`Idle for ${Math.round(elapsed / 1000)}s — auto-disconnecting`);
          disconnect();
        }
      }, 5000);

      // --- 4. WebSocket Callbacks ---
      const callbacks = {
        onopen: async () => {
          console.log('Session Opened');

          try {
            // CRITICAL: Enforce strict hardware/software echo cancellation!
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              }
            });
            
            const ctx = inputAudioContextRef.current;
            if (!ctx) {
               console.warn("Session was aborted before mic was initialized.");
               stream.getTracks().forEach(track => track.stop());
               return;
            }
            
            mediaStreamRef.current = stream;
            const source = ctx.createMediaStreamSource(stream);
            sourceRef.current = source;

            // Setup Recording Worklet
            const recorder = new AudioWorkletNode(ctx, 'audio-recorder-worklet');
            recorderWorkletRef.current = recorder;

            recorder.port.onmessage = (e) => {
              const rawData = e.data; // Float32Array from Worklet

              // Downsample
              const downsampled = downsampleBuffer(rawData, nativeSampleRate, TARGET_SAMPLE_RATE);

              // Volume UI
              volumeThrottleRef.current++;
              if (volumeThrottleRef.current % 3 === 0) {
                let sum = 0;
                for (let i = 0; i < downsampled.length; i++) sum += downsampled[i] * downsampled[i];
                const rms = Math.sqrt(sum / downsampled.length);
                smoothedRmsRef.current = smoothedRmsRef.current * 0.7 + rms * 0.3;
                setVolume(Math.min(100, smoothedRmsRef.current * 500));
              }

              if (sessionRef.current) {
                const pcmBlob = createPcmBlob(downsampled, TARGET_SAMPLE_RATE);
                sessionRef.current.sendRealtimeInput({ media: pcmBlob });
              }
            };

            source.connect(recorder);
            // DO NOT connect recorder to destination, otherwise mic feeds back into speakers!
          } catch (err) {
            console.error('Mic Error:', err);
            setError('Could not access microphone.');
            disconnect();
          }
        },

        onmessage: (message: LiveServerMessage) => {
          // Server-driven interruption (Barge-in)
          if (message.serverContent?.interrupted) {
            stopAudioPlayback();
            return;
          }

          // Audio playback routing to Worklet
          const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audioData && playbackWorkletRef.current) {
            lastActivityRef.current = Date.now();
            setIsSpeaking(true); // Can be improved with an event from the worklet later

            // Decode base64 to PCM Float32Array instantly on main thread
            const rawBytes = base64DecodeToUint8Array(audioData);
            const float32Data = pcm16ToFloat32(rawBytes);
            
            // Queue into Worklet for gapless playback
            playbackWorkletRef.current.port.postMessage(float32Data);
            
            // Note: Since the worklet handles the buffering now, we don't have perfect
            // UI sync for `isSpeaking=false` automatically. We can just rely on the stream.
            // But to keep it simple, we use a timeout based on byte length.
            const audioDurationMs = (float32Data.length / 24000) * 1000;
            setTimeout(() => {
                // Heuristic: If we haven't received audio recently, turn off speaking flag.
                if (Date.now() - lastActivityRef.current >= audioDurationMs - 50) {
                   setIsSpeaking(false);
                }
            }, audioDurationMs);
          }

          // Transcriptions
          const outTrans = message.serverContent?.outputTranscription?.text;
          const inTrans = message.serverContent?.inputTranscription?.text;
          if (outTrans) {
            currentOutputTransRef.current += outTrans;
            setLiveOutputText(currentOutputTransRef.current);
          }
          if (inTrans) {
            currentInputTransRef.current += inTrans;
            setLiveInputText(currentInputTransRef.current);
            lastActivityRef.current = Date.now();
          }

          if (message.serverContent?.turnComplete) {
            if (currentInputTransRef.current.trim()) {
              setTranscripts(prev => [...prev, { role: 'user', text: currentInputTransRef.current.trim() }]);
              currentInputTransRef.current = '';
              setLiveInputText('');
            }
            if (currentOutputTransRef.current.trim()) {
              setTranscripts(prev => [...prev, { role: 'model', text: currentOutputTransRef.current.trim() }]);
              currentOutputTransRef.current = '';
              setLiveOutputText('');
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

      // Connect WebSocket
      sessionPromise = ai.live.connect({ ...config, callbacks });
      const session = await sessionPromise;
      sessionRef.current = session;
    } catch (err) {
      console.error('Connection Failed', err);
      setError('Failed to connect. ' + (err instanceof Error ? err.message : ''));
      setIsActive(false);
    }
  }, [character, stopAudioPlayback, disconnect]);

  useEffect(() => {
    return () => { disconnect(); };
  }, [disconnect]);

  return { connect, disconnect, isActive, isSpeaking, volume, transcripts, liveInputText, liveOutputText, error };
};