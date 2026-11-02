import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DISPLAY_SETTINGS, normalizeDisplaySettings, parseDisplaySettings } from "../src/lib/display-settings.ts";

test("missing, malformed and non-object preferences keep the original display defaults", () => {
  for (const value of [null, "", "{broken", "null", "[]", "42"]) {
    assert.deepEqual(parseDisplaySettings(value), DEFAULT_DISPLAY_SETTINGS);
  }
});

test("partial saved preferences preserve valid choices and fill defaults for new settings", () => {
  assert.deepEqual(parseDisplaySettings('{"shipSize":2,"trackColor":"#20C9FF","trackVisible":false}'), {
    ...DEFAULT_DISPLAY_SETTINGS, shipSize: 2, trackColor: "#20c9ff", trackVisible: false,
  });
});

test("invalid persisted values cannot produce enormous symbols, invisible layers or invalid colors", () => {
  const result = normalizeDisplaySettings({
    shipSize: 999, trackWidth: -9, trackOpacity: -1, depthOpacity: 8,
    trackColor: "url(https://example.test)", trackPoints: 100000000,
    courseMinutes: -2, trackVisible: "false", courseVisible: 0,
  });
  assert.deepEqual(result, {
    ...DEFAULT_DISPLAY_SETTINGS, shipSize: 4, trackWidth: 1, trackOpacity: 0.2, depthOpacity: 1,
  });
  assert.equal(normalizeDisplaySettings({ shipSize: NaN, trackWidth: Infinity }).shipSize, 1);
  assert.equal(normalizeDisplaySettings({ shipSize: NaN, trackWidth: Infinity }).trackWidth, 3);
});
