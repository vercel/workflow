'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import createGlobe, { type COBEOptions } from 'cobe';

interface GlobeProps {
  className?: string;
}

export function Globe({ className }: GlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pointerInteracting = useRef<number | null>(null);
  const pointerInteractionMovement = useRef(0);
  const [size, setSize] = useState(1200);

  const updatePointerInteraction = useCallback((value: number | null) => {
    pointerInteracting.current = value;
    if (canvasRef.current) {
      canvasRef.current.style.cursor = value !== null ? 'grabbing' : 'grab';
    }
  }, []);

  const updateMovement = useCallback((clientX: number) => {
    if (pointerInteracting.current !== null) {
      const delta = clientX - pointerInteracting.current;
      pointerInteractionMovement.current = delta;
      pointerInteracting.current = clientX;
    }
  }, []);

  // Track container width
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const width = containerRef.current.offsetWidth;
        setSize(width);
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  useEffect(() => {
    if (!canvasRef.current || size === 0) return;

    let phi = 0;
    const canvasSize = size * 2; // For retina displays

    const globeConfig: COBEOptions = {
      devicePixelRatio: 2,
      width: canvasSize,
      height: canvasSize,
      phi: 0,
      theta: 0.3,
      dark: 1,
      diffuse: 3,
      mapSamples: 16000,
      mapBrightness: 1.2,
      baseColor: [0.4, 0.4, 0.4],
      markerColor: [0.251, 0.678, 1],
      glowColor: [0.1, 0.1, 0.1],
      markers: [],
      onRender: (state) => {
        if (pointerInteracting.current === null) {
          phi += 0.003;
        }
        phi += pointerInteractionMovement.current * 0.01;
        pointerInteractionMovement.current *= 0.95;

        state.phi = phi;
        state.width = canvasSize;
        state.height = canvasSize;
      },
    };

    const globe = createGlobe(canvasRef.current, globeConfig);

    setTimeout(() => {
      if (canvasRef.current) {
        canvasRef.current.style.opacity = '1';
      }
    }, 100);

    return () => {
      globe.destroy();
    };
  }, [size]);

  return (
    <div ref={containerRef} className={className} style={{ aspectRatio: '1' }}>
      <canvas
        ref={canvasRef}
        className="w-full h-full opacity-0 transition-opacity duration-500 cursor-grab"
        onPointerDown={(e) => {
          updatePointerInteraction(e.clientX);
        }}
        onPointerUp={() => {
          updatePointerInteraction(null);
        }}
        onPointerOut={() => {
          updatePointerInteraction(null);
        }}
        onMouseMove={(e) => {
          updateMovement(e.clientX);
        }}
        onTouchMove={(e) => {
          if (e.touches[0]) {
            updateMovement(e.touches[0].clientX);
          }
        }}
      />
    </div>
  );
}
