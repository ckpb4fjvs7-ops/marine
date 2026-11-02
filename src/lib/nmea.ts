export type NmeaFix = {
  lat: number | null;
  lng: number | null;
  sogKn: number | null;
  cogDeg: number | null;
  /** Ship's head, degrees true. Null when the sentence has no heading. */
  headingDeg: number | null;
  /** RMC/VTG report ground motion, including explicitly unavailable fields. */
  motionUpdated?: boolean;
  valid: boolean;
};

function checksumOk(line: string): boolean {
  const star = line.indexOf("*");
  if (star < 0) return true;
  const given = line.slice(star + 1).trim();
  if (!/^[0-9A-Fa-f]{2}$/.test(given)) return false;
  let sum = 0;
  for (let i = 1; i < star; i++) sum ^= line.charCodeAt(i);
  return sum === Number.parseInt(given, 16);
}

/** NMEA ddmm.mmm or dddmm.mmm to decimal degrees. */
function dmToDeg(raw: string, hemi: string): number | null {
  if (!raw || (hemi !== "N" && hemi !== "S" && hemi !== "E" && hemi !== "W")) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const deg = Math.floor(value / 100);
  const minutes = value - deg * 100;
  if (minutes < 0 || minutes >= 60) return null;
  const signed = deg + minutes / 60;
  return hemi === "S" || hemi === "W" ? -signed : signed;
}

/** Course over ground or heading, degrees true. Empty fields stay unknown. */
function courseField(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 360) return null;
  return value % 360;
}

/** East-positive compass offset (deviation or variation). Missing hemisphere stays unknown. */
function signedOffset(raw: string | undefined, eastWest: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const magnitude = Number(raw);
  if (!Number.isFinite(magnitude)) return null;
  if (eastWest === "W") return -Math.abs(magnitude);
  if (eastWest === "E") return Math.abs(magnitude);
  return null;
}

function speedField(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reads ship position, speed, and course from JRC NMEA 0183. */
export function parseNmeaLine(line: string): NmeaFix | null {
  let trimmed = line.trim();
  const dollar = trimmed.indexOf("$");
  if (dollar < 0) return null;
  if (dollar > 0) trimmed = trimmed.slice(dollar);
  if (!checksumOk(trimmed)) return null;
  const star = trimmed.indexOf("*");
  const body = trimmed.slice(1, star < 0 ? undefined : star);
  const field = body.split(",");
  if (field.length < 2) return null;
  const kind = field[0].slice(-3);

  if (kind === "RMC" && field.length >= 7) {
    const lat = dmToDeg(field[3], field[4]);
    const lng = dmToDeg(field[5], field[6]);
    if (lat == null || lng == null) return null;
    return {
      lat,
      lng,
      sogKn: speedField(field[7]),
      cogDeg: courseField(field[8]),
      headingDeg: null,
      valid: field[2] === "A",
      motionUpdated: true,
    };
  }

  if (kind === "GGA" && field.length >= 6) {
    const lat = dmToDeg(field[2], field[3]);
    const lng = dmToDeg(field[4], field[5]);
    if (lat == null || lng == null) return null;
    const quality = Number(field[6] || "0");
    return { lat, lng, sogKn: null, cogDeg: null, headingDeg: null, valid: quality > 0 };
  }

  if (kind === "GLL" && field.length >= 5) {
    const lat = dmToDeg(field[1], field[2]);
    const lng = dmToDeg(field[3], field[4]);
    if (lat == null || lng == null) return null;
    const status = field[6];
    return {
      lat,
      lng,
      sogKn: null,
      cogDeg: null,
      headingDeg: null,
      valid: status == null || status === "" || status === "A",
    };
  }

  if (kind === "VTG") {
    const cogDeg = courseField(field[1]);
    const sogKn = speedField(field[5]);
    if (cogDeg == null && sogKn == null) return null;
    return { lat: null, lng: null, sogKn, cogDeg, headingDeg: null, valid: true, motionUpdated: true };
  }

  if (kind === "HDT" || kind === "THS") {
    const headingDeg = courseField(field[1]);
    if (headingDeg == null) return null;
    return { lat: null, lng: null, sogKn: null, cogDeg: null, headingDeg, valid: true };
  }

  if (kind === "HDG") {
    const magnetic = courseField(field[1]);
    if (magnetic == null) return null;
    let heading = magnetic;
    const deviation = signedOffset(field[2], field[3]);
    const variation = signedOffset(field[4], field[5]);
    if (deviation != null) heading += deviation;
    if (variation != null) heading += variation;
    const headingDeg = ((heading % 360) + 360) % 360;
    return { lat: null, lng: null, sogKn: null, cogDeg: null, headingDeg, valid: true };
  }

  return null;
}

export type Sounding = {
  meters: number;
  ref: "surface" | "transducer" | "keel";
};

function depthMeters(raw: string | undefined): number | null {
  if (!raw || !raw.trim()) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 12000) return null;
  return value;
}

/** Depth from a JFE-680 style echo sounder: DPT, DBT, DBS, or DBK. */
export function parseDepthLine(line: string): Sounding | null {
  let trimmed = line.trim();
  const dollar = trimmed.indexOf("$");
  if (dollar < 0) return null;
  if (dollar > 0) trimmed = trimmed.slice(dollar);
  if (!checksumOk(trimmed)) return null;
  const star = trimmed.indexOf("*");
  const body = trimmed.slice(1, star < 0 ? undefined : star);
  const field = body.split(",");
  if (field.length < 2) return null;
  const kind = field[0].slice(-3);

  if (kind === "DPT") {
    const depth = depthMeters(field[1]);
    if (depth == null) return null;
    if (field[2] != null && field[2].trim() !== "") {
      const offset = Number(field[2]);
      if (Number.isFinite(offset)) {
        return { meters: Math.max(0, depth + offset), ref: offset < 0 ? "keel" : "surface" };
      }
    }
    return { meters: depth, ref: "transducer" };
  }

  if (kind === "DBT" || kind === "DBS" || kind === "DBK") {
    const feet = depthMeters(field[1]);
    const metres = depthMeters(field[3]);
    const fathoms = depthMeters(field[5]);
    const unit2 = (field[2] || "").toUpperCase();
    const unit4 = (field[4] || "").toUpperCase();
    const unit6 = (field[6] || "").toUpperCase();
    let meters: number | null = null;
    if (unit4 === "M" && metres != null) meters = metres;
    else if (unit2 === "F" && feet != null) meters = feet * 0.3048;
    else if (unit6 === "F" && fathoms != null) meters = fathoms * 1.8288;
    else if (metres != null) meters = metres;
    if (meters == null) return null;
    return { meters, ref: kind === "DBS" ? "surface" : kind === "DBK" ? "keel" : "transducer" };
  }

  return null;
}
