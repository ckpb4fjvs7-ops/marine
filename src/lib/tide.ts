export type TideTurn = { min: number; h: number; kind: "high" | "low" };

export type UmmTideView = {
  phase: "Flood" | "Ebb";
  remain: string;
  highTime: string;
  lowTime: string;
};

/** Tide turning points from the Umm Qasr page chart. First point is yesterday, last is tomorrow. */
export function parseUmmQasrPage(html: string): TideTurn[] | null {
  const found = new Map<number, { clock: number; h: number }>();
  const re = /gm\.mareas_x\[(\d+)\]\s*=\s*(-?\d+(?:\.\d+)?)\s*;\s*gm\.mareas_y\[\1\]\s*=\s*(-?\d+(?:\.\d+)?)/g;
  for (const match of html.matchAll(re)) {
    found.set(Number(match[1]), { clock: Number(match[2]), h: Number(match[3]) });
  }
  const indexes = [...found.keys()].sort((a, b) => a - b);
  if (indexes.length < 3) return null;
  const last = indexes.length - 1;
  const points = indexes.map((index, order) => {
    const item = found.get(index)!;
    const day = order === 0 ? -1440 : order === last ? 1440 : 0;
    return { min: item.clock + day, h: item.h };
  });
  points.sort((a, b) => a.min - b.min);
  return points.map((point, index) => ({ ...point, kind: turnKind(points, index) }));
}

function turnKind(points: { h: number }[], index: number): "high" | "low" {
  const height = points[index].h;
  const before = points[index - 1]?.h;
  const after = points[index + 1]?.h;
  if (before == null) return height >= after ? "high" : "low";
  if (after == null) return height >= before ? "high" : "low";
  if (height >= before && height >= after) return "high";
  if (height <= before && height <= after) return "low";
  return height >= before ? "high" : "low";
}

export function baghdadMinutes(now = Date.now()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Baghdad",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return ((hour % 24) * 60 + minute) % 1440;
}

export function formatClock(min: number): string {
  const wrapped = ((Math.round(min) % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatRemain(mins: number): string {
  const total = Math.max(0, Math.round(mins));
  const hour = Math.floor(total / 60);
  const minute = total % 60;
  if (hour <= 0) return `${minute}m`;
  if (minute === 0) return `${hour}h`;
  return `${hour}h ${minute}m`;
}

export function describeUmmTide(turns: TideTurn[], now = Date.now()): UmmTideView | null {
  if (turns.length < 2) return null;
  const minute = baghdadMinutes(now);
  let prev = turns[0];
  let next = turns[turns.length - 1];
  for (let i = 0; i < turns.length - 1; i += 1) {
    if (turns[i].min <= minute && turns[i + 1].min > minute) {
      prev = turns[i];
      next = turns[i + 1];
      break;
    }
  }
  const today = turns.filter((turn) => turn.min >= 0 && turn.min < 1440);
  const highs = today.filter((turn) => turn.kind === "high");
  const lows = today.filter((turn) => turn.kind === "low");
  const high = highs.reduce<(typeof highs)[number] | null>((best, turn) => (!best || turn.h > best.h ? turn : best), null);
  const low = lows.reduce<(typeof lows)[number] | null>((best, turn) => (!best || turn.h < best.h ? turn : best), null);
  return {
    phase: next.h >= prev.h ? "Flood" : "Ebb",
    remain: formatRemain(next.min - minute),
    highTime: high ? formatClock(high.min) : "—",
    lowTime: low ? formatClock(low.min) : "—",
  };
}
