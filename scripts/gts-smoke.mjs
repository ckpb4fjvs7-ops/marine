import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const url = "http://127.0.0.1:8080/?survey=abdullah";
const output = resolve("test-results/gts");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : process.platform === "win32" ? { channel: "msedge" } : {}),
});
const results = [];

function sentence(body) {
  let checksum = 0;
  for (const char of body) checksum ^= char.charCodeAt(0);
  return `$${body}*${checksum.toString(16).padStart(2, "0")}\r\n`;
}

function nmeaCoordinate(angle, width) {
  const degrees = Math.floor(Math.abs(angle));
  return `${String(degrees).padStart(width, "0")}${((Math.abs(angle) - degrees) * 60).toFixed(6).padStart(9, "0")}`;
}

try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const name = viewport.width > 1000 ? "desktop" : "mobile";
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      localStorage.setItem("own-ship-name", "GTS TEST");
      localStorage.setItem("own-ship-terms", "1");
      // A controlled provider avoids Chromium's transient POSITION_UNAVAILABLE when
      // replacing its location override. The app still uses watchPosition/clearWatch.
      const watches = new Map();
      let watchId = 0;
      window.__gtsGps = [];
      window.__gtsEmitGps = (coords) => {
        window.__gtsGps.push(coords);
        const position = { coords: { accuracy: 1, altitude: null, altitudeAccuracy: null, heading: null, speed: null, ...coords }, timestamp: Date.now() };
        watches.forEach((success) => success(position));
      };
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        watchPosition(success) {
          const id = ++watchId;
          watches.set(id, success);
          queueMicrotask(() => window.__gtsEmitGps({ latitude: 29.84, longitude: 48.48 }));
          return id;
        },
        clearWatch(id) { watches.delete(id); },
      } });
      // Capture the test page's map without adding a testing API to the app.
      let leaflet;
      Object.defineProperty(window, "L", {
        configurable: true,
        get: () => leaflet,
        set: (value) => {
          leaflet = value;
          value.Map.addInitHook(function () { window.__gtsMap = this; });
        },
      });
      const port = {
        readable: null,
        async open() { this.readable = new ReadableStream({ start(controller) { window.__gtsSerial = controller; } }); },
        async close() { this.readable = null; window.__gtsSerial = null; },
        async setSignals() {},
      };
      Object.defineProperty(navigator, "serial", { configurable: true, value: { requestPort: async () => port } });
      window.__gtsState = () => {
        const map = window.__gtsMap;
        let ship;
        map?.eachLayer((layer) => {
          if (layer.options.icon?.options.html?.includes("ship-rot")) ship = layer;
        });
        const dot = document.querySelector(".ship-pin .ship-fix");
        if (!map || !ship || !dot) return null;
        const frame = map.getContainer().getBoundingClientRect();
        const fix = dot.getBoundingClientRect();
        const reference = map.latLngToContainerPoint([29.817, 48.468]);
        return {
          lat: ship.getLatLng().lat, lng: ship.getLatLng().lng,
          center: [map.getCenter().lat, map.getCenter().lng], zoom: map.getZoom(),
          offset: Math.hypot(fix.left + fix.width / 2 - frame.left - frame.width / 2, fix.top + fix.height / 2 - frame.top - frame.height / 2),
          reference: [reference.x, reference.y], bearing: map.getBearing?.() ?? 0,
          panAnimating: Boolean(document.querySelector(".leaflet-pan-anim")),
        };
      };
    });
    const page = await context.newPage();
    const emitGps = (coords) => page.evaluate((value) => window.__gtsEmitGps(value), coords);
    page.setDefaultTimeout(20000);
    const errors = [];
    const checks = [];
    page.on("pageerror", (error) => errors.push(error.message));
    assert.equal((await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }))?.status(), 200);
    await page.getByRole("button", { name: "ابدأ الملاحة", exact: true }).click();
    await page.locator(".startup-splash").waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__gtsState?.() != null);
    await page.getByLabel("Latitude", { exact: true }).fill("29.82");
    await page.getByLabel("Longitude", { exact: true }).fill("48.46");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await page.waitForFunction(() => window.__gtsState()?.zoom === 17);
    const gts = page.getByRole("button", { name: "GTS", exact: true });
    assert.equal(await gts.getAttribute("aria-pressed"), "false");
    await gts.click();
    assert.equal(await gts.getAttribute("aria-pressed"), "true");

    const sensors = page.getByRole("tab", { name: "Sensors & connections", exact: true });
    await sensors.click();
    await page.getByRole("button", { name: "Own ship GPS", exact: true }).click();
    await sensors.click();

    async function waitFix(lat, lng, centered = true) {
      try {
        await page.waitForFunction(({ lat, lng }) => {
          const state = window.__gtsState();
          return state && Math.abs(state.lat - lat) < 1e-8 && Math.abs(state.lng - lng) < 1e-8;
        }, { lat, lng });
      } catch (error) {
        const diagnostic = await page.evaluate(() => ({ state: window.__gtsState(), gps: window.__gtsGps, text: document.body.innerText.slice(-1800) }));
        writeFileSync(resolve(output, `${name}-failure.json`), JSON.stringify({ expected: { lat, lng }, diagnostic }, null, 2));
        await page.screenshot({ path: resolve(output, `${name}-failure.png`) });
        throw error;
      }
      if (centered) await page.waitForFunction(() => window.__gtsState()?.offset <= 1.5);
      const state = await page.evaluate(() => window.__gtsState());
      if (centered) {
        assert.ok(state.offset <= 1.5, `Ship drifted ${state.offset}px from the center`);
        assert.equal(state.zoom, 17, "Following changed the chart zoom");
        assert.equal(state.panAnimating, false, "Ship follows an animated pan instead of staying fixed");
      }
      return state;
    }

    await waitFix(29.84, 48.48);
    checks.push("GTS before first GPS fix keeps the ship centered, even outside survey bounds, without changing zoom");
    const before = await page.evaluate(() => window.__gtsState());
    for (let index = 0; index < 8; index++) {
      const latitude = 29.819 + index * 0.0001;
      const longitude = 48.465 + index * 0.0001;
      await emitGps({ latitude, longitude, accuracy: 1, heading: 90, speed: 4 });
      await waitFix(latitude, longitude);
    }
    const after = await page.evaluate(() => window.__gtsState());
    assert.ok(Math.hypot(after.reference[0] - before.reference[0], after.reference[1] - before.reference[1]) > 10);
    checks.push("Eight moving GPS fixes leave the ship fixed while the chart moves");

    const wheelFrame = await page.locator(".leaflet-container").boundingBox();
    await page.mouse.move(wheelFrame.x + wheelFrame.width * 0.25, wheelFrame.y + wheelFrame.height * 0.3);
    await page.mouse.wheel(0, -1);
    await page.waitForFunction(() => window.__gtsState()?.zoom === 18 && window.__gtsState()?.offset <= 1.5 && !document.querySelector(".leaflet-zoom-anim"));
    await page.mouse.wheel(0, 1);
    await page.waitForFunction(() => window.__gtsState()?.zoom === 17 && window.__gtsState()?.offset <= 1.5 && !document.querySelector(".leaflet-zoom-anim"));
    checks.push("Mouse wheel zoom keeps the ship centered even when the pointer is away from it");

    const chart = page.getByRole("tab", { name: "Chart display", exact: true });
    await chart.click();
    await page.getByRole("button", { name: "Course up", exact: true }).click();
    await chart.click();
    for (const heading of [45, 180, 270]) {
      const latitude = 29.82 + heading / 1000000;
      await emitGps({ latitude, longitude: 48.466, accuracy: 1, heading, speed: 4 });
      const state = await waitFix(latitude, 48.466);
      assert.ok(Math.abs(state.bearing - (360 - heading) % 360) < 0.1);
    }
    checks.push("Course-up rotation retains the centered ship");

    const frame = await page.locator(".leaflet-container").boundingBox();
    const x = frame.x + frame.width * 0.3;
    const y = frame.y + frame.height * 0.35;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y + 40, { steps: 12 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    assert.equal(await gts.getAttribute("aria-pressed"), "false");
    const panned = await page.evaluate(() => window.__gtsState());
    await emitGps({ latitude: 29.8209, longitude: 48.4669, accuracy: 1, heading: 270, speed: 4 });
    const free = await waitFix(29.8209, 48.4669, false);
    assert.deepEqual(free.center, panned.center);
    assert.ok(free.offset > 5);
    await gts.click();
    await waitFix(29.8209, 48.4669);
    checks.push("Manual chart drag pauses following while GPS continues; GTS resumes the camera lock");

    await page.getByRole("button", { name: "Both", exact: true }).click();
    await waitFix(29.8209, 48.4669);
    await page.getByRole("button", { name: "Chart", exact: true }).click();
    await waitFix(29.8209, 48.4669);
    checks.push("Chart and split-view resizing retain the camera lock");

    await gts.click();
    assert.equal(await gts.getAttribute("aria-pressed"), "false");
    const unlocked = await page.evaluate(() => window.__gtsState());
    await emitGps({ latitude: 29.8215, longitude: 48.4675, accuracy: 1, heading: 270, speed: 4 });
    const moved = await waitFix(29.8215, 48.4675, false);
    assert.deepEqual(moved.center, unlocked.center);
    await gts.click();
    await waitFix(29.8215, 48.4675);
    checks.push("Pressing GTS again stops following, and re-enabling centers the latest position");

    await sensors.click();
    await page.getByRole("button", { name: "Stop tracking", exact: true }).click();
    await sensors.click();
    for (const source of ["Connect JRC", "Bluetooth COM / SPP"]) {
      await sensors.click();
      await page.getByRole("button", { name: source, exact: true }).click();
      await page.waitForFunction(() => window.__gtsSerial != null);
      await sensors.click();
      for (let index = 0; index < 3; index++) {
        const lat = 29.8191 + index * 0.0002;
        const lng = 48.4641 + index * 0.0002;
        const message = sentence("HEHDT,270,T") + sentence(`GPRMC,120000,A,${nmeaCoordinate(lat, 2)},N,${nmeaCoordinate(lng, 3)},E,6.0,270.0,011126,,,A`);
        await page.evaluate((value) => window.__gtsSerial.enqueue(new TextEncoder().encode(value)), message);
        await waitFix(lat, lng);
        assert.equal(await gts.getAttribute("aria-pressed"), "true");
      }
      await sensors.click();
      await page.getByRole("button", { name: source === "Connect JRC" ? "Disconnect JRC" : "Disconnect Bluetooth COM", exact: true }).click();
      await sensors.click();
      checks.push(`${source}: NMEA updates follow continuously, including the first fix after connecting`);
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    results.push({ name, viewport, checks, errors, status: "passed" });
    console.log(`${name}: ${checks.length} GTS checks passed`);
    await context.close();
  }
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) {
    writeFileSync(resolve(output, "failure-state.json"), JSON.stringify(await page.evaluate(() => window.__gtsState?.()), null, 2));
    await page.screenshot({ path: resolve(output, "failure.png") });
  }
  throw error;
} finally {
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ url, results }, null, 2));
  await browser.close();
}
