import { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { Character, TranscriptItem } from '../types';
import { createPcmBlob, base64DecodeToUint8Array, decodeAudioData } from '../utils/audioUtils';

export const useGeminiLive = (character: Character) => {
  const [isActive, setIsActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [volume, setVolume] = useState(0); 
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const isModelSpeakingRef = useRef(false); // Sync ref for audio processor
  const userSpeechCounterRef = useRef(0); // To track consecutive loud frames
  
  const sessionRef = useRef<any>(null);

  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  const stopAudioPlayback = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
    });
    activeSourcesRef.current.clear();
    
    // Reset scheduling to current time to avoid jumping back
    if (outputAudioContextRef.current) {
        nextStartTimeRef.current = outputAudioContextRef.current.currentTime;
    } else {
        nextStartTimeRef.current = 0;
    }
    
    setIsSpeaking(false);
    isModelSpeakingRef.current = false;
  }, []);

  const connect = useCallback(async () => {
    try {
      setError(null);
      setIsActive(true);

      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Key is missing. Please check your settings.");
      }

      // 1. Audio Setup with Interactive Latency
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: 16000,
        latencyHint: 'interactive'
      });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ 
        sampleRate: 24000,
        latencyHint: 'interactive'
      });

      // Mobile Safari fix: Resume context if suspended
      if (inputAudioContextRef.current.state === 'suspended') {
        await inputAudioContextRef.current.resume();
      }
      if (outputAudioContextRef.current.state === 'suspended') {
        await outputAudioContextRef.current.resume();
      }

      // 2. Gemini Setup
      const ai = new GoogleGenAI({ apiKey });
      
      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: character.voiceName } }
          },
          // STRICT FORMAT: Use strict Content object for systemInstruction
          systemInstruction: {
            parts: [{ text: character.systemPrompt }]
          },
        }
      };

      let sessionPromise: Promise<any>;

      const callbacks = {
        onopen: async () => {
          console.log("Session Opened");
          
          try {
            // A. Start Mic
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            
            const ctx = inputAudioContextRef.current!;
            const source = ctx.createMediaStreamSource(stream);
            sourceRef.current = source;
            
            // Buffer size 2048 (~128ms) for balance between latency and stability
            const processor = ctx.createScriptProcessor(2048, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              // 1. Calculate Volume (RMS)
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setVolume(Math.min(100, rms * 500)); 

              // 2. Local Barge-In (Interruption) Logic
              // If model is speaking AND user is loud enough for consecutive frames
              if (isModelSpeakingRef.current && rms > 0.02) {
                 userSpeechCounterRef.current += 1;
                 // If user talks for ~250ms (2 frames), cut the model
                 if (userSpeechCounterRef.current >= 2) {
                     console.log("Local Barge-In Triggered");
                     stopAudioPlayback();
                     userSpeechCounterRef.current = 0;
                 }
              } else {
                 // Reset counter if silence
                 userSpeechCounterRef.current = 0;
              }

              // 3. Send Audio to Gemini
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
          // Handle Interruption Signal from Server (Fallback)
          if (message.serverContent?.interrupted) {
            stopAudioPlayback();
          }

          // Handle Audio Output
          const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audioData && outputAudioContextRef.current) {
            // If we just interrupted locally, we might still receive some lagging audio packets.
            // Ideally we filter them, but stopping playback usually clears the source queue.
            
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

          // Transcriptions
          const outTrans = message.serverContent?.outputTranscription?.text;
          const inTrans = message.serverContent?.inputTranscription?.text;
          if (outTrans) currentOutputTransRef.current += outTrans;
          if (inTrans) currentInputTransRef.current += inTrans;

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
          console.log("Session Closed");
          setIsActive(false);
        },
        onerror: (err: any) => {
          console.error("Session Error", err);
          setError(err.message || "Connection error");
          setIsActive(false);
        }
      };

      // Connect
      sessionPromise = ai.live.connect({ ...config, callbacks });
      const session = await sessionPromise;
      sessionRef.current = session;

    } catch (err) {
      console.error("Connection Failed", err);
      setError("Failed to connect. " + (err instanceof Error ? err.message : ""));
      setIsActive(false);
    }
  }, [character, stopAudioPlayback]);

  const disconnect = useCallback(() => {
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
    
    // Cleanup session
    sessionRef.current = null;
    
    setIsActive(false);
    setIsSpeaking(false);
    isModelSpeakingRef.current = false;
    setVolume(0);
    currentInputTransRef.current = '';
    currentOutputTransRef.current = '';

  }, [stopAudioPlayback]);

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