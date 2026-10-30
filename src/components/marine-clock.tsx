import { useEffect, useRef, useState } from "react";
import { Anchor, Move, X } from "lucide-react";

const localTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Baghdad", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const utcTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const localDate = new Intl.DateTimeFormat("ar-IQ", {
  timeZone: "Asia/Baghdad", weekday: "long", year: "numeric", month: "long", day: "numeric",
});
const utcDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
});

export function MarineClock({ visible, onHide }: { visible: boolean; onHide: () => void }) {
  const [now, setNow] = useState<number | null>(null);
  const [position, setPosition] = useState({ x: 580, y: 12 });
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);

  useEffect(() => {
    if (!visible) return;
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const panel = panelRef.current;
    const bounds = panel?.parentElement;
    if (!panel || !bounds) return;
    const constrain = () => setPosition((current) => ({
      x: Math.max(0, Math.min(current.x, bounds.clientWidth - panel.offsetWidth)),
      y: Math.max(0, Math.min(current.y, bounds.clientHeight - panel.offsetHeight)),
    }));
    const observer = new ResizeObserver(constrain);
    observer.observe(bounds);
    observer.observe(panel);
    constrain();
    return () => observer.disconnect();
  }, [visible]);

  const time = now == null ? "--:--:--" : localTime.format(now);
  const [hours, minutes, seconds] = time.split(":").map(Number);
  const ready = now != null;
  const hourAngle = ready ? (hours % 12) * 30 + minutes * 0.5 + seconds / 120 : 0;
  const minuteAngle = ready ? minutes * 6 + seconds * 0.1 : 0;
  const secondAngle = ready ? seconds * 6 : 0;

  return (
    <section
      ref={panelRef}
      id="marine-clock-window"
      aria-label="الساعة البحرية"
      aria-hidden={!visible}
      className={`absolute z-[1100] ${visible ? "flex" : "hidden"} max-h-[calc(100%-1rem)] w-64 max-w-[calc(100%-1rem)] flex-col overflow-auto rounded-xl border border-line bg-surface/95 shadow-xl backdrop-blur`}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="flex h-8 shrink-0 touch-none cursor-move select-none items-center gap-1.5 rounded-t-xl border-b border-line px-2"
        title="اسحب لتحريك الساعة البحرية"
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
          dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: position.x, top: position.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const panel = panelRef.current;
          const bounds = panel?.parentElement;
          if (!drag || drag.pointerId !== event.pointerId || !panel || !bounds) return;
          setPosition({
            x: Math.max(0, Math.min(bounds.clientWidth - panel.offsetWidth, drag.left + event.clientX - drag.x)),
            y: Math.max(0, Math.min(bounds.clientHeight - panel.offsetHeight, drag.top + event.clientY - drag.y)),
          });
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <Move className="size-3 text-muted" aria-hidden="true" />
        <span className="flex-1 text-[11px] font-semibold" dir="rtl">ساعة بحرية</span>
        <button type="button" onClick={onHide} aria-label="إخفاء الساعة البحرية" className="grid size-6 place-items-center rounded text-muted hover:bg-surface-2 hover:text-fg">
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="p-3">
        <div className="relative mx-auto size-48 text-accent">
          <svg viewBox="0 0 200 200" className="size-full" aria-hidden="true">
            <circle cx="100" cy="100" r="97" className="fill-bg" stroke="currentColor" strokeWidth="2" />
            <circle cx="100" cy="100" r="91" fill="none" stroke="currentColor" strokeOpacity="0.25" />
            {Array.from({ length: 60 }, (_, index) => (
              <line key={index} x1="100" y1="12" x2="100" y2={index % 5 === 0 ? "23" : "17"}
                transform={`rotate(${index * 6} 100 100)`} stroke="currentColor"
                strokeWidth={index % 5 === 0 ? 2 : 1} strokeOpacity={index % 5 === 0 ? 1 : 0.4} />
            ))}
            {Array.from({ length: 12 }, (_, index) => {
              const angle = (index + 1) * Math.PI / 6;
              return <text key={index} x={100 + Math.sin(angle) * 66} y={100 - Math.cos(angle) * 66}
                textAnchor="middle" dominantBaseline="central" className="fill-fg text-[14px] font-semibold">{index + 1}</text>;
            })}
            <text x="100" y="137" textAnchor="middle" className="fill-muted text-[8px] tracking-[2px]">MARINE 360</text>
            <line x1="100" y1="108" x2="100" y2="57" transform={`rotate(${hourAngle} 100 100)`} className="stroke-fg" strokeWidth="5" strokeLinecap="round" />
            <line x1="100" y1="110" x2="100" y2="34" transform={`rotate(${minuteAngle} 100 100)`} className="stroke-fg" strokeWidth="3" strokeLinecap="round" />
            <line x1="100" y1="115" x2="100" y2="26" transform={`rotate(${secondAngle} 100 100)`} stroke="#ed765e" strokeWidth="1.5" />
            <circle cx="100" cy="100" r="4" fill="currentColor" />
          </svg>
          <Anchor className="absolute left-1/2 top-[53px] size-4 -translate-x-1/2 text-accent/60" aria-hidden="true" />
        </div>
        <div className="mt-2 rounded-lg border border-line bg-bg p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted" dir="ltr">Basra <bdi>UTC+3</bdi></span>
            <time aria-label="توقيت البصرة" dateTime={ready ? new Date(now).toISOString() : undefined} className="font-mono text-xl font-semibold tabular-nums text-fg" dir="ltr">{time}</time>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 border-t border-line pt-1">
            <span className="text-[11px] font-semibold text-accent">UTC</span>
            <time aria-label="توقيت UTC" dateTime={ready ? new Date(now).toISOString() : undefined} className="font-mono text-base tabular-nums text-accent" dir="ltr">{ready ? utcTime.format(now) : "--:--:--"}</time>
          </div>
          <p className="mt-0.5 text-right font-mono text-[10px] text-muted" dir="ltr">{ready ? utcDate.format(now) : "—"} UTC</p>
        </div>
        <p className="mt-2 text-center text-[11px] text-muted" dir="rtl">{ready ? localDate.format(now) : "—"}</p>
        <p className="mt-0.5 text-center text-[10px] text-muted" dir="rtl">المصدر: ساعة الجهاز</p>
      </div>
    </section>
  );
}
