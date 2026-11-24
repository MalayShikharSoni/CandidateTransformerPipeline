import { useEffect, useRef, useState, type MouseEvent } from "react";
import { portrait } from "../art/portrait";
import { usePrefersReducedMotion } from "../lib/useHealth";
import "./ascii-hero.css";

const STAGE_W = 620;
const STAGE_H = 640;
const TICK_MS = 140;
const REST = { x: 310, y: 250 };

/**
 * FIG.01: three sources converge on one profile. The art is a fixed 620x640
 * stage scaled to whatever width its column has, so it can sit beside the
 * headline at any desktop width. It stops redrawing when off screen, when the
 * tab is hidden, or when the viewer prefers reduced motion.
 */
export function AsciiHero() {
  const reduce = usePrefersReducedMotion();
  const boxRef = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  const [scale, setScale] = useState(1);
  const [visible, setVisible] = useState(true);
  const [cursor, setCursor] = useState(REST);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setScale(Math.min(1, box.clientWidth / STAGE_W)));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (box === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (reduce || !visible) return;
    let timer: number | undefined;
    const run = () => {
      if (timer === undefined && document.visibilityState === "visible") {
        timer = window.setInterval(() => setTick((t) => t + 1), TICK_MS);
      }
    };
    const pause = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? run() : pause());
    run();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      pause();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [reduce, visible]);

  const onMove = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setCursor({
      x: Math.round((event.clientX - rect.left) / scale),
      y: Math.round((event.clientY - rect.top) / scale),
    });
  };

  return (
    <figure className="hero-fig">
      <div ref={boxRef} className="hero-fig-box" style={{ height: Math.round(STAGE_H * scale) + 2 }}>
        <div
          className="hero-stage"
          style={{ transform: `scale(${scale})` }}
          onMouseMove={onMove}
          onMouseLeave={() => setCursor(REST)}
        >
          <pre className="hero-ascii" aria-hidden="true">
            {portrait(tick)}
          </pre>

          <svg className="hero-lines" width={STAGE_W} height={STAGE_H} viewBox={`0 0 ${STAGE_W} ${STAGE_H}`} aria-hidden="true">
            <g stroke="#13D17C" strokeWidth="1" fill="none">
              {["M 284 214", "M 388 316", "M 300 432", "M 470 478"].map((start) => (
                <path key={start} className="flow" d={`${start} L 596 30`} strokeDasharray="3 5" />
              ))}
            </g>
            <g stroke="#111111" strokeWidth="1" fill="none">
              <circle cx="596" cy="30" r="9" />
              <line x1="582" y1="30" x2="610" y2="30" />
              <line x1="596" y1="16" x2="596" y2="44" />
            </g>
            <g stroke="#111111" strokeWidth="1.5" fill="none">
              <path d="M 8 20 L 8 8 L 20 8" />
              <path d="M 600 632 L 612 632 L 612 620" />
              <path d="M 8 620 L 8 632 L 20 632" />
            </g>
          </svg>

          <span className="anno-fill pulse" style={{ left: 262, top: 196, width: 22, height: 22 }} />
          <span className="anno-label" style={{ left: 236, top: 222 }}>FL.EMAILS</span>
          <span className="anno-fill" style={{ left: 358, top: 286, width: 30, height: 30 }} />
          <span className="anno-label" style={{ left: 394, top: 296 }}>FL.EXPERIENCE</span>
          <span className="anno-box" style={{ left: 120, top: 432, width: 180, height: 150 }} />
          <span className="anno-label" style={{ left: 124, top: 436 }}>PW.PROVENANCE</span>
          <span className="anno-box" style={{ left: 462, top: 470, width: 16, height: 16 }} />
          <span className="anno-label" style={{ left: 484, top: 472 }}>FL.SKILLS</span>

          <span className="src-tag" style={{ left: 18, top: 16 }}>SRC.01 ── CSV<br />w = 0.9</span>
          <span className="src-tag" style={{ left: 18, bottom: 54 }}>SRC.03 ── RESUME<br />w = 0.8 / 0.5</span>
          <span className="src-tag" style={{ right: 18, bottom: 54, textAlign: "right" }}>SRC.02 ── GITHUB<br />w = 0.6</span>
          <span className="out-tag">OUT {"}"} canonical.json<br />NO.∞</span>

          <span className="cross-h" style={{ top: cursor.y }} aria-hidden="true" />
          <span className="cross-v" style={{ left: cursor.x }} aria-hidden="true" />
          <span className="cross-read" style={{ left: Math.min(cursor.x + 10, 520), top: Math.max(cursor.y - 22, 4) }} aria-hidden="true">
            X {cursor.x} · Y {cursor.y}
          </span>

          <span className="fig-foot">
            <span>FIG.01 — three sources converge on one profile</span>
            <span>FRAME {String(tick).padStart(5, "0")}</span>
          </span>
        </div>
      </div>
      <figcaption className="sr-only">
        An animated ASCII portrait. Particles from three source tags, CSV, resume and GitHub, flow into one figure.
      </figcaption>
    </figure>
  );
}
