import { useEffect, useRef } from "react";
import { planets } from "./renderer";

const PX = { sm: 26, md: 34, lg: 44, xl: 72, xxl: 120 } as const;
export type PlanetSize = keyof typeof PX;

/** One animated planet. Drawn by the shared renderer; a plain canvas in the DOM. */
export function Planet({ design, size = "md", energy = 0, alert = 0, className }: { design: number; size?: PlanetSize; energy?: number; alert?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const update = useRef<((s: { design: number; energy: number; alert: number }) => void) | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = canvas.height = Math.round(PX[size] * dpr * 1.25); // the tile reaches past the orb for rings and glow
    update.current = planets.add(canvas, { design, energy, alert });
    return () => {
      planets.remove(canvas);
      update.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);
  useEffect(() => update.current?.({ design, energy, alert }), [design, energy, alert]);
  return <canvas ref={ref} className={`planet ${className ?? ""}`} aria-hidden />;
}

export const planetsSupported = () => planets.supported;
