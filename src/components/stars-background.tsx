import { useEffect, useRef, useState, type ComponentProps } from "react";

type Spring = { stiffness?: number; damping?: number };

type StarsBackgroundProps = ComponentProps<"div"> & {
  factor?: number;
  speed?: number;
  transition?: Spring;
  starColor?: string;
  pointerEvents?: boolean;
};

function generateStars(count: number, color: string) {
  const shadows: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = Math.floor(Math.random() * 4000) - 2000;
    const y = Math.floor(Math.random() * 4000) - 2000;
    shadows.push(`${x}px ${y}px ${color}`);
  }
  return shadows.join(", ");
}

function StarLayer({
  count,
  size,
  duration,
  color,
  paused,
}: {
  count: number;
  size: number;
  duration: number;
  color: string;
  paused: boolean;
}) {
  const [shadow, setShadow] = useState("");

  useEffect(() => {
    setShadow(generateStars(count, color));
  }, [count, color]);

  const dot = {
    width: size,
    height: size,
    boxShadow: shadow,
  };

  return (
    <div
      className={`stars-layer${paused ? " is-paused" : ""}`}
      style={{ animationDuration: `${duration}s` }}
      aria-hidden="true"
    >
      <div className="stars-dot" style={dot} />
      <div className="stars-dot stars-dot--next" style={dot} />
    </div>
  );
}

export function StarsBackground({
  className = "",
  factor = 0.05,
  speed = 50,
  transition,
  starColor = "#fff",
  pointerEvents = true,
  children,
  ...props
}: StarsBackgroundProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const skyRef = useRef<HTMLDivElement | null>(null);
  const [paused, setPaused] = useState(false);
  const stiffness = transition?.stiffness ?? 50;
  const damping = transition?.damping ?? 20;

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let offscreen = false;
    let hidden = document.hidden;
    const sync = () => setPaused(reduced || offscreen || hidden);
    sync();
    const observer = new IntersectionObserver(([entry]) => {
      offscreen = !entry.isIntersecting;
      sync();
    });
    observer.observe(node);
    const onHide = () => {
      hidden = document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  useEffect(() => {
    const sky = skyRef.current;
    const root = rootRef.current;
    const host = root?.parentElement;
    if (!sky || !host) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      sky.style.transform = "none";
      return;
    }
    const target = { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    let vx = 0;
    let vy = 0;
    let last = performance.now();
    let frame = 0;
    const shift = (event: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      target.x = -(event.clientX - (rect.left + rect.width / 2)) * factor;
      target.y = -(event.clientY - (rect.top + rect.height / 2)) * factor;
    };
    host.addEventListener("pointermove", shift);
    host.addEventListener("pointerdown", shift);
    const step = (now: number) => {
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      vx += (-stiffness * (x - target.x) - damping * vx) * dt;
      vy += (-stiffness * (y - target.y) - damping * vy) * dt;
      x += vx * dt;
      y += vy * dt;
      sky.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => {
      host.removeEventListener("pointermove", shift);
      host.removeEventListener("pointerdown", shift);
      window.cancelAnimationFrame(frame);
    };
  }, [damping, factor, stiffness]);

  return (
    <div
      ref={rootRef}
      className={`stars-bg ${className}`.trim()}
      style={{ pointerEvents: pointerEvents ? undefined : "none" }}
      {...props}
    >
      <div ref={skyRef} className="stars-sky">
        <StarLayer count={1000} size={1} duration={speed} color={starColor} paused={paused} />
        <StarLayer count={400} size={2} duration={speed * 2} color={starColor} paused={paused} />
        <StarLayer count={200} size={3} duration={speed * 3} color={starColor} paused={paused} />
      </div>
      {children}
    </div>
  );
}
