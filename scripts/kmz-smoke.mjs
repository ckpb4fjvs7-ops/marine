import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "playwright";

const url = "http://127.0.0.1:8080/?survey=abdullah";
const output = resolve("test-results/khawr-abdullah");
mkdirSync(output, { recursive: true });
const sourceHash = createHash("sha256").update(readFileSync("public/surveys/khawr-abdullah-11-13.kmz")).digest("hex");
assert.equal(sourceHash, "2ae52987fec6cad9912f0e14ad97cd23bd93dad3a1adc7a6ed53349d6476ac5e");
assert.equal(createHash("sha256").update(readFileSync("public/surveys/khawr-abdullah-11-13.kml")).digest("hex"), "6defff7559df18c138bc816fbb26d0f3d3423f12780174ad689abff69423e6bb");
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : process.platform === "win32" ? { channel: "msedge" } : {}),
});
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const name = viewport.width > 1000 ? "desktop" : "mobile";
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(30000);
    assert.equal((await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }))?.status(), 200);
    const dataChecks = await page.evaluate(async () => {
      const [{ parseSurveyKml, createKmlDepthLayer }, { sampleAt, project, unproject, completeChannel }, { default: L }] = await Promise.all([
        import("/src/lib/kml-survey.ts"), import("/src/lib/survey.ts"), import("/node_modules/.vite/deps/leaflet.js"),
      ]);
      const source = await (await fetch("/surveys/khawr-abdullah-11-13.kml")).text();
      const doc = new DOMParser().parseFromString(source, "application/xml");
      const data = parseSurveyKml(source);
      const original = Array.from(doc.getElementsByTagNameNS("*", "coordinates"))
        .map((node) => node.textContent.trim().split(/\s+/).map((tuple) => tuple.split(",").map(Number)));
      const converted = [];
      function collect(geometry) {
        if (geometry.type === "GeometryCollection") geometry.geometries.forEach(collect);
        else if (geometry.type === "Point") converted.push([geometry.coordinates]);
        else if (geometry.type === "LineString") converted.push(geometry.coordinates);
        else if (geometry.type === "Polygon") geometry.coordinates.forEach((ring) => converted.push(ring));
      }
      data.features.features.forEach((feature) => collect(feature.geometry));
      if (JSON.stringify(original) !== JSON.stringify(converted)) throw new Error("Original geometry coordinates changed");
      const placemarks = Array.from(doc.getElementsByTagNameNS("*", "Placemark"));
      placemarks.forEach((mark, i) => {
        const originalName = Array.from(mark.children).find((node) => node.localName === "name")?.textContent.trim() ?? "";
        if (data.features.features[i].properties.name !== originalName) throw new Error("Original label changed");
      });
      for (const point of data.survey.soundings) {
        if (sampleAt(data.survey, point.lat, point.lng).depth !== point.depth) throw new Error("Measured depth changed");
        const xy = project(data.survey, point.lat, point.lng);
        const geo = unproject(data.survey, xy.x, xy.y);
        if (Math.abs(geo.lat - point.lat) > 1e-12 || Math.abs(geo.lng - point.lng) > 1e-12) throw new Error("Model position shifted");
      }
      if (completeChannel(data.survey) !== data.survey) throw new Error("Soundings were gap filled");
      if (sampleAt(data.survey, 0, 0).depth !== null) throw new Error("Depth outside source coverage");
      const element = document.createElement("div");
      element.style.cssText = "width:400px;height:300px;position:absolute;left:-1000px";
      document.body.append(element);
      const map = L.map(element).setView([29.82, 48.46], 16);
      const layer = createKmlDepthLayer(L, data, map);
      const layers = layer.getLayers();
      let points = 0;
      for (const item of layers) {
        const feature = item.feature;
        if (feature.geometry.type !== "Point") continue;
        const point = item.getLatLng();
        const [lng, lat, alt] = feature.geometry.coordinates;
        if (point.lat !== lat || point.lng !== lng || point.alt !== alt) throw new Error("Map coordinate order or precision changed");
        points++;
      }
      const firstPolygon = layers.find((item) => item.feature.properties.styleUrl === "#st0");
      const bounds = layer.getBounds();
      const checks = {
        features: data.features.features.length, coordinateSequences: converted.length, soundings: data.survey.soundings.length,
        exactMapPoints: points, minDepth: data.survey.minDepth, maxDepth: data.survey.maxDepth,
        originalPolygonColor: firstPolygon.getLayers()[0].options.fillColor,
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      };
      map.remove(); element.remove();
      return checks;
    });
    assert.equal(dataChecks.features, 1684);
    assert.equal(dataChecks.coordinateSequences, 1805);
    assert.equal(dataChecks.soundings, 1455);
    assert.equal(dataChecks.exactMapPoints, 1529);
    assert.equal(dataChecks.originalPolygonColor, "#a200ff");
    assert.ok(dataChecks.maxDepth < 0, "DXF label altitudes must not be treated as depths");
    await page.getByRole("button", { name: "ابدأ الملاحة", exact: true }).click({ timeout: 60000 });
    await page.getByLabel("أدخل اسم سفينتك").fill("MARINE 360 TEST");
    await page.getByRole("button", { name: "حفظ", exact: true }).click();
    await page.getByRole("checkbox", { name: "أوافق على شروط الاستخدام وإخلاء المسؤولية" }).check();
    await page.getByRole("button", { name: "نتمنى لك ملاحة آمنة", exact: true }).click();
    await page.locator(".startup-splash").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "خور عبد الله 11-13", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".kmz-depth-label").length === 1455);
    await page.screenshot({ path: resolve(output, `${name}-chart.png`) });
    await page.getByRole("button", { name: "إخفاء الأعماق", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelectorAll(".kmz-depth-label").length === 0);
    await page.getByRole("button", { name: "إظهار الأعماق", exact: true }).first().click();
    await page.waitForFunction(() => document.querySelectorAll(".kmz-depth-label").length === 1455);
    await page.getByRole("button", { name: "Model", exact: true }).click();
    const tab = page.getByRole("tab", { name: "خور عبد الله 11-13", exact: true });
    assert.equal(await tab.getAttribute("aria-selected"), "true");
    await page.getByRole("tab", { name: "مدخل النهر", exact: true }).click();
    await tab.click();
    assert.equal(await tab.getAttribute("aria-selected"), "true");
    await page.screenshot({ path: resolve(output, `${name}-model.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    results.push({ name, viewport, sourceHash, dataChecks, errors, status: "passed" });
    console.log(`${name}: original KML integrity, all coordinates, measurements, map/model, layer toggles and layout passed`);
    await context.close();
  }
} finally {
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ url, results }, null, 2));
  await browser.close();
}
