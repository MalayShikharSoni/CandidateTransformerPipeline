import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { usePrefersReducedMotion } from "../lib/useHealth";

const GLYPHS = "ABCDEFGHKLMNPRSTUVXYZ0123456789#%&$";
const DURATION = 800;

/**
 * "Decrypted text": on start, letters cycle through random glyphs and settle
 * left to right over 800 ms. Spaces and dots stay put so the shape holds.
 */
export function useDecrypt(text: string, { autoStart = false } = {}) {
  const reduce = usePrefersReducedMotion();
  // null = not scrambling, show the real text.
  const [scrambled, setScrambled] = useState<string | null>(null);
  const frame = useRef<number | null>(null);
  const startedAt = useRef(0);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const start = useCallback(() => {
    if (reduce || frame.current !== null) return;
    startedAt.current = performance.now();
    const step = (now: number) => {
      const elapsed = now - startedAt.current;
      if (elapsed >= DURATION) {
        setScrambled(null);
        frame.current = null;
        return;
      }
      const reveal = Math.floor((elapsed / DURATION) * text.length);
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        out += i < reveal || c === " " || c === "." ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
      setScrambled(out);
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [reduce, text]);

  useEffect(() => {
    if (autoStart) start();
    return stop;
  }, [autoStart, start, stop]);

  return { shown: scrambled ?? text, start };
}

/** Decrypting text whose letters also tilt up one by one under the cursor. */
export function DecryptLetters({ text, autoStart = false }: { text: string; autoStart?: boolean }) {
  const { shown, start } = useDecrypt(text, { autoStart });
  return (
    <span onMouseEnter={start}>
      <span className="sr-only">{text}</span>
      {shown.split("").map((c, i) => (
        <span key={i} className="ltr" aria-hidden="true">
          {c}
        </span>
      ))}
    </span>
  );
}

/** Thin letters that gain weight one after another on hover. */
export function WaveText({ text, style, className = "" }: { text: string; style?: CSSProperties; className?: string }) {
  return (
    <span className={`wave ${className}`} style={style}>
      <span className="sr-only">{text}</span>
      {text.split("").map((c, i) => (
        <span key={i} className="wv" style={{ transitionDelay: `${i * 35}ms` }} aria-hidden="true">
          {c}
        </span>
      ))}
    </span>
  );
}
