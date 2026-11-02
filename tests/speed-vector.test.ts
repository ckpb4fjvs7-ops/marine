import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateSpeedVector, SPEED_VECTOR_MAX_AGE_MS, type VectorTelemetry } from "../src/lib/speed-vector.ts";
import { haversineKm } from "../src/lib/survey.ts";
import { parseNmeaLine } from "../src/lib/nmea.ts";

const at = 100000;
function data(sogKn: number | null, cogDeg: number | null): VectorTelemetry {
  return { position: { lat: 29.819, lng: 48.465, at }, motion: { sogKn, cogDeg, at } };
}

test("12 knots projects exactly 2 NM in ten minutes, with measured time increments", () => {
  const result = calculateSpeedVector(data(12, 90), at);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  const { vector } = result;
  assert.equal(vector.distanceNm, 2);
  assert.ok(vector.tip.lng > vector.origin.lng);
  assert.ok(Math.abs(haversineKm(vector.origin.lat, vector.origin.lng, vector.tip.lat, vector.tip.lng) - 3.704) < 1e-8);
  assert.equal(vector.ticks.length, 9);
  for (const tick of vector.ticks) {
    assert.ok(Math.abs(haversineKm(vector.origin.lat, vector.origin.lng, tick.lat, tick.lng) - 3.704 * tick.minute / 10) < 1e-8);
  }
});

test("zero speed has no vector; small measured speeds are not enlarged to a fabricated minimum", () => {
  assert.equal(calculateSpeedVector(data(0, null), at).status, "stopped");
  const result = calculateSpeedVector(data(0.06, 0), at);
  assert.equal(result.status, "ready");
  if (result.status === "ready") {
    assert.equal(result.vector.distanceNm, 0.01);
    assert.ok(result.vector.tip.lat > result.vector.origin.lat);
  }
});

test("missing or invalid ground speed/course never falls back to heading or synthetic speed", () => {
  for (const [speed, course] of [[null, 90], [12, null], [-1, 90], [NaN, 90], [12, NaN], [12, 511], [12, -1]] as Array<[number | null, number | null]>) {
    assert.equal(calculateSpeedVector(data(speed, course), at).vector, null);
  }
  assert.equal(calculateSpeedVector({ position: null, motion: data(12, 90).motion }, at).status, "waiting");
});

test("both position and ground motion must be recent; fresh heading or velocity alone cannot revive a stale position", () => {
  assert.equal(calculateSpeedVector(data(12, 90), at + SPEED_VECTOR_MAX_AGE_MS).status, "ready");
  assert.equal(calculateSpeedVector(data(12, 90), at + SPEED_VECTOR_MAX_AGE_MS + 1).status, "stale");
  const value = data(12, 90);
  value.motion!.at += SPEED_VECTOR_MAX_AGE_MS + 1;
  assert.equal(calculateSpeedVector(value, value.motion!.at).status, "stale");
});

test("RMC/VTG update ground motion, while GGA and HDT do not masquerade as COG updates", () => {
  assert.equal(parseNmeaLine("$GPRMC,120000,A,2949.1400,N,04827.9000,E,12,90")!.motionUpdated, true);
  const unavailable = parseNmeaLine("$GPRMC,120000,A,2949.1400,N,04827.9000,E,,")!;
  assert.equal(unavailable.motionUpdated, true);
  assert.equal(unavailable.sogKn, null);
  assert.equal(unavailable.cogDeg, null);
  assert.equal(parseNmeaLine("$GPVTG,270,T,,M,6,N,,K")!.motionUpdated, true);
  assert.equal(parseNmeaLine("$HEHDT,0,T")!.motionUpdated, undefined);
  assert.equal(parseNmeaLine("$GPGGA,120000,2949.1400,N,04827.9000,E,1")!.motionUpdated, undefined);
});
