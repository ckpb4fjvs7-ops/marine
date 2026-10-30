import { createServerFn } from "@tanstack/react-start";

let lastSent = 0;

export const notifyAnchorBreach = createServerFn({ method: "POST" })
  .validator((data: { meters?: number; limit?: number; ship?: string }) => data ?? {})
  .handler(async ({ data }) => {
    const now = Date.now();
    if (now - lastSent < 60_000) return { ok: true, skipped: true };
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
    if (!token || !chatId) return { ok: false, skipped: true };
    const ship = String(data.ship || "السفينة").replace(/\s+/g, " ").trim().slice(0, 40) || "السفينة";
    const meters = Number.isFinite(data.meters) ? Math.round(Number(data.meters)) : null;
    const limit = Number.isFinite(data.limit) ? Math.round(Number(data.limit)) : null;
    const text = [
      "تنبيه مرساة",
      `السفينة: ${ship}`,
      "خرجت من دائرة المراقبة.",
      meters == null ? "" : `البعد: ${meters} م`,
      limit == null ? "" : `حد الدائرة: ${limit} م`,
    ].filter(Boolean).join("\n");
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!response.ok) return { ok: false, skipped: false };
    lastSent = now;
    return { ok: true, skipped: false };
  });
