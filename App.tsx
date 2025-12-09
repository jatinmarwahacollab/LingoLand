import React, { useState, useEffect, useRef } from 'react';
import { useGeminiLive } from './hooks/useGeminiLive';
import { Character } from './types';
import { CHARACTERS, TOPICS } from './constants';
import { AudioVisualizer } from './components/Visualizer';
import { Mic, MicOff, Volume2, Sparkles, MessageCircle, Heart, Star } from 'lucide-react';

const App: React.FC = () => {
  const [selectedChar, setSelectedChar] = useState<Character>(CHARACTERS[0]);
  const [hasStarted, setHasStarted] = useState(false);
  
  // Custom hook for Gemini Live interaction
  const { 
    connect, 
    disconnect, 
    isActive, 
    isSpeaking, 
    volume,
    transcripts,
    error 
  } = useGeminiLive(selectedChar);

  // Auto-scroll the transcript
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [transcripts]);

  const handleStart = async () => {
    setHasStarted(true);
    await connect();
  };

  const handleStop = () => {
    disconnect();
    setHasStarted(false);
  };

  const handleCharacterSelect = (char: Character) => {
    if (isActive) {
      // If active, we need to disconnect before switching, or just block switching
      const confirmSwitch = window.confirm("Do you want to stop the current chat to switch friends?");
      if (confirmSwitch) {
        disconnect();
        setHasStarted(false);
        setSelectedChar(char);
      }
    } else {
      setSelectedChar(char);
    }
  };

  // Intro Screen
  if (!hasStarted && !isActive) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-indigo-100 to-purple-200 flex flex-col items-center justify-center p-4">
        <div className="bg-white rounded-3xl shadow-xl p-8 max-w-2xl w-full text-center border-4 border-indigo-200 relative">
          
          <div className="flex justify-center mb-6">
            <div className="bg-indigo-100 p-4 rounded-full">
              <Sparkles className="w-12 h-12 text-indigo-500 animate-pulse" />
            </div>
          </div>
          
          <h1 className="text-4xl font-bold text-indigo-600 mb-2">Hi Anusha!</h1>
          <p className="text-gray-500 text-lg mb-8">Who do you want to talk to today?</p>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
            {CHARACTERS.map((char) => (
              <button
                key={char.id}
                onClick={() => setSelectedChar(char)}
                className={`relative p-6 rounded-2xl transition-all duration-300 transform hover:scale-105 ${
                  selectedChar.id === char.id 
                    ? `bg-gradient-to-br ${char.color} shadow-lg ring-4 ring-offset-2 ring-indigo-300 text-white` 
                    : 'bg-white border-2 border-gray-100 hover:border-indigo-200 text-gray-600'
                }`}
              >
                <div className="text-5xl mb-3">{char.emoji}</div>
                <h3 className="text-xl font-bold">{char.name}</h3>
                <p className={`text-sm mt-2 ${selectedChar.id === char.id ? 'text-white/90' : 'text-gray-400'}`}>
                  {char.description}
                </p>
                {selectedChar.id === char.id && (
                  <div className="absolute top-2 right-2">
                    <Heart className="w-5 h-5 fill-current text-white" />
                  </div>
                )}
              </button>
            ))}
          </div>

          <button
            onClick={handleStart}
            className="w-full md:w-auto px-12 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full text-2xl font-bold shadow-lg transition-transform transform hover:scale-105 flex items-center justify-center gap-3"
          >
            <Mic className="w-8 h-8" />
            Call My Friend!
          </button>
        </div>
      </div>
    );
  }

  // Active Chat Screen
  return (
    <div className={`min-h-screen flex flex-col bg-gradient-to-br ${selectedChar.color} bg-opacity-20`}>
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-md p-4 sticky top-0 z-10 shadow-sm safe-top">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{selectedChar.emoji}</span>
            <div>
              <h1 className="text-xl font-bold text-gray-800">{selectedChar.name}</h1>
              <div className="flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-green-500 animate-pulse' : 'bg-red-400'}`}></span>
                <span className="text-xs text-gray-500">{isActive ? 'Online' : 'Disconnected'}</span>
              </div>
            </div>
          </div>
          <button 
            onClick={handleStop}
            className="bg-red-100 hover:bg-red-200 text-red-600 px-4 py-2 rounded-full font-semibold transition-colors flex items-center gap-2"
          >
            <MicOff className="w-4 h-4" /> Say Bye Bye
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col max-w-4xl mx-auto w-full p-4 gap-4 pb-safe">
        
        {/* Main Visualizer Area */}
        <div className="flex-1 bg-white/60 backdrop-blur-sm rounded-3xl p-6 flex flex-col items-center justify-center relative overflow-hidden shadow-inner min-h-[300px]">
          
          {/* Status Text */}
          <div className="absolute top-6 font-medium text-indigo-800 bg-white/80 px-4 py-1 rounded-full shadow-sm">
            {isSpeaking ? (
              <span className="flex items-center gap-2">
                <Volume2 className="w-4 h-4 animate-pulse" /> {selectedChar.name} is speaking...
              </span>
            ) : (
              <span className="flex items-center gap-2">
                 Listening to Anusha...
              </span>
            )}
          </div>

          {/* Avatar Animation */}
          <div className={`transition-transform duration-500 ${isSpeaking ? 'scale-110' : 'scale-100'}`}>
             <div className="text-[120px] animate-float drop-shadow-2xl filter">{selectedChar.emoji}</div>
          </div>

          {/* Audio Visualizer */}
          <div className="w-full h-32 mt-8 flex items-center justify-center">
             <AudioVisualizer isActive={isActive} isSpeaking={isSpeaking} volume={volume} color={selectedChar.baseColorHex} />
          </div>

          {error && (
            <div className="absolute bottom-4 bg-red-100 text-red-800 px-4 py-2 rounded-lg text-sm text-center max-w-md">
              {error}
            </div>
          )}
        </div>

        {/* Conversation Ideas & Transcript */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-64">
          
          {/* Ice Breakers */}
          <div className="bg-white rounded-3xl p-5 shadow-sm border border-indigo-50 flex flex-col">
            <h3 className="font-bold text-gray-700 flex items-center gap-2 mb-3">
              <Star className="w-5 h-5 text-yellow-500 fill-current" />
              What can I say?
            </h3>
            <div className="flex-1 overflow-y-auto space-y-2 pr-2">
               {TOPICS.map((topic, idx) => (
                 <div key={idx} className="bg-indigo-50 hover:bg-indigo-100 p-3 rounded-xl cursor-pointer transition-colors text-indigo-800 text-sm font-medium">
                   "{topic}"
                 </div>
               ))}
            </div>
          </div>

          {/* Live Transcript */}
          <div className="bg-white rounded-3xl p-5 shadow-sm border border-indigo-50 flex flex-col">
             <h3 className="font-bold text-gray-700 flex items-center gap-2 mb-3">
              <MessageCircle className="w-5 h-5 text-blue-500" />
              Our Chat
            </h3>
            <div ref={transcriptRef} className="flex-1 overflow-y-auto space-y-3 pr-2 scroll-smooth">
               {transcripts.length === 0 ? (
                 <p className="text-gray-400 text-center italic mt-10">Say "Hello!" to start...</p>
               ) : (
                 transcripts.map((t, i) => (
                   <div key={i} className={`flex ${t.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                     <div className={`max-w-[85%] px-4 py-2 rounded-2xl text-sm ${
                       t.role === 'user' 
                       ? 'bg-indigo-500 text-white rounded-tr-none' 
                       : 'bg-gray-100 text-gray-800 rounded-tl-none'
                     }`}>
                       {t.text}
                     </div>
                   </div>
                 ))
               )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;