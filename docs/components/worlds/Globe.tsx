'use client';

import { useCallback, useEffect, useRef } from 'react';
import createGlobe, { type COBEOptions } from 'cobe';

interface GlobeProps {
  className?: string;
}

export function Globe({ className }: GlobeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointerInteracting = useRef<number | null>(null);
  const pointerInteractionMovement = useRef(0);

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

  useEffect(() => {
    let phi = 0;
    let width = 0;

    const onResize = () => {
      if (canvasRef.current) {
        width = canvasRef.current.offsetWidth;
      }
    };
    window.addEventListener('resize', onResize);
    onResize();

    const globeConfig: COBEOptions = {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
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
        state.width = width * 2;
        state.height = width * 2;
      },
    };

    const globe = createGlobe(canvasRef.current!, globeConfig);

    setTimeout(() => {
      if (canvasRef.current) {
        canvasRef.current.style.opacity = '1';
      }
    }, 100);

    return () => {
      globe.destroy();
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return (
    <div className={className}>
      <canvas
        ref={canvasRef}
        className="w-full h-full opacity-0 transition-opacity duration-500 cursor-grab"
        style={{
          contain: 'layout paint size',
          aspectRatio: '1',
        }}
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
