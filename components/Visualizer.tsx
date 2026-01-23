
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  color?: string;
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive, color = '#007AFF' }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  useEffect(() => {
    if (!isActive) {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let startTime = Date.now();

    const render = () => {
      const time = (Date.now() - startTime) / 1000;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      
      const barCount = 12;
      const spacing = 4;
      const barWidth = (canvas.width - (barCount - 1) * spacing) / barCount;
      
      for (let i = 0; i < barCount; i++) {
        const height = Math.abs(Math.sin(time * 5 + i * 0.5)) * canvas.height * 0.8 + 5;
        const x = i * (barWidth + spacing);
        const y = (canvas.height - height) / 2;
        
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, height, 4);
        ctx.fill();
      }
      
      animationRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isActive, color]);

  return (
    <canvas 
      ref={canvasRef} 
      width={100} 
      height={40} 
      className="w-full h-full opacity-80"
    />
  );
};

export default Visualizer;
