import { useEffect, useState } from "react";
import { Radio, RefreshCw, X } from "lucide-react";
import { getNavtex, type NavtexFeed } from "@/lib/navtex";

const REFRESH_MS = 5 * 60 * 1000;

export function NavtexPanel({ visible, onHide }: { visible: boolean; onHide: () => void }) {
  const [feed, setFeed] = useState<NavtexFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let stop = false;
    const load = (force: boolean) => {
      setLoading(true);
      void getNavtex({ data: { force } })
        .then((next) => {
          if (stop) return;
          setFeed(next);
          setError(null);
        })
        .catch(() => {
          if (!stop) setError("تعذر جلب رسائل النافتكس الآن.");
        })
        .finally(() => {
          if (!stop) setLoading(false);
        });
    };
    load(refresh > 0);
    const timer = window.setInterval(() => load(true), REFRESH_MS);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [visible, refresh]);

  const updated = feed
    ? new Date(feed.fetchedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <section
      id="navtex-window"
      aria-label="رسائل النافتكس"
      aria-hidden={!visible}
      dir="rtl"
      className={`absolute top-16 right-14 z-[1100] flex max-h-[min(34rem,calc(100%-6rem))] w-[min(24rem,calc(100%-1rem))] flex-col overflow-hidden rounded-xl border border-line bg-surface/95 text-right shadow-xl backdrop-blur ${visible ? "" : "hidden"}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
        <Radio className="size-4 shrink-0 text-accent" aria-hidden="true" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-xs font-semibold">نافتكس · NAVAREA IX</p>
          <p className="truncate text-[10px] text-muted">{loading ? "جارٍ التحديث…" : updated ? `آخر تحديث ${updated}` : "تحديث كل ٥ دقائق"}</p>
        </div>
        <button
          type="button"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={loading}
          aria-label="تحديث رسائل النافتكس"
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
        </button>
        <button type="button" onClick={onHide} aria-label="إخفاء النافتكس" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {error ? <p className="rounded-lg border border-alert-border bg-alert-bg px-2 py-1.5 text-xs text-alert-fg">{error}</p> : null}
        {!feed && !error ? <p className="px-1 text-xs text-muted">جارٍ قراءة التحذيرات…</p> : null}
        {feed?.messages.map((message) => {
          const open = openId === message.id;
          return (
            <article key={message.id} className="rounded-lg border border-line bg-surface-2 px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-xs font-semibold text-accent" dir="ltr">{message.number || "NAVAREA IX"}</p>
                <p className="text-[10px] text-muted" dir="ltr">{message.time}</p>
              </div>
              <p className="mt-1 text-sm leading-6 text-fg">{message.arabic}</p>
              {message.title ? <p className="mt-0.5 text-[11px] leading-4 text-muted" dir="ltr">{message.title}</p> : null}
              <div className="mt-1.5 flex items-center gap-2">
                <button type="button" onClick={() => setOpenId(open ? null : message.id)} className="text-[11px] font-medium text-sand">
                  {open ? "إخفاء النص" : "النص الرسمي"}
                </button>
                <a href={message.href} target="_blank" rel="noreferrer" className="text-[11px] text-muted underline">
                  المصدر
                </a>
              </div>
              {open ? (
                <p className="mt-1.5 whitespace-pre-wrap text-left font-mono text-[10px] leading-4 text-muted" dir="ltr">
                  {message.body}
                </p>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
