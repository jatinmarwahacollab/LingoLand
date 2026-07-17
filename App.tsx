import React, { useState, useEffect, useRef } from 'react';
import { useGeminiLive } from './hooks/useGeminiLive';
import { Character } from './types';
import { CHARACTERS, TOPICS } from './constants';
import { AudioVisualizer } from './components/Visualizer';
import { Mic, MicOff, Volume2, Sparkles, MessageCircle, Heart, Star, StopCircle } from 'lucide-react';

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
    error,
    isMuted,
    toggleMute,
    interrupt
  } = useGeminiLive(selectedChar);

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
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-6 relative overflow-hidden">
        {/* Animated Background Orbs */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-indigo-600 rounded-full mix-blend-screen filter blur-[100px] opacity-30 animate-pulse"></div>
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-purple-600 rounded-full mix-blend-screen filter blur-[100px] opacity-30 animate-pulse" style={{ animationDelay: '1s' }}></div>

        <div className="z-10 w-full max-w-4xl text-center">
          <div className="flex justify-center mb-4">
            <div className="bg-white/10 backdrop-blur-md p-4 rounded-3xl inline-block border border-white/10 shadow-2xl">
              <Sparkles className="w-10 h-10 text-indigo-300 animate-pulse" />
            </div>
          </div>
          
          <h1 className="text-5xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-300 to-purple-300 mb-2 tracking-tight">
            Hi Anusha!
          </h1>
          <p className="text-slate-400 text-xl mb-12 font-medium tracking-wide">Select a friend to talk to</p>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
            {CHARACTERS.map((char) => (
              <button
                key={char.id}
                onClick={() => handleCharacterSelect(char)}
                className={`group relative p-8 rounded-[2rem] transition-all duration-500 transform hover:-translate-y-2 flex flex-col items-center text-center overflow-hidden
                  ${selectedChar.id === char.id 
                    ? `bg-gradient-to-br ${char.color} shadow-[0_0_40px_rgba(139,92,246,0.3)] border border-white/20 text-white scale-105` 
                    : 'bg-white/5 backdrop-blur-sm border border-white/10 hover:bg-white/10 hover:border-white/20 text-slate-300'
                }`}
              >
                {/* Glow behind emoji on selection */}
                {selectedChar.id === char.id && (
                  <div className="absolute inset-0 bg-white/20 filter blur-3xl opacity-50"></div>
                )}
                
                <div className="text-6xl mb-4 relative z-10 transition-transform duration-500 group-hover:scale-110">{char.emoji}</div>
                <h3 className="text-2xl font-bold relative z-10">{char.name}</h3>
                <p className={`text-sm mt-3 relative z-10 font-medium ${selectedChar.id === char.id ? 'text-white/90' : 'text-slate-400'}`}>
                  {char.description}
                </p>
                {selectedChar.id === char.id && (
                  <div className="absolute top-4 right-4 z-10 animate-pulse">
                    <Heart className="w-6 h-6 fill-current text-white drop-shadow-md" />
                  </div>
                )}
              </button>
            ))}
          </div>

          <button
            onClick={handleStart}
            className="w-full md:w-auto px-16 py-5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white rounded-full text-2xl font-bold shadow-[0_0_30px_rgba(99,102,241,0.5)] transition-all duration-300 transform hover:scale-105 hover:shadow-[0_0_50px_rgba(99,102,241,0.7)] flex items-center justify-center gap-4 mx-auto"
          >
            <Mic className="w-8 h-8" />
            Start Voice Chat
          </button>
        </div>
      </div>
    );
  }

  // Active Chat Screen (Immersive Live View)
  return (
    <div className={`min-h-screen flex flex-col bg-slate-950 text-white overflow-hidden relative transition-colors duration-1000`}>
      
      {/* Dynamic Background Glow based on Character Color */}
      <div className={`absolute inset-0 opacity-20 bg-gradient-to-b ${selectedChar.color}`}></div>
      {isSpeaking && (
        <div className={`absolute inset-0 opacity-40 bg-gradient-to-t ${selectedChar.color} animate-pulse duration-[3000ms]`}></div>
      )}

      {/* Floating Header */}
      <header className="p-6 relative z-10 flex justify-between items-center w-full max-w-5xl mx-auto">
        <div className="flex items-center gap-4 bg-white/10 backdrop-blur-xl px-5 py-3 rounded-full border border-white/10 shadow-xl">
          <div className="w-12 h-12 bg-white/10 rounded-full flex items-center justify-center text-2xl shadow-inner">
            {selectedChar.emoji}
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-wide">{selectedChar.name}</h1>
            <div className="flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.8)]' : 'bg-rose-500'}`}></span>
              <span className="text-xs font-semibold tracking-wider text-slate-300 uppercase">{isActive ? 'Live' : 'Offline'}</span>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Interrupt Button - Only show when model is speaking */}
          {isSpeaking && (
            <button 
              onClick={interrupt}
              className="bg-amber-500/20 hover:bg-amber-500/40 backdrop-blur-md text-amber-300 border border-amber-500/30 px-4 py-3 rounded-full font-bold transition-all duration-300 flex items-center gap-2 shadow-lg"
              title="Stop current response"
            >
              <StopCircle className="w-5 h-5" /> Interrupt
            </button>
          )}

          {/* Mute Button */}
          <button 
            onClick={toggleMute}
            className={`backdrop-blur-md px-4 py-3 rounded-full font-bold transition-all duration-300 flex items-center gap-2 shadow-lg ${
              isMuted 
                ? 'bg-rose-500/20 hover:bg-rose-500/40 text-rose-300 border border-rose-500/30' 
                : 'bg-white/10 hover:bg-white/20 text-slate-300 border border-white/10'
            }`}
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />} 
            {isMuted ? 'Muted' : 'Mute'}
          </button>

          <button 
            onClick={handleStop}
            className="bg-rose-500/20 hover:bg-rose-500/40 backdrop-blur-md text-rose-300 border border-rose-500/30 px-6 py-3 rounded-full font-bold transition-all duration-300 flex items-center gap-3 shadow-lg hover:shadow-rose-500/20"
          >
             End Call
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center w-full relative z-10">
        
        {/* Status Indicator */}
        <div className="absolute top-10 font-bold text-slate-300 bg-white/5 backdrop-blur-sm px-6 py-2 rounded-full border border-white/5 tracking-widest text-sm uppercase">
          {isSpeaking ? (
            <span className="flex items-center gap-3 text-indigo-300">
              <Volume2 className="w-4 h-4 animate-pulse" /> Speaking...
            </span>
          ) : (
            <span className="flex items-center gap-3 text-emerald-300">
              <Mic className="w-4 h-4 animate-pulse" /> Listening...
            </span>
          )}
        </div>

        {/* Immersive Avatar */}
        <div className="relative flex items-center justify-center">
          {/* Audio Reactivity Aura */}
          <div className={`absolute w-[300px] h-[300px] rounded-full bg-gradient-to-r ${selectedChar.color} filter blur-[80px] transition-opacity duration-300 ${isSpeaking ? 'opacity-80' : 'opacity-20'}`}></div>
          
          <div className={`text-[150px] relative z-10 transition-transform duration-500 drop-shadow-2xl ${isSpeaking ? 'scale-110 animate-float' : 'scale-100'}`}>
            {selectedChar.emoji}
          </div>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="absolute bottom-40 bg-rose-500/90 backdrop-blur-md text-white px-6 py-3 rounded-2xl text-sm font-semibold max-w-md shadow-2xl flex items-center gap-3 border border-rose-400/50">
            <span className="w-2 h-2 rounded-full bg-white animate-pulse"></span>
            {error}
          </div>
        )}
      </main>

      {/* Floating Bottom Audio Visualizer & Ideas Drawer */}
      <div className="w-full relative z-20 pb-8 pt-4 bg-gradient-to-t from-slate-950 via-slate-950/80 to-transparent">
        
        {/* Suggestion Chips (Minimal) */}
        <div className="flex justify-center mb-6 px-4">
          <div className="flex flex-wrap justify-center gap-3 max-w-3xl">
             {TOPICS.map((topic, idx) => (
               <div key={idx} className="bg-white/5 hover:bg-white/15 border border-white/10 backdrop-blur-md px-5 py-2 rounded-full cursor-pointer transition-all duration-300 text-slate-300 text-xs font-semibold tracking-wide hover:-translate-y-1 hover:shadow-lg hover:shadow-white/5">
                 {topic}
               </div>
             ))}
          </div>
        </div>

        {/* Edge to Edge Visualizer */}
        <div className="w-full h-24 flex items-center justify-center opacity-80 mix-blend-screen px-10">
           <AudioVisualizer isActive={isActive} isSpeaking={isSpeaking} volume={volume} color={selectedChar.baseColorHex} />
        </div>
      </div>
    </div>
  );
};

export default App;