import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseNmeaLine, parseDepthLine } from "../src/lib/nmea.ts";
import { parseOpenWaters, mergeTargets, parseVesselFinderMap } from "../src/lib/ais.ts";
import { destinationPoint, haversineKm, crossTrack, sampleAt, unproject, project, completeChannel, type Survey } from "../src/lib/survey.ts";
import { baghdadMinutes, formatClock, parseUmmQasrPage, describeUmmTide } from "../src/lib/tide.ts";

function sentence(body: string) {
  let checksum = 0;
  for (const char of body) checksum ^= char.charCodeAt(0);
  return `$${body}*${checksum.toString(16).padStart(2, "0")}`;
}
function near(actual: number | null, expected: number, tolerance = 1e-6) {
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} ≈ ${expected}`);
}

test("RMC decodes position, speed and course with checksum and southern/western coordinates", () => {
  const fix = parseNmeaLine(sentence("GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W"))!;
  near(fix.lat, 48.1173); near(fix.lng, 11.5166666667);
  assert.equal(fix.sogKn, 22.4); assert.equal(fix.cogDeg, 84.4); assert.equal(fix.valid, true);
  const southwest = parseNmeaLine(sentence("GNRMC,120000,A,3000.000,S,04700.000,W,0,0"))!;
  assert.equal(southwest.lat, -30); assert.equal(southwest.lng, -47);
  assert.equal(parseNmeaLine("$GPHDT,90,T*00"), null);
});
test("GGA/GLL validity and absent course remain distinct from zero", () => {
  assert.equal(parseNmeaLine(sentence("GPGGA,120000,3000,N,04700,E,0"))!.valid, false);
  assert.equal(parseNmeaLine(sentence("GPGLL,3000,N,04700,E,120000,V"))!.valid, false);
  assert.equal(parseNmeaLine(sentence("GPRMC,120000,V,3000,N,04700,E,,"))!.sogKn, null);
  assert.equal(parseNmeaLine(sentence("GPRMC,120000,A,3060,N,04700,E,0,0")), null);
});
test("VTG, HDT, THS and magnetic heading retain original conventions", () => {
  assert.equal(parseNmeaLine(sentence("GPVTG,360,T,,M,5.5,N,10.2,K"))!.cogDeg, 0);
  assert.equal(parseNmeaLine(sentence("HEHDT,270,T"))!.headingDeg, 270);
  assert.equal(parseNmeaLine(sentence("HETHS,90,A"))!.headingDeg, 90);
  assert.equal(parseNmeaLine(sentence("HCHDG,359,2,E,3,W"))!.headingDeg, 358);
});
test("echo sounder offsets, units and references are preserved", () => {
  assert.deepEqual(parseDepthLine(sentence("SDDPT,10,2")), { meters: 12, ref: "surface" });
  assert.deepEqual(parseDepthLine(sentence("SDDPT,10,-2")), { meters: 8, ref: "keel" });
  assert.deepEqual(parseDepthLine(sentence("SDDPT,10,")), { meters: 10, ref: "transducer" });
  near(parseDepthLine(sentence("SDDBT,10,f,,M,,F"))!.meters, 3.048);
  near(parseDepthLine(sentence("SDDBK,,f,,M,2,F"))!.meters, 3.6576);
  assert.equal(parseDepthLine(sentence("SDDPT,-1,0")), null);
});
test("distance, bearings and cross-track port/starboard remain consistent", () => {
  assert.equal(haversineKm(30, 47, 30, 47), 0);
  const end = destinationPoint(30, 47, 90, 1.852);
  near(haversineKm(30, 47, end.lat, end.lng), 1.852);
  const line = [{ lat: 30, lng: 47 }, { lat: 30.02, lng: 47 }];
  assert.equal(crossTrack({ lat: 30.01, lng: 46.999 }, line)!.side, "port");
  assert.equal(crossTrack({ lat: 30.01, lng: 47.001 }, line)!.side, "stbd");
  assert.equal(crossTrack({ lat: 30.01, lng: 47 }, line)!.side, "on track");
  assert.equal(crossTrack({ lat: 30, lng: 47 }, []), null);
});
for (const name of ["survey.json", "survey-river.json"]) {
  test(`${name}: real survey grid, sampling, projection and measured depths are preserved`, () => {
    const survey: Survey = JSON.parse(readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8"));
    assert.equal(survey.depths.length, survey.nx * survey.ny);
    assert.ok(survey.dx > 0 && survey.dy > 0 && survey.pointCount > 0);
    const index = survey.depths.findIndex((depth) => depth != null);
    const x = survey.x0 + (index % survey.nx) * survey.dx;
    const y = survey.y0 + Math.floor(index / survey.nx) * survey.dy;
    const point = unproject(survey, x, y);
    near(project(survey, point.lat, point.lng).x, x);
    near(sampleAt(survey, point.lat, point.lng).depth, survey.depths[index]!);
    assert.equal(sampleAt(survey, 0, 0).depth, null);
    const completed = completeChannel(survey);
    survey.depths.forEach((depth, i) => { if (depth != null) assert.equal(completed.depths[i], depth); });
    // Input pointCount counts soundings; multiple soundings can share a cell.
    const measuredCells = survey.depths.filter((depth) => depth != null).length;
    assert.ok(completed.pointCount >= measuredCells);
  });
}
test("AIS excludes base stations, handles unknown telemetry and merges by MMSI", () => {
  const features = (properties: object) => ({ geometry: { coordinates: [47.9, 30.1] }, properties });
  const ships = parseOpenWaters({ features: [features({ mmsi: "123456789", type: 70, sog: 102.3, cog: 360, heading: 511 }), features({ kind: "base" })] });
  assert.equal(ships.length, 1); assert.equal(ships[0].lat, 30.1); assert.equal(ships[0].lng, 47.9);
  assert.equal(ships[0].sog, null); assert.equal(ships[0].heading, null);
  const merged = mergeTargets(ships, [{ ...ships[0], callsign: "TEST", sog: 6 }]);
  assert.equal(merged.length, 1); assert.equal(merged[0].callsign, "TEST"); assert.equal(merged[0].sog, 6);
  assert.deepEqual(parseVesselFinderMap(new ArrayBuffer(2)), []);
});
test("Umm Qasr tide times use Baghdad and handle midnight", () => {
  assert.equal(baghdadMinutes(Date.parse("2026-10-30T00:00:00Z")), 180);
  assert.equal(formatClock(-30), "23:30"); assert.equal(formatClock(1470), "00:30");
  const turns = parseUmmQasrPage([ [1200, 1], [360, 4], [720, 1], [1080, 4], [60, 1] ]
    .map(([x, y], i) => `gm.mareas_x[${i}]=${x};gm.mareas_y[${i}]=${y}`).join(";"))!;
  assert.ok(turns[0].min < 0 && turns.at(-1)!.min >= 1440);
  assert.equal(describeUmmTide(turns, Date.parse("2026-10-30T00:00:00Z"))!.phase, "Flood");
  assert.equal(parseUmmQasrPage("unavailable"), null);
});
