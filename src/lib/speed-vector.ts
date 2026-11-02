import { destinationPoint } from "./survey.ts";

export const SPEED_VECTOR_MINUTES = 10;
export const SPEED_VECTOR_MAX_AGE_MS = 15000;

export type VectorPosition = { lat: number; lng: number; at: number };
export type GroundMotion = { sogKn: number | null; cogDeg: number | null; at: number };
export type VectorTelemetry = { position: VectorPosition | null; motion: GroundMotion | null };
export type SpeedVector = {
  origin: { lat: number; lng: number };
  tip: { lat: number; lng: number };
  ticks: Array<{ minute: number; lat: number; lng: number }>;
  sogKn: number;
  cogDeg: number;
  distanceNm: number;
};
export type SpeedVectorResult = { status: "waiting" | "stale" | "stopped"; vector: null } | { status: "ready"; vector: SpeedVector };

/** A fixed ten-minute ground vector, using measured SOG/COG and a recent position. */
export function calculateSpeedVector(telemetry: VectorTelemetry, now: number): SpeedVectorResult {
  const { position, motion } = telemetry;
  if (!position || !motion) return { status: "waiting", vector: null };
  if (![position.lat, position.lng, position.at, motion.at, now].every(Number.isFinite) || Math.abs(position.lat) > 90 || Math.abs(position.lng) > 180) return { status: "waiting", vector: null };
  if ([position.at, motion.at].some((at) => now < at || now - at > SPEED_VECTOR_MAX_AGE_MS)) return { status: "stale", vector: null };
  const { sogKn, cogDeg } = motion;
  if (sogKn == null || !Number.isFinite(sogKn) || sogKn < 0) return { status: "waiting", vector: null };
  if (sogKn === 0) return { status: "stopped", vector: null };
  if (cogDeg == null || !Number.isFinite(cogDeg) || cogDeg < 0 || cogDeg > 360) return { status: "waiting", vector: null };
  const course = cogDeg % 360;
  const distanceNm = sogKn * SPEED_VECTOR_MINUTES / 60;
  const origin = { lat: position.lat, lng: position.lng };
  return {
    status: "ready",
    vector: {
      origin, sogKn, cogDeg: course, distanceNm,
      tip: destinationPoint(origin.lat, origin.lng, course, distanceNm * 1.852),
      ticks: Array.from({ length: SPEED_VECTOR_MINUTES - 1 }, (_, index) => ({
        minute: index + 1,
        ...destinationPoint(origin.lat, origin.lng, course, sogKn * (index + 1) / 60 * 1.852),
      })),
    },
  };
}
