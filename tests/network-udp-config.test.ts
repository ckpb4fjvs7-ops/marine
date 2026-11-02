import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_UDP_CONFIG, normalizeBridgeUrl, parseUdpPreferences, validateUdpConfig } from "../src/lib/network-udp-types.ts";

test("R5 NAVD defaults are discovery-only, with a separate source, group and local interface", () => {
  assert.equal(DEFAULT_UDP_CONFIG.sourceIp, "");
  assert.equal(DEFAULT_UDP_CONFIG.group, "239.192.0.4");
  assert.equal(DEFAULT_UDP_CONFIG.port, 60004);
  assert.equal(validateUdpConfig(DEFAULT_UDP_CONFIG), null);
});

test("device IP is never confused with multicast or an invalid port/interface", () => {
  for (const value of [
    { sourceIp: "239.192.0.4" }, { sourceIp: "0.0.0.0" }, { sourceIp: "device.local" },
    { port: 0 }, { port: 65536 }, { port: 3.5 }, { interfaceIp: "169.254.1.999" }, { group: "192.168.1.10" },
  ]) assert.ok(validateUdpConfig({ ...DEFAULT_UDP_CONFIG, ...value }));
  assert.equal(validateUdpConfig({ ...DEFAULT_UDP_CONFIG, sourceIp: "169.254.1.0", port: 10110, mode: "unicast" }), null);
});

test("saved values recover from malformed storage and cannot redirect bridge requests to a remote server", () => {
  assert.deepEqual(parseUdpPreferences("broken").config, DEFAULT_UDP_CONFIG);
  assert.deepEqual(parseUdpPreferences('{"config":{"port":-1}}').config, DEFAULT_UDP_CONFIG);
  for (const url of ["https://example.com", "http://192.168.1.10:8092", "http://user:pass@127.0.0.1:8092"]) assert.throws(() => normalizeBridgeUrl(url));
  assert.equal(normalizeBridgeUrl("http://127.0.0.1:8093/"), "http://127.0.0.1:8093");
});
