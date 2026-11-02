import assert from "node:assert/strict";
import { test } from "node:test";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { startBridge, UdpReceiver } from "./udp-bridge.mjs";
import { UdpNmeaDecoder } from "./udp-nmea.mjs";

const owner = "marine-test-owner-123456";
function sentence(body) {
  let sum = 0;
  for (const ch of body) sum ^= ch.charCodeAt(0);
  return `$${body}*${sum.toString(16).padStart(2, "0")}\r\n`;
}
const rmc = sentence("GPRMC,120000,A,2949.1400,N,04827.9000,E,12,90,021126,,,A");
async function freePort() {
  const socket = createSocket("udp4");
  socket.bind(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("UDP test timed out");
}

test("decodes raw, bundled IEC UdPbC, TAG blocks and fragmented NMEA without mixing senders", () => {
  const decoder = new UdpNmeaDecoder();
  const vtg = sentence("GPVTG,90,T,,M,12,N,,K,A");
  assert.deepEqual(decoder.decode(Buffer.from(`UdPbC\0\\s:GP0001*1A\\${rmc}${vtg}`), "one").lines, [rmc.trim(), vtg.trim()]);
  const part = rmc.slice(0, -5);
  assert.deepEqual(decoder.decode(Buffer.from(part), "one").lines, []);
  assert.deepEqual(decoder.decode(Buffer.from(rmc.slice(-5)), "other").lines, []);
  assert.deepEqual(decoder.decode(Buffer.from(rmc.slice(-5)), "one").lines, [rmc.trim()]);
  assert.equal(decoder.decode(Buffer.from(rmc.replace(/\*[a-f0-9]{2}/i, "*00")), "one").invalidChecksums, 1);
  assert.deepEqual(decoder.decode(Buffer.from("RaUdP\0" + rmc), "one").lines, []);
  assert.deepEqual(decoder.decode(Buffer.from("$HEHDT,90,T\r\n"), "one", false).lines, ["$HEHDT,90,T"]);
});

test("real UDP packets update navigation diagnostics; source filter and single-tab ownership are enforced", async () => {
  const receiver = new UdpReceiver();
  const sender = createSocket("udp4");
  const port = await freePort();
  try {
    await receiver.start({ mode: "unicast", port, interfaceIp: "127.0.0.1", sourceIp: "127.0.0.2" }, owner);
    await new Promise((resolve, reject) => sender.send(Buffer.from(rmc), port, "127.0.0.1", (err) => err ? reject(err) : resolve()));
    await until(() => receiver.stats.packets === 1);
    assert.equal(receiver.stats.filtered, 1);
    assert.equal(receiver.stats.fixes, 0);
    await assert.rejects(receiver.start({ port }, "different-owner-123456"), /تبويب/);
    await assert.rejects(receiver.stop("different-owner-123456"), /تبويب/);
    await receiver.start({ mode: "unicast", port, interfaceIp: "127.0.0.1", sourceIp: "127.0.0.1" }, owner);
    const event = once(receiver, "nmea");
    sender.send(Buffer.from(`UdPbC\0${rmc}${sentence("HEHDT,30,T")}${sentence("SDDPT,11.5,0")}`), port, "127.0.0.1");
    const [batch] = await event;
    assert.equal(batch.lines.length, 3);
    assert.equal(batch.sourceIp, "127.0.0.1");
    assert.equal(receiver.stats.fixes, 1);
    assert.equal(receiver.stats.sentences, 3);
    assert.equal(receiver.snapshot(owner).owned, true);
    assert.equal(receiver.snapshot("someone-else").owned, false);
    assert.ok(!JSON.stringify(receiver.snapshot(owner)).includes(owner));
    await receiver.stop(owner);
    assert.equal(receiver.snapshot(owner).active, false);
  } finally { sender.close(); await receiver.stop(null, true); }
});

test("HTTP bridge rejects foreign origins and unauthenticated control; SSE carries real UDP sentences", async () => {
  const bridge = await startBridge({ port: 0 });
  const sender = createSocket("udp4");
  const abort = new AbortController();
  const post = (path, data, headers = {}) => fetch(`${bridge.url}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Marine-Bridge": "1", ...headers }, body: JSON.stringify(data) });
  try {
    assert.equal((await fetch(`${bridge.url}/health`, { headers: { Origin: "https://unrelated.example" } })).status, 403);
    assert.equal((await post("/start", {}, { "X-Marine-Bridge": "0" })).status, 403);
    const port = await freePort();
    const opened = await (await post("/start", { clientId: owner, config: { mode: "unicast", port, interfaceIp: "127.0.0.1", sourceIp: "127.0.0.1" } })).json();
    assert.equal(opened.active, true);
    const response = await fetch(`${bridge.url}/stream?clientId=${owner}`, { signal: abort.signal });
    const reader = response.body.getReader();
    await reader.read(); // initial status
    sender.send(Buffer.from(rmc), port, "127.0.0.1");
    let received = "";
    while (!received.includes("event: nmea")) received += new TextDecoder().decode((await reader.read()).value);
    assert.ok(received.includes(rmc.trim()));
    assert.equal((await post("/stop", { clientId: "different-owner-123456" })).status, 400);
    await post("/stop", { clientId: owner, sessionId: "old-session" });
    assert.equal(bridge.receiver.snapshot(owner).active, true);
    await post("/stop", { clientId: owner, sessionId: opened.sessionId });
    assert.equal(bridge.receiver.snapshot(owner).active, false);
    await reader.cancel();
  } finally { abort.abort(); sender.close(); await bridge.close(); }
});

test("multicast joins a specified local interface and receives looped-back IEC navigation packets", async (context) => {
  const receiver = new UdpReceiver();
  const sender = createSocket("udp4");
  const port = await freePort();
  try {
    try {
      await receiver.start({ mode: "multicast", port, group: "239.192.0.4", interfaceIp: "127.0.0.1", sourceIp: "" }, owner);
      sender.bind(0, "127.0.0.1"); await once(sender, "listening");
      sender.setMulticastInterface("127.0.0.1"); sender.setMulticastLoopback(true);
      sender.send(Buffer.from(`UdPbC\0${rmc}`), port, "239.192.0.4");
      await until(() => receiver.stats.fixes === 1);
      assert.equal(receiver.stats.format, "IEC 61162-450 / UdPbC");
    } catch (err) {
      if (err.code === "ENETUNREACH" || /timed out|ENODEV|EADDRNOTAVAIL|لا.*متاح/.test(err.message)) context.skip("OS does not route multicast on its loopback interface; unicast and framed IEC payloads tested separately");
      else throw err;
    }
  } finally { try { sender.close(); } catch { /* not bound */ } await receiver.stop(null, true); }
});
