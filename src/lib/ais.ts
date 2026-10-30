export type AisTarget = {
  id: string;
  name: string;
  mmsi: string;
  imo: string;
  callsign: string;
  flag: string;
  type: string;
  typeCode: number | null;
  status: string;
  lat: number;
  lng: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  destination: string;
  eta: string;
  draught: number | null;
  length: number | null;
  width: number | null;
  seen: string;
  color: string;
};

const STATUS: Record<number, string> = {
  0: "Under way using engine",
  1: "At anchor",
  2: "Not under command",
  3: "Restricted manoeuvrability",
  4: "Constrained by draught",
  5: "Moored",
  6: "Aground",
  7: "Engaged in fishing",
  8: "Under way sailing",
  9: "Reserved (HSC)",
  10: "Reserved (WIG)",
  11: "Towing astern",
  12: "Pushing or towing alongside",
  13: "Reserved",
  14: "AIS-SART",
  15: "Not defined",
};

function text(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function num(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function typeName(code: number | null): string {
  if (code == null) return "Unknown";
  const named: Record<number, string> = {
    30: "Fishing",
    31: "Towing",
    32: "Towing, large",
    33: "Dredging",
    34: "Diving",
    35: "Military",
    36: "Sailing",
    37: "Pleasure craft",
    50: "Pilot",
    51: "Search and rescue",
    52: "Tug",
    53: "Port tender",
    55: "Law enforcement",
    60: "Passenger",
    70: "Cargo",
    80: "Tanker",
    90: "Other",
  };
  if (named[code]) return named[code];
  const group: Record<number, string> = {
    2: "WIG",
    3: "Special craft",
    4: "HSC",
    5: "Special craft",
    6: "Passenger",
    7: "Cargo",
    8: "Tanker",
    9: "Other",
  };
  return group[Math.floor(code / 10)] ?? `Type ${code}`;
}

function typeColor(code: number | null): string {
  if (code == null) return "#087f83";
  if (code >= 30 && code < 40) return "#995b08";
  const group = Math.floor(code / 10);
  if (group === 7) return "#006d91";
  if (group === 8) return "#b63536";
  if (group === 6) return "#257149";
  return "#087f83";
}

function seenLabel(raw: string): string {
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw || "—";
  const min = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (min < 1) return "now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ago`;
}

function asFeatures(payload: unknown): { lon: number; lat: number; props: Record<string, unknown> }[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { features?: unknown }).features)) return [];
  return (payload as { features: { geometry?: { coordinates?: unknown }; properties?: unknown }[] }).features.flatMap((feature) => {
    const coords = feature.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return [];
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const props = feature.properties && typeof feature.properties === "object" ? (feature.properties as Record<string, unknown>) : {};
    return [{ lon, lat, props }];
  });
}

export function parseOpenWaters(payload: unknown): AisTarget[] {
  return asFeatures(payload).flatMap(({ lon, lat, props }) => {
    const kind = text(props.kind);
    if (kind === "base" || kind === "gear") return [];
    const typeCode = num(props.type);
    const sog = num(props.sog);
    const cog = num(props.cog);
    const heading = num(props.heading);
    const statusCode = num(props.nav_status);
    const mmsi = text(props.mmsi);
    const name = text(props.name) || (mmsi ? `MMSI ${mmsi}` : kind === "aton" ? "AtoN" : "Unnamed target");
    return [
      {
        id: mmsi || `${lat.toFixed(5)},${lon.toFixed(5)}`,
        name,
        mmsi,
        imo: text(props.imo),
        callsign: text(props.callsign),
        flag: text(props.flag),
        type: kind === "aton" ? "AtoN" : typeName(typeCode),
        typeCode,
        status: statusCode == null ? "" : (STATUS[statusCode] ?? `Status ${statusCode}`),
        lat,
        lng: lon,
        sog: sog == null || sog >= 102 ? null : sog,
        cog: cog == null || cog >= 360 ? null : cog,
        heading: heading == null || heading < 0 || heading > 359 ? null : heading,
        destination: text(props.destination),
        eta: text(props.eta),
        draught: num(props.draught),
        length: num(props.length),
        width: num(props.beam),
        seen: seenLabel(text(props.seen)),
        color: kind === "aton" ? "#087f83" : typeColor(typeCode),
      },
    ];
  });
}

export function parseVesselFinderMap(buffer: ArrayBuffer): AisTarget[] {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint8(0) !== 0x43) return [];
  let offset = 4 + view.getUint8(2);
  if (offset > view.byteLength) return [];
  const ships: AisTarget[] = [];
  while (offset + 15 <= view.byteLength) {
    const flags = view.getUint16(offset);
    offset += 2;
    const mmsi = view.getInt32(offset);
    offset += 4;
    const lat = view.getInt32(offset) / 600000;
    offset += 4;
    const lng = view.getInt32(offset) / 600000;
    offset += 4;
    if (offset + 2 > view.byteLength) break;
    offset += 1;
    const nameLength = view.getUint8(offset);
    offset += 1;
    if (offset + nameLength > view.byteLength) break;
    const rawName = new TextDecoder("utf-8").decode(new Uint8Array(buffer, offset, nameLength)).trim();
    offset += nameLength;
    // Bit 1 marks a short trailer after the name. Skipping it keeps the next record aligned.
    if ((flags & 2) !== 0) {
      if (offset + 2 > view.byteLength) break;
      offset += 2;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || mmsi <= 0) {
      continue;
    }
    const id = String(mmsi);
    ships.push({
      id,
      name: rawName || `MMSI ${id}`,
      mmsi: id,
      imo: "",
      callsign: "",
      flag: "",
      type: "Unknown",
      typeCode: null,
      status: "",
      lat,
      lng,
      sog: null,
      cog: null,
      heading: null,
      destination: "",
      eta: "",
      draught: null,
      length: null,
      width: null,
      seen: "—",
      color: "#087f83",
    });
  }
  return ships;
}

export function applyVesselFinderDetail(ship: AisTarget, detail: Record<string, unknown>): AisTarget {
  const statusCode = num(detail[".ns"]);
  const draughtRaw = num(detail.draught);
  const draughtMax = num(detail.drm);
  const draught = draughtRaw != null && draughtRaw > 0 ? draughtRaw / 10 : draughtMax;
  const type = text(detail.type);
  const etaSec = num(detail.etaTS);
  return {
    ...ship,
    name: text(detail.name) || ship.name,
    imo: text(detail.imo && Number(detail.imo) > 0 ? detail.imo : ""),
    flag: text(detail.country) || ship.flag,
    type: type || ship.type,
    status: statusCode == null || statusCode < 0 ? ship.status : (STATUS[statusCode] ?? `Status ${statusCode}`),
    sog: num(detail.ss) ?? ship.sog,
    cog: num(detail.cu) ?? ship.cog,
    destination: text(detail.dest).replace(/_+/g, " ").trim() || ship.destination,
    eta: etaSec && etaSec > 0 ? formatBaghdad(etaSec) : ship.eta,
    draught: draught != null && draught > 0 && draught < 30 ? draught : ship.draught,
    length: num(detail.al) ?? ship.length,
    width: num(detail.aw) ?? ship.width,
    seen: seenFromUnix(num(detail.ts) ?? 0) || ship.seen,
    color: colorFromType(type) || ship.color,
  };
}

function colorFromType(type: string): string {
  const name = type.toLowerCase();
  if (name.includes("tanker")) return "#b63536";
  if (name.includes("cargo") || name.includes("container") || name.includes("bulk")) return "#006d91";
  if (name.includes("passenger") || name.includes("ferry")) return "#257149";
  if (name.includes("dredger") || name.includes("fishing") || name.includes("tug")) return "#995b08";
  return "";
}

function seenFromUnix(seconds: number): string {
  if (!seconds) return "";
  return seenLabel(new Date(seconds * 1000).toISOString());
}

function formatBaghdad(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString("en-GB", {
    timeZone: "Asia/Baghdad",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function mergeTargets(primary: AisTarget[], extra: AisTarget[]): AisTarget[] {
  const byId = new Map<string, AisTarget>();
  for (const ship of primary) byId.set(ship.mmsi || ship.id, { ...ship });
  for (const ship of extra) {
    const key = ship.mmsi || ship.id;
    const prev = byId.get(key);
    if (!prev) {
      byId.set(key, ship);
      continue;
    }
    byId.set(key, {
      ...prev,
      imo: prev.imo || ship.imo,
      callsign: prev.callsign || ship.callsign,
      flag: prev.flag || ship.flag,
      type: prev.type === "Unknown" ? ship.type : prev.type,
      typeCode: prev.typeCode ?? ship.typeCode,
      status: prev.status || ship.status,
      sog: prev.sog ?? ship.sog,
      cog: prev.cog ?? ship.cog,
      heading: prev.heading ?? ship.heading,
      destination: prev.destination || ship.destination,
      eta: prev.eta || ship.eta,
      draught: prev.draught ?? ship.draught,
      length: prev.length ?? ship.length,
      width: prev.width ?? ship.width,
      seen: prev.seen && prev.seen !== "—" ? prev.seen : ship.seen,
      color: prev.color === "#087f83" ? ship.color : prev.color,
    });
  }
  return [...byId.values()];
}

export function openWatersCredit(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Open Waters AIS";
  const attribution = (payload as { attribution?: Record<string, string> }).attribution;
  const line = attribution ? Object.values(attribution)[0] : "";
  return line || "Open Waters AIS";
}
