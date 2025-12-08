import { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Character, TranscriptItem } from '../types';
import { createPcmBlob, base64DecodeToUint8Array, decodeAudioData } from '../utils/audioUtils';

export const useGeminiLive = (character: Character) => {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false); // Model is speaking
  const [volume, setVolume] = useState(0); // Input volume for visualizer
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Audio Context Refs
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  // Playback State
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  
  // Session Logic
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const currentSessionRef = useRef<any>(null); // To hold the actual session object for closure access

  // Transcription buffer
  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  const stopAudioPlayback = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
      } catch (e) {
        // ignore already stopped
      }
    });
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
  }, []);

  const connect = useCallback(async () => {
    try {
      setError(null);
      setIsActive(true);

      // 1. Setup Audio Contexts
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      // 2. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // 3. Define Session Config & Callbacks
      let sessionPromise: Promise<any>;
      sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: character.voiceName } }
          },
          // Pass system instruction as a structured Content object
          systemInstruction: { parts: [{ text: character.systemPrompt }] },
        },
        callbacks: {
          onopen: async () => {
            console.log("Session Opened");
            // Start Microphone
            try {
              const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
              mediaStreamRef.current = stream;
              
              const ctx = inputAudioContextRef.current!;
              const source = ctx.createMediaStreamSource(stream);
              sourceRef.current = source;

              // Use ScriptProcessor for raw PCM access (Worklet is better for prod, but this is simpler for React SPA w/o external files)
              const processor = ctx.createScriptProcessor(4096, 1, 1);
              processorRef.current = processor;

              processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                
                // Calculate volume for visualizer
                let sum = 0;
                for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
                const rms = Math.sqrt(sum / inputData.length);
                setVolume(Math.min(100, rms * 500)); // Scale for UI

                // Send to Gemini
                const pcmBlob = createPcmBlob(inputData, 16000);
                sessionPromise.then(session => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              };

              source.connect(processor);
              processor.connect(ctx.destination);
            } catch (err) {
              console.error("Mic Error:", err);
              setError("Could not access microphone.");
              disconnect();
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            // 1. Handle Audio Output
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              setIsSpeaking(true);
              const ctx = outputAudioContextRef.current;
              
              // Sync start time
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
                }
              };

              source.start(nextStartTimeRef.current);
              activeSourcesRef.current.add(source);
              nextStartTimeRef.current += audioBuffer.duration;
            }

            // 2. Handle Interruption
            if (message.serverContent?.interrupted) {
              console.log("Model interrupted");
              stopAudioPlayback();
            }

            // 3. Handle Transcriptions (Optional - if server sends them)
            const outTrans = message.serverContent?.outputTranscription?.text;
            const inTrans = message.serverContent?.inputTranscription?.text;

            if (outTrans) currentOutputTransRef.current += outTrans;
            if (inTrans) currentInputTransRef.current += inTrans;

            if (message.serverContent?.turnComplete) {
              // Flush transcripts to state
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
            console.log("Session Closed");
            setIsActive(false);
          },
          onerror: (err) => {
            console.error("Session Error", err);
            // Don't set error immediately on close, but meaningful errors
            if (err instanceof Error || (err as any).message) {
                 setError(`Connection error: ${(err as any).message || 'Unknown network error'}`);
            } else {
                 setError("Connection error. Please check your network.");
            }
            setIsActive(false);
          }
        }
      });
      
      sessionPromiseRef.current = sessionPromise;
      currentSessionRef.current = await sessionPromise;

    } catch (err) {
      console.error("Connection Failed", err);
      setError("Failed to connect to Gemini.");
      setIsActive(false);
    }
  }, [character, stopAudioPlayback]);

  const disconnect = useCallback(() => {
    // Stop Mic
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

    // Stop Playback
    stopAudioPlayback();
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    
    // Reset State
    setIsActive(false);
    setIsSpeaking(false);
    setVolume(0);
    currentInputTransRef.current = '';
    currentOutputTransRef.current = '';

  }, [stopAudioPlayback]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return {
    connect,
    disconnect,
    isActive,
    isSpeaking,
    volume,
    transcripts,
    error
  };
};