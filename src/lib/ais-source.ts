import { createServerFn } from "@tanstack/react-start";
import { haversineKm } from "./survey";
import {
  applyVesselFinderDetail,
  mergeTargets,
  openWatersCredit,
  parseOpenWaters,
  parseVesselFinderMap,
  type AisTarget,
} from "./ais";

export type AisQuery = { lat: number; lng: number; km: number };
export type AisResult = { ok: true; ships: AisTarget[]; credit: string } | { ok: false; error: string };

const detailCache = new Map<string, { at: number; detail: Record<string, unknown> | null }>();

function box(lat: number, lng: number, km: number) {
  const span = Math.min(80, Math.max(5, km));
  const dLat = span / 110.574;
  const dLng = span / (111.32 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    minLat: Math.max(-90, lat - dLat),
    maxLat: Math.min(90, lat + dLat),
    minLng: Math.max(-180, lng - dLng),
    maxLng: Math.min(180, lng + dLng),
  };
}

async function vesselFinderShips(lat: number, lng: number, km: number): Promise<AisTarget[]> {
  const area = box(lat, lng, km);
  const bbox = [area.minLng, area.minLat, area.maxLng, area.maxLat].map((value) => Math.round(value * 600000)).join(",");
  const response = await fetch(
    `https://www.vesselfinder.com/api/pub/mp2?bbox=${bbox}&zoom=11&mmsi=0&mcbe=1`,
    { headers: { Referer: "https://www.vesselfinder.com/", Accept: "*/*", "User-Agent": "Mozilla/5.0" } },
  );
  if (!response.ok) return [];
  const ships = parseVesselFinderMap(await response.arrayBuffer())
    .filter((ship) => haversineKm(lat, lng, ship.lat, ship.lng) <= km)
    .sort((a, b) => haversineKm(lat, lng, a.lat, a.lng) - haversineKm(lat, lng, b.lat, b.lng))
    .slice(0, 80);
  const detailed = ships.slice(0, 16);
  await Promise.all(detailed.map(async (ship, index) => {
    const detail = await vesselFinderDetail(ship.mmsi);
    if (detail) detailed[index] = applyVesselFinderDetail(ship, detail);
  }));
  return [...detailed, ...ships.slice(16)];
}

async function vesselFinderDetail(mmsi: string): Promise<Record<string, unknown> | null> {
  const cached = detailCache.get(mmsi);
  if (cached && Date.now() - cached.at < (cached.detail ? 5 * 60_000 : 30_000)) return cached.detail;
  try {
    const response = await fetch(`https://www.vesselfinder.com/api/pub/click/${encodeURIComponent(mmsi)}`, {
      headers: { Referer: "https://www.vesselfinder.com/", Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    });
    if (!response.ok) {
      detailCache.set(mmsi, { at: Date.now(), detail: null });
      return null;
    }
    const detail = (await response.json()) as Record<string, unknown>;
    detailCache.set(mmsi, { at: Date.now(), detail });
    return detail;
  } catch {
    return null;
  }
}

async function openWatersShips(lat: number, lng: number, km: number): Promise<{ ships: AisTarget[]; credit: string }> {
  const area = box(lat, lng, km);
  const url =
    `https://ais.openwaters.io/v1/vessels?bbox=` +
    `${area.minLat.toFixed(4)},${area.minLng.toFixed(4)},${area.maxLat.toFixed(4)},${area.maxLng.toFixed(4)}`;
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "AmaqDhiQar/1.0" } });
  if (!response.ok) return { ships: [], credit: "" };
  const payload = (await response.json()) as unknown;
  const ships = parseOpenWaters(payload).filter((ship) => haversineKm(lat, lng, ship.lat, ship.lng) <= km);
  return { ships, credit: openWatersCredit(payload) };
}

export const getNearbyAis = createServerFn({ method: "POST" })
  .validator((data: AisQuery) => data)
  .handler(async ({ data }): Promise<AisResult> => {
    if (!Number.isFinite(data.lat) || !Number.isFinite(data.lng)) return { ok: false, error: "No own-ship position yet." };
    const km = Math.min(80, Math.max(5, data.km));
    const [finder, waters] = await Promise.all([
      vesselFinderShips(data.lat, data.lng, km).catch(() => [] as AisTarget[]),
      openWatersShips(data.lat, data.lng, km).catch(() => ({ ships: [] as AisTarget[], credit: "" })),
    ]);
    if (!finder.length && !waters.ships.length) return { ok: false, error: "Could not load targets from VesselFinder." };
    const ships = mergeTargets(finder, waters.ships)
      .sort((a, b) => haversineKm(data.lat, data.lng, a.lat, a.lng) - haversineKm(data.lat, data.lng, b.lat, b.lng))
      .slice(0, 80);
    const credit = ["VesselFinder", waters.credit].filter(Boolean).join(" · ");
    return { ok: true, ships, credit };
  });
