import React, { useRef, useEffect } from 'react';

interface VisualizerProps {
  isActive: boolean;
  isSpeaking: boolean;
  volume: number;
  color: string;
}

export const AudioVisualizer: React.FC<VisualizerProps> = ({ isActive, isSpeaking, volume, color }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;

    const render = () => {
      // Clear
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;

      if (!isActive) {
        // Idle state: just a small dot
        ctx.beginPath();
        ctx.arc(centerX, centerY, 10, 0, Math.PI * 2);
        ctx.fillStyle = '#cbd5e1'; // slate-300
        ctx.fill();
      } else {
        // Active state
        
        // Base Circle
        ctx.beginPath();
        // If user is speaking (volume > 5) expand based on volume
        // If Model is speaking (isSpeaking), pulse rhythmically
        let radius = 40;
        
        if (isSpeaking) {
           // Model speaking: Sine wave pulse
           radius = 40 + Math.sin(time * 0.1) * 10;
        } else {
           // User speaking: React to volume
           radius = 40 + (volume * 0.8);
        }

        // Draw Glow
        const gradient = ctx.createRadialGradient(centerX, centerY, radius * 0.5, centerX, centerY, radius * 1.5);
        gradient.addColorStop(0, color);
        gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
        
        ctx.fillStyle = gradient;
        ctx.arc(centerX, centerY, radius * 2, 0, Math.PI * 2);
        ctx.fill();

        // Draw Core
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        
        time++;
      }

      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isActive, isSpeaking, volume, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={400} 
      height={150} 
      className="w-full h-full"
    />
  );
};