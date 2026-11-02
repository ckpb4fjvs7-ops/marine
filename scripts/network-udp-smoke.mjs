import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { chromium } from "playwright";

const output = resolve("test-results/network-udp-ui");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : process.platform === "win32" ? { channel: "msedge" } : {}) });
const results = [];
function sentence(body) {
  let sum = 0;
  for (const ch of body) sum ^= ch.charCodeAt(0);
  return `$${body}*${sum.toString(16).padStart(2, "0")}\r\n`;
}
async function freePort() {
  const probe = createSocket("udp4"); probe.bind(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve)); return port;
}
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const name = viewport.width > 1000 ? "desktop" : "mobile";
    const context = await browser.newContext({ viewport });
    const sender = createSocket("udp4"); sender.bind(0, "127.0.0.1"); await once(sender, "listening");
    const port = await freePort();
    await context.addInitScript(() => {
      localStorage.setItem("own-ship-name", "UDP TEST"); localStorage.setItem("own-ship-terms", "1");
      let leaflet;
      Object.defineProperty(window, "L", { configurable: true, get: () => leaflet, set: (value) => {
        leaflet = value; value.Map.addInitHook(function () { window.__udpMap = this; });
      } });
      window.__udpShip = () => {
        let ship, vector;
        window.__udpMap?.eachLayer((layer) => {
          if (layer.options.icon?.options.html?.includes("ship-rot")) ship = layer;
          if (layer.options.className === "speed-vector-line") vector = layer;
        });
        const point = ship?.getLatLng();
        const line = vector?.getLatLngs();
        const rect = window.__udpMap?.getContainer().getBoundingClientRect();
        const fix = document.querySelector(".ship-fix")?.getBoundingClientRect();
        return {
          lat: point?.lat, lng: point?.lng,
          vectorNm: line ? window.__udpMap.distance(line[0], line.at(-1)) / 1852 : null,
          offset: rect && fix ? Math.hypot(fix.left + fix.width / 2 - rect.left - rect.width / 2, fix.top + fix.height / 2 - rect.top - rect.height / 2) : null,
        };
      };
    });
    const page = await context.newPage(); page.setDefaultTimeout(25000);
    const errors = []; const checks = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:8080/?survey=abdullah", { waitUntil: "domcontentloaded", timeout: 60000 });
    const enter = async () => {
      await page.getByRole("button", { name: "ابدأ الملاحة", exact: true }).click({ timeout: 60000 });
      await page.locator(".startup-splash").waitFor({ state: "detached" });
      await page.waitForFunction(() => window.__udpShip()?.lat != null);
      await page.getByRole("tab", { name: "Sensors & connections", exact: true }).click();
      await page.getByRole("button", { name: "Network UDP", exact: true }).click();
    };
    await enter();
    await page.getByRole("button", { name: "تحديث بطاقات الشبكة", exact: true }).click();
    await page.getByLabel("UDP local interface", { exact: true }).selectOption("127.0.0.1");
    await page.getByLabel("UDP reception mode", { exact: true }).selectOption("unicast");
    await page.getByLabel("UDP port", { exact: true }).fill(String(port));
    const initial = await page.evaluate(() => window.__udpShip());
    await page.getByRole("button", { name: "اكتشاف مصدر UDP", exact: true }).click();
    await page.getByText("اكتشاف المصادر فقط", { exact: true }).waitFor();
    const send = (value, address = "127.0.0.1") => new Promise((resolve, reject) => sender.send(Buffer.from(value), port, address, (err) => err ? reject(err) : resolve()));
    const rmc = sentence("GPRMC,120000,A,2949.1400,N,04827.9000,E,12,90,021126,,,A");
    await send(`UdPbC\0\\s:GP0001*1A\\${rmc}`);
    const discovered = page.getByRole("button", { name: /127\.0\.0\.1 · 1 packets/ });
    await discovered.waitFor();
    assert.equal((await page.evaluate(() => window.__udpShip())).lat, initial.lat, "Passive discovery moved the ship");
    await discovered.click();
    await page.getByText("المنفذ مفتوح — بانتظار الموقع", { exact: true }).waitFor();
    await send(`UdPbC\0${rmc}${sentence("HEHDT,270,T")}${sentence("SDDPT,11.5,0")}`);
    await page.waitForFunction(() => Math.abs(window.__udpShip()?.lat - 29.819) < 1e-9 && Math.abs(window.__udpShip()?.vectorNm - 2) < 1e-8);
    await page.getByText("موقع حي عبر UDP", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Own ship GPS", exact: true }).isDisabled(), true);
    await page.getByRole("button", { name: "GTS", exact: true }).click();
    await send(sentence("GPRMC,120001,A,2949.1460,N,04827.9060,E,12,90,021126,,,A"));
    await page.waitForFunction(() => Math.abs(window.__udpShip()?.lat - 29.8191) < 1e-9 && window.__udpShip()?.offset <= 1.5);
    await page.waitForFunction(() => document.querySelector('[aria-label="Last UDP NMEA sentence"]')?.textContent.includes("GPRMC"));
    checks.push("Auto-start local companion; raw and IEC UdPbC UDP reach the real UI, GNSS, depth, GTS and 10-minute speed vector");
    checks.push("Discovery finds the sender without moving the vessel; choosing IP applies only that source");
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    await page.getByRole("button", { name: "Disconnect UDP", exact: true }).click();
    await page.getByRole("button", { name: "Connect UDP", exact: true }).waitFor();
    await page.getByLabel("UDP device IP", { exact: true }).fill("127.0.0.2");
    await page.getByRole("button", { name: "Connect UDP", exact: true }).click();
    await page.getByText("المنفذ مفتوح — بانتظار الموقع", { exact: true }).waitFor();
    await send(rmc);
    await page.waitForFunction(async () => {
      const id = sessionStorage.getItem("marine360-udp-client-v1");
      const value = await (await fetch(`http://127.0.0.1:8092/health?clientId=${id}`)).json();
      return value.stats.filtered > 0;
    });
    assert.ok(Math.abs((await page.evaluate(() => window.__udpShip())).lat - 29.8191) < 1e-9);
    await page.getByRole("button", { name: "Disconnect UDP", exact: true }).click();
    await page.getByRole("button", { name: "Connect UDP", exact: true }).waitFor();
    await page.getByLabel("UDP device IP", { exact: true }).fill("127.0.0.1");
    await page.getByLabel("UDP reception mode", { exact: true }).selectOption("multicast");
    await page.getByRole("button", { name: "Connect UDP", exact: true }).click();
    await page.getByText("المنفذ مفتوح — بانتظار الموقع", { exact: true }).waitFor();
    sender.setMulticastInterface("127.0.0.1"); sender.setMulticastLoopback(true);
    await send(`UdPbC\0${rmc}`, "239.192.0.4");
    await page.waitForFunction(() => Math.abs(window.__udpShip()?.lat - 29.819) < 1e-9 && window.__udpShip()?.vectorNm != null);
    checks.push("Wrong-source UDP is filtered; actual multicast loopback packets on a selected interface drive the vessel");
    await page.getByRole("button", { name: "Disconnect UDP", exact: true }).click();
    await page.waitForFunction(() => window.__udpShip()?.vectorNm == null);
    assert.equal(await page.getByRole("button", { name: "Own ship GPS", exact: true }).isDisabled(), false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await enter();
    assert.equal(await page.getByLabel("UDP device IP", { exact: true }).inputValue(), "127.0.0.1");
    assert.equal(await page.getByLabel("UDP port", { exact: true }).inputValue(), String(port));
    assert.equal(await page.getByLabel("UDP reception mode", { exact: true }).inputValue(), "multicast");
    assert.equal(await page.getByRole("button", { name: "Connect UDP", exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    results.push({ name, viewport, port, checks, errors, status: "passed" });
    console.log(`${name}: ${checks.length} real UDP integration checks passed`);
    sender.close(); await context.close();
  }
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) {
    writeFileSync(resolve(output, "failure.json"), JSON.stringify(await page.evaluate(() => ({ ship: window.__udpShip?.(), text: document.body.innerText.slice(-5000) })), null, 2));
    await page.screenshot({ path: resolve(output, "failure.png") });
    const id = await page.evaluate(() => sessionStorage.getItem("marine360-udp-client-v1"));
    await fetch("http://127.0.0.1:8092/stop", { method: "POST", headers: { "Content-Type": "application/json", "X-Marine-Bridge": "1" }, body: JSON.stringify({ clientId: id }) }).catch(() => {});
  }
  throw error;
} finally {
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ results }, null, 2));
  await browser.close();
}
