export type Survey = {
  name: string;
  lon0: number;
  lat0: number;
  mPerLon: number;
  mPerLat: number;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  west: number;
  east: number;
  south: number;
  north: number;
  minDepth: number;
  maxDepth: number;
  pointCount: number;
  depths: (number | null)[];
};

export type Sample = {
  depth: number | null;
  x: number;
  y: number;
};

const STOPS: { t: number; rgb: [number, number, number] }[] = [
  { t: -14.5, rgb: [2, 10, 64] },
  { t: -12, rgb: [0, 48, 214] },
  { t: -10, rgb: [0, 148, 255] },
  { t: -8, rgb: [0, 196, 176] },
  { t: -6, rgb: [36, 196, 58] },
  { t: -4, rgb: [232, 206, 16] },
  { t: -2, rgb: [246, 132, 8] },
  { t: 0, rgb: [214, 36, 28] },
  { t: 2.5, rgb: [150, 22, 22] },
  { t: 5.2, rgb: [255, 226, 168] },
];

export function depthRgb(depth: number): [number, number, number] {
  if (depth <= STOPS[0].t) return STOPS[0].rgb;
  const last = STOPS[STOPS.length - 1];
  if (depth >= last.t) return last.rgb;
  for (let i = 1; i < STOPS.length; i++) {
    const b = STOPS[i];
    const a = STOPS[i - 1];
    if (depth <= b.t) {
      const u = (depth - a.t) / (b.t - a.t);
      return [
        Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * u),
        Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * u),
        Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * u),
      ];
    }
  }
  return last.rgb;
}

export function depthCss(depth: number): string {
  const [r, g, b] = depthRgb(depth);
  return `rgb(${r} ${g} ${b})`;
}

export function cell(survey: Survey, i: number, j: number): number | null {
  if (i < 0 || j < 0 || i >= survey.nx || j >= survey.ny) return null;
  return survey.depths[j * survey.nx + i];
}

export function project(survey: Survey, lat: number, lng: number): { x: number; y: number } {
  return {
    x: (lng - survey.lon0) * survey.mPerLon,
    y: (lat - survey.lat0) * survey.mPerLat,
  };
}

export function unproject(survey: Survey, x: number, y: number): { lat: number; lng: number } {
  return {
    lng: survey.lon0 + x / survey.mPerLon,
    lat: survey.lat0 + y / survey.mPerLat,
  };
}

/** Nearest surveyed cell. Returns null when the click is off the survey tracks. */
export function sampleAt(survey: Survey, lat: number, lng: number): Sample {
  const { x, y } = project(survey, lat, lng);
  const fi = (x - survey.x0) / survey.dx;
  const fj = (y - survey.y0) / survey.dy;
  const i0 = Math.round(fi);
  const j0 = Math.round(fj);
  let best: { depth: number; dist: number } | null = null;
  for (let dj = -2; dj <= 2; dj++) {
    for (let di = -2; di <= 2; di++) {
      const depth = cell(survey, i0 + di, j0 + dj);
      if (depth == null) continue;
      const dist = (fi - (i0 + di)) ** 2 + (fj - (j0 + dj)) ** 2;
      if (!best || dist < best.dist) best = { depth, dist };
    }
  }
  if (!best || best.dist > 2.25) return { depth: null, x, y };
  return { depth: best.depth, x, y };
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLng = (lng2 - lng1) * p;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Point reached by travelling `distanceKm` on a bearing, degrees clockwise from north. */
export function destinationPoint(
  lat: number,
  lng: number,
  bearingDeg: number,
  distanceKm: number,
): { lat: number; lng: number } {
  const R = 6371;
  const delta = distanceKm / R;
  const theta = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(theta),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
    );
  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

export type TrackSide = "port" | "stbd" | "on track";

export type CrossTrack = {
  meters: number;
  side: TrackSide;
  lat: number;
  lng: number;
};

/** Signed cross-track error. Starboard of the line direction is stbd. */
export function crossTrack(
  ship: { lat: number; lng: number },
  line: { lat: number; lng: number }[],
): CrossTrack | null {
  if (line.length < 2) return null;
  const lngScale = 111320 * Math.cos((ship.lat * Math.PI) / 180);
  const toX = (lng: number) => (lng - ship.lng) * lngScale;
  const toY = (lat: number) => (lat - ship.lat) * 111320;
  let best = Infinity;
  let signed = 0;
  let footX = 0;
  let footY = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const ax = toX(line[i].lng);
    const ay = toY(line[i].lat);
    const bx = toX(line[i + 1].lng);
    const by = toY(line[i + 1].lat);
    const abx = bx - ax;
    const aby = by - ay;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1) continue;
    const apx = -ax;
    const apy = -ay;
    const along = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2));
    const cx = ax + abx * along;
    const cy = ay + aby * along;
    const dist = Math.hypot(cx, cy);
    if (dist < best) {
      best = dist;
      const cross = abx * apy - aby * apx;
      signed = cross >= 0 ? dist : -dist;
      footX = cx;
      footY = cy;
    }
  }
  if (!Number.isFinite(best)) return null;
  const meters = Math.abs(signed);
  return {
    meters,
    side: meters < 1 ? "on track" : signed > 0 ? "port" : "stbd",
    lat: ship.lat + footY / 111320,
    lng: ship.lng + footX / lngScale,
  };
}

const CHANNEL_RADIUS = 3;

function diskOffsets(radius: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  const limit = radius * radius;
  for (let dj = -radius; dj <= radius; dj++) {
    for (let di = -radius; di <= radius; di++) {
      if (di * di + dj * dj <= limit) offsets.push([di, dj]);
    }
  }
  return offsets;
}

/** Close gaps inside a surveyed channel. Measured cells stay exact. */
export function completeChannel(survey: Survey, radius = CHANNEL_RADIUS): Survey {
  const { nx, ny, depths } = survey;
  const offsets = diskOffsets(radius);
  const mask = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (depths[j * nx + i] == null) continue;
      for (const [di, dj] of offsets) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        mask[jj * nx + ii] = 1;
      }
    }
  }

  const knownI: number[] = [];
  const knownJ: number[] = [];
  const knownD: number[] = [];
  const buckets = new Map<string, number[]>();
  const reach = radius + 5;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const depth = depths[j * nx + i];
      if (depth == null) continue;
      const k = knownI.length;
      knownI.push(i);
      knownJ.push(j);
      knownD.push(depth);
      const key = `${Math.floor(i / reach)},${Math.floor(j / reach)}`;
      const list = buckets.get(key);
      if (list) list.push(k);
      else buckets.set(key, [k]);
    }
  }

  const next = depths.slice();
  const reach2 = reach * reach;
  let count = knownI.length;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (!mask[idx] || next[idx] != null) continue;
      let solid = true;
      for (const [di, dj] of offsets) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny || !mask[jj * nx + ii]) {
          solid = false;
          break;
        }
      }
      if (!solid) continue;
      const bi = Math.floor(i / reach);
      const bj = Math.floor(j / reach);
      let weight = 0;
      let total = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const list = buckets.get(`${bi + di},${bj + dj}`);
          if (!list) continue;
          for (const k of list) {
            const dx = knownI[k] - i;
            const dy = knownJ[k] - j;
            const dist2 = dx * dx + dy * dy;
            if (dist2 === 0 || dist2 > reach2) continue;
            const w = 1 / dist2;
            weight += w;
            total += w * knownD[k];
          }
        }
      }
      if (weight === 0) continue;
      next[idx] = total / weight;
      count += 1;
    }
  }

  return { ...survey, depths: next, pointCount: count };
}

export const LEGEND = [-12, -10, -8, -6, -4, -2, 0, 4];
