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
  
  const sessionRef = useRef<any>(null);

  const currentInputTransRef = useRef('');
  const currentOutputTransRef = useRef('');

  const stopAudioPlayback = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try { source.stop(); } catch (e) { /* ignore */ }
    });
    activeSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    setIsSpeaking(false);
  }, []);

  const connect = useCallback(async () => {
    try {
      setError(null);
      setIsActive(true);

      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("API Key is missing. Please check your settings.");
      }

      // 1. Audio Setup
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      // 2. Gemini Setup
      const ai = new GoogleGenAI({ apiKey });
      
      const config = {
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: character.voiceName } }
          },
          // STRICT FORMAT: Use strict Content object for systemInstruction to prevent WebSocket handshake failure
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
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              // Visualizer volume
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              const rms = Math.sqrt(sum / inputData.length);
              setVolume(Math.min(100, rms * 500)); 

              // Send Audio
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
          // Audio Output
          const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audioData && outputAudioContextRef.current) {
            setIsSpeaking(true);
            const ctx = outputAudioContextRef.current;
            nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
            const rawBytes = base64DecodeToUint8Array(audioData);
            const audioBuffer = await decodeAudioData(rawBytes, ctx, 24000);
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            source.onended = () => {
              activeSourcesRef.current.delete(source);
              if (activeSourcesRef.current.size === 0) setIsSpeaking(false);
            };
            source.start(nextStartTimeRef.current);
            activeSourcesRef.current.add(source);
            nextStartTimeRef.current += audioBuffer.duration;
          }

          if (message.serverContent?.interrupted) {
            stopAudioPlayback();
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