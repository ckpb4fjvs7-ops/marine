import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const url = "http://127.0.0.1:8080/?survey=abdullah";
const output = resolve("test-results/settings");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : process.platform === "win32" ? { channel: "msedge" } : {}) });
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const name = viewport.width > 1000 ? "desktop" : "mobile";
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      localStorage.setItem("own-ship-name", "SETTINGS TEST");
      localStorage.setItem("own-ship-terms", "1");
      let callback;
      Object.defineProperty(navigator, "geolocation", { configurable: true, value: {
        watchPosition(success) { callback = success; return 1; },
        clearWatch() { callback = null; },
      } });
      window.__settingsGps = (lat, lng) => callback?.({ coords: { latitude: lat, longitude: lng, heading: null, speed: null }, timestamp: Date.now() });
      let leaflet;
      Object.defineProperty(window, "L", { configurable: true, get: () => leaflet, set: (value) => {
        leaflet = value;
        value.Map.addInitHook(function () { window.__settingsMap = this; });
      } });
      window.__settingsState = () => {
        const map = window.__settingsMap;
        if (!map) return null;
        const saved = JSON.parse(localStorage.getItem("marine360-display-settings-v1") || "{}");
        let track;
        let gridOpacity;
        let kmlOpacity;
        map.eachLayer((layer) => {
          if (layer instanceof leaflet.Polyline && !(layer instanceof leaflet.Polygon) && layer.options.color === saved.trackColor) track = layer;
          if (layer instanceof leaflet.ImageOverlay) gridOpacity = layer.options.opacity;
          if (layer instanceof leaflet.Polygon && layer.options.fillColor === "#a200ff") kmlOpacity = layer.options.fillOpacity;
        });
        const svg = document.querySelector(".ship-pin .ship-rot > svg")?.getBoundingClientRect();
        const fix = document.querySelector(".ship-pin .ship-fix")?.getBoundingClientRect();
        const rect = map.getContainer().getBoundingClientRect();
        const points = track?.getLatLngs();
        return {
          saved, svgWidth: svg?.width,
          offset: fix ? Math.hypot(fix.left + fix.width / 2 - rect.left - rect.width / 2, fix.top + fix.height / 2 - rect.top - rect.height / 2) : null,
          track: track ? { color: track.options.color, width: track.options.weight, opacity: track.options.opacity, points: points.length, first: [points[0].lat, points[0].lng] } : null,
          gridOpacity, kmlOpacity,
        };
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const enter = async () => {
      await page.getByRole("button", { name: "ابدأ الملاحة", exact: true }).click({ timeout: 60000 });
      await page.locator(".startup-splash").waitFor({ state: "detached" });
      await page.waitForFunction(() => window.__settingsState()?.svgWidth > 0);
    };
    assert.equal((await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }))?.status(), 200);
    await enter();
    const sensors = page.getByRole("tab", { name: "Sensors & connections", exact: true });
    await sensors.click();
    await page.getByRole("button", { name: "Own ship GPS", exact: true }).click();
    await sensors.click();
    await page.evaluate(() => {
      window.__settingsGps(29.819, 48.465);
      for (let i = 0; i < 550; i++) window.__settingsGps(29.8 + i * 0.00005, 48.465);
    });
    await page.waitForFunction(() => window.__settingsState()?.track?.points === 551);
    await page.getByRole("button", { name: "GTS", exact: true }).click();
    const setting = page.getByRole("tab", { name: "setting", exact: true });
    await setting.click();
    async function setInput(label, value) {
      await page.getByLabel(label, { exact: true }).evaluate((input, next) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, String(next));
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, value);
    }
    await setInput("حجم السفينة على الخريطة والنموذج", 2);
    await setInput("لون Past track", "#20c9ff");
    await setInput("سُمك خط Past track", 6);
    await setInput("وضوح خط Past track", 60);
    await setInput("وضوح طبقات الأعماق على الخريطة", 45);
    await page.getByLabel("طول السجل المعروض", { exact: true }).selectOption("500");
    await page.getByLabel("طول خط الاتجاه بالدقائق", { exact: true }).selectOption("12");
    await page.waitForFunction(() => {
      const s = window.__settingsState();
      return s?.svgWidth === 96 && s.track?.color === "#20c9ff" && s.track.width === 6 && s.track.opacity === 0.6 && s.track.points === 500 && s.kmlOpacity === 0.45;
    });
    const changed = await page.evaluate(() => window.__settingsState());
    assert.ok(Math.abs(changed.track.first[0] - 29.8025) < 1e-10);
    assert.ok(Math.abs(changed.gridOpacity - 0.92 * 0.45) < 1e-10);
    assert.ok(changed.offset <= 1.5, "Changing ship size moved the geographic fix away from the center");
    await page.getByLabel("طول السجل المعروض", { exact: true }).selectOption("8000");
    await page.waitForFunction(() => window.__settingsState()?.track?.points === 551);
    await page.getByLabel("إظهار Past track", { exact: true }).uncheck();
    await page.waitForFunction(() => window.__settingsState()?.track == null);
    await page.getByRole("tab", { name: "Route monitoring", exact: true }).click();
    const past = page.getByRole("button", { name: "PAST TRACK", exact: true });
    assert.equal(await past.getAttribute("aria-pressed"), "false");
    assert.equal(await page.getByLabel("Course line length in minutes", { exact: true }).inputValue(), "12");
    await past.click();
    await setting.click();
    assert.equal(await page.getByLabel("إظهار Past track", { exact: true }).isChecked(), true);
    await page.getByRole("button", { name: "Model", exact: true }).click();
    assert.equal(await page.getByRole("slider", { name: "حجم السفينة", exact: true }).inputValue(), "2");
    await page.getByRole("button", { name: "Chart", exact: true }).click();
    await page.locator("#tool-menu").evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: resolve(output, `${name}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await enter();
    await setting.click();
    assert.equal(await page.getByLabel("حجم السفينة على الخريطة والنموذج", { exact: true }).inputValue(), "2");
    assert.equal(await page.getByLabel("لون Past track", { exact: true }).inputValue(), "#20c9ff");
    assert.equal(await page.getByLabel("سُمك خط Past track", { exact: true }).inputValue(), "6");
    assert.equal(await page.getByLabel("وضوح طبقات الأعماق على الخريطة", { exact: true }).inputValue(), "45");
    await page.waitForFunction(() => window.__settingsState()?.svgWidth === 96 && window.__settingsState()?.kmlOpacity === 0.45);
    await page.getByRole("button", { name: "استعادة الإعدادات الافتراضية", exact: true }).click();
    await page.waitForFunction(() => window.__settingsState()?.svgWidth === 48 && window.__settingsState()?.kmlOpacity === 1);
    const reset = await page.evaluate(() => window.__settingsState());
    assert.deepEqual(reset.saved, { shipSize: 1, trackColor: "#bd641d", trackWidth: 3, trackOpacity: 0.92, trackPoints: 8000, trackVisible: true, courseVisible: true, speedVectorVisible: true, courseMinutes: 6, depthOpacity: 1 });
    assert.deepEqual(errors, []);
    results.push({ name, viewport, changed, restoredDefaults: reset.saved, errors, status: "passed" });
    console.log(`${name}: live settings, real track geometry, centered ship, synchronized controls, persistence and reset passed`);
    await context.close();
  }
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) {
    writeFileSync(resolve(output, "failure-state.json"), JSON.stringify(await page.evaluate(() => window.__settingsState?.()), null, 2));
    await page.screenshot({ path: resolve(output, "failure.png") });
  }
  throw error;
} finally {
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ url, results }, null, 2));
  await browser.close();
}
