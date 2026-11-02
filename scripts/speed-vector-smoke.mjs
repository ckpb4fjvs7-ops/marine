import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const url = "http://127.0.0.1:8080/?survey=abdullah";
const output = resolve("test-results/speed-vector");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : process.platform === "win32" ? { channel: "msedge" } : {}) });
const results = [];
function sentence(body) {
  let sum = 0;
  for (const char of body) sum ^= char.charCodeAt(0);
  return `$${body}*${sum.toString(16).padStart(2, "0")}\r\n`;
}
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const name = viewport.width > 1000 ? "desktop" : "mobile";
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      localStorage.setItem("own-ship-name", "VECTOR TEST");
      localStorage.setItem("own-ship-terms", "1");
      // Include older saved preferences to verify migration without losing choices.
      if (!localStorage.getItem("marine360-display-settings-v1")) localStorage.setItem("marine360-display-settings-v1", JSON.stringify({ shipSize: 1.25, courseMinutes: 12 }));
      let leaflet;
      Object.defineProperty(window, "L", { configurable: true, get: () => leaflet, set: (value) => {
        leaflet = value;
        value.Map.addInitHook(function () { window.__vectorMap = this; });
      } });
      let gps;
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        watchPosition(success) { gps = success; return 1; }, clearWatch() { gps = null; },
      } });
      window.__vectorGps = (speed, heading, lat = 29.819, lng = 48.465) => gps?.({ coords: { latitude: lat, longitude: lng, speed, heading }, timestamp: Date.now() });
      const port = {
        readable: null,
        async open() { this.readable = new ReadableStream({ start(controller) { window.__vectorSerial = controller; } }); },
        async close() { this.readable = null; window.__vectorSerial = null; },
        async setSignals() {},
      };
      Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port } });
      const now = Date.now.bind(Date);
      window.__vectorTimeOffset = 0;
      Date.now = () => now() + window.__vectorTimeOffset;
      window.__vectorState = () => {
        const map = window.__vectorMap;
        let line, ticks;
        map?.eachLayer((layer) => {
          if (layer.options.className === "speed-vector-line") line = layer;
          if (layer.options.className === "speed-vector-ticks") ticks = layer;
        });
        const points = line?.getLatLngs();
        const start = points?.[0];
        const tip = points?.at(-1);
        const frame = map?.getContainer().getBoundingClientRect();
        const fix = document.querySelector(".ship-pin .ship-fix")?.getBoundingClientRect();
        const label = document.querySelector(".speed-vector-label")?.getBoundingClientRect();
        return {
          origin: start ? [start.lat, start.lng] : null, tip: tip ? [tip.lat, tip.lng] : null,
          nm: start && tip ? map.distance(start, tip) / 1852 : null,
          ticks: ticks?.getLatLngs().length ?? 0,
          label: document.querySelector(".speed-vector-label")?.textContent ?? null,
          labelFits: frame && label ? label.left >= frame.left && label.right <= frame.right : null,
          status: document.querySelector('[aria-label="Speed vector لمدة 10 دقائق"]')?.textContent ?? null,
          offset: frame && fix ? Math.hypot(fix.left + fix.width / 2 - frame.left - frame.width / 2, fix.top + fix.height / 2 - frame.top - frame.height / 2) : null,
        };
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [];
    const checks = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const enter = async () => {
      await page.getByRole("button", { name: "ابدأ الملاحة", exact: true }).click({ timeout: 60000 });
      await page.locator(".startup-splash").waitFor({ state: "detached" });
      await page.waitForFunction(() => window.__vectorMap && document.querySelector(".ship-fix"));
    };
    assert.equal((await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }))?.status(), 200);
    await enter();
    assert.equal((await page.evaluate(() => window.__vectorState())).nm, null);
    const sensors = page.getByRole("tab", { name: "Sensors & connections", exact: true });
    const nav = page.getByRole("tab", { name: "Route monitoring", exact: true });
    const vectorButton = page.getByRole("button", { name: "SPEED VECTOR · 10 min", exact: true });
    await sensors.click();
    await page.getByRole("button", { name: "Own ship GPS", exact: true }).click();
    await sensors.click();
    await page.evaluate(() => window.__vectorGps(12 / 1.943844, 45));
    await page.waitForFunction(() => Math.abs(window.__vectorState().nm - 2) < 1e-8);
    await page.getByRole("button", { name: "GTS", exact: true }).click();
    await page.evaluate(() => { window.__vectorMap.setZoom(13, { animate: false }); });
    await page.waitForFunction(() => window.__vectorState().ticks === 9);
    const gps = await page.evaluate(() => window.__vectorState());
    assert.match(gps.label, /10 min.*2\.00 NM/);
    assert.ok(gps.tip[0] > gps.origin[0] && gps.tip[1] > gps.origin[1]);
    assert.ok(gps.offset <= 1.5);
    assert.equal(gps.labelFits, true, "The vector label is clipped at the side of the chart");
    await nav.click();
    assert.equal(await vectorButton.getAttribute("aria-pressed"), "true");
    assert.equal(await page.getByLabel("Course line length in minutes", { exact: true }).inputValue(), "12");
    await vectorButton.click();
    await page.waitForFunction(() => window.__vectorState().nm == null);
    await vectorButton.click();
    await page.waitForFunction(() => Math.abs(window.__vectorState().nm - 2) < 1e-8);
    await nav.click();
    checks.push("GPS: 12 kn gives a true 2 NM / 10 min vector with nine minute ticks and a centered ship; independent of the 12-minute course line");
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    await page.evaluate(() => window.__vectorGps(0, null));
    await page.waitForFunction(() => window.__vectorState().nm == null && window.__vectorState().status.includes("متوقفة"));
    await page.evaluate(() => window.__vectorGps(6 / 1.943844, null));
    await page.waitForFunction(() => window.__vectorState().nm == null && window.__vectorState().status.includes("بانتظار"));
    checks.push("No vector at rest or when GPS course is unavailable; no heading or synthetic-speed substitute");
    await sensors.click();
    await page.getByRole("button", { name: "Stop tracking", exact: true }).click();
    await page.getByRole("button", { name: "Connect JRC", exact: true }).click();
    await page.waitForFunction(() => window.__vectorSerial != null);
    await sensors.click();
    const send = (body) => page.evaluate((value) => window.__vectorSerial.enqueue(new TextEncoder().encode(value)), sentence(body));
    await send("HEHDT,0,T");
    await send("GPRMC,120000,A,2949.1400,N,04827.9000,E,12,90,011126,,,A");
    await page.waitForFunction(() => Math.abs(window.__vectorState().nm - 2) < 1e-8);
    const east = await page.evaluate(() => window.__vectorState());
    assert.ok(east.tip[1] > east.origin[1]);
    await send("HEHDT,270,T");
    assert.deepEqual((await page.evaluate(() => window.__vectorState())).tip, east.tip);
    await send("GPVTG,270,T,,M,6,N,,K,A");
    await page.waitForFunction(() => Math.abs(window.__vectorState().nm - 1) < 1e-8);
    const west = await page.evaluate(() => window.__vectorState());
    assert.ok(west.tip[1] < west.origin[1]);
    await send("GPRMC,120000,A,2949.1400,N,04827.9000,E,12,,011126,,,A");
    await page.waitForFunction(() => window.__vectorState().nm == null);
    checks.push("NMEA: COG controls the ground vector independently of bow heading; VTG-only speed/course updates redraw it; missing COG clears it");
    await send("GPRMC,120000,A,2949.1400,N,04827.9000,E,12,90,011126,,,A");
    await page.waitForFunction(() => window.__vectorState().nm != null);
    await page.evaluate(() => { window.__vectorTimeOffset += 20000; });
    await page.waitForFunction(() => window.__vectorState().nm == null && window.__vectorState().status.includes("حديثة"));
    await send("GPVTG,270,T,,M,6,N,,K,A");
    assert.equal((await page.evaluate(() => window.__vectorState())).nm, null);
    await send("GPGGA,120000,2949.1400,N,04827.9000,E,1");
    await page.waitForFunction(() => Math.abs(window.__vectorState().nm - 1) < 1e-8);
    await sensors.click();
    await page.getByRole("button", { name: "Disconnect JRC", exact: true }).click();
    await page.waitForFunction(() => window.__vectorState().nm == null);
    await sensors.click();
    checks.push("Stale data expires; fresh velocity cannot revive stale position; fresh GGA restores it; disconnect removes it immediately");
    const setting = page.getByRole("tab", { name: "setting", exact: true });
    await setting.click();
    await page.getByLabel("إظهار Speed vector — 10 دقائق", { exact: true }).uncheck();
    await page.reload({ waitUntil: "domcontentloaded" });
    await enter();
    await setting.click();
    assert.equal(await page.getByLabel("إظهار Speed vector — 10 دقائق", { exact: true }).isChecked(), false);
    assert.equal(await page.getByLabel("حجم السفينة على الخريطة والنموذج", { exact: true }).inputValue(), "1.25");
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    results.push({ name, viewport, gps, checks, errors, status: "passed" });
    console.log(`${name}: ${checks.length} speed-vector integration checks passed`);
    await context.close();
  }
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) {
    writeFileSync(resolve(output, "failure-state.json"), JSON.stringify(await page.evaluate(() => window.__vectorState?.()), null, 2));
    await page.screenshot({ path: resolve(output, "failure.png") });
  }
  throw error;
} finally {
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ url, results }, null, 2));
  await browser.close();
}
