import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const url = process.argv[2] || "http://127.0.0.1:8080/";
const target = new URL(url);
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
  throw new Error("Run this development smoke test against localhost only.");
}
const output = resolve("test-results/navigation");
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL
    ? { channel: process.env.BROWSER_CHANNEL }
    : process.platform === "win32" ? { channel: "msedge" } : {}),
});
const results = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const name = viewport.width > 1000 ? "desktop" : "mobile";
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const pageErrors = [];
    const checks = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    assert.equal(response?.status(), 200);
    await page.getByRole("button", { name: "ابدأ الملاحة", exact: true }).click({ timeout: 60000 });
    await page.getByLabel("أدخل اسم سفينتك").fill("MARINE 360 TEST");
    await page.getByRole("button", { name: "حفظ", exact: true }).click();
    await page.getByRole("checkbox", { name: "أوافق على شروط الاستخدام وإخلاء المسؤولية" }).check();
    await page.getByRole("button", { name: "نتمنى لك ملاحة آمنة", exact: true }).click();
    await page.locator(".startup-splash").waitFor({ state: "detached" });
    await page.locator(".leaflet-container").waitFor();
    await page.waitForFunction(() => document.querySelector(".leaflet-marker-icon"));
    checks.push("onboarding, survey data and chart initialized");

    await page.getByRole("button", { name: "Both", exact: true }).click();
    await page.getByRole("tab", { name: "مدخل النهر", exact: true }).click();
    assert.equal(await page.getByRole("tab", { name: "مدخل النهر", exact: true }).getAttribute("aria-selected"), "true");
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page.locator("canvas").first().waitFor({ state: "visible" });
    assert.ok(await page.locator("canvas").first().evaluate((canvas) => canvas.width > 0 && canvas.height > 0));
    await page.screenshot({ path: resolve(output, `${name}-model.png`) });
    checks.push("chart/model/both and river depth model switch");

    await page.getByRole("tab", { name: "Chart display", exact: true }).click();
    const marks = page.getByRole("button", { name: "Marks & hazards", exact: true });
    const pressed = await marks.getAttribute("aria-pressed");
    await marks.click();
    assert.notEqual(await marks.getAttribute("aria-pressed"), pressed);
    await marks.click();
    await page.getByRole("button", { name: "إظهار الأعماق", exact: true }).first().click();
    await page.locator(".leaflet-image-layer").first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Course up", exact: true }).click();
    await page.getByRole("button", { name: "North up", exact: true }).click();
    await page.getByRole("tab", { name: "Chart display", exact: true }).click();
    checks.push("depth overlays, seamarks and chart orientation");

    await page.getByLabel("Latitude", { exact: true }).fill("30 02 46.05");
    await page.getByLabel("Longitude", { exact: true }).fill("047 57 10.66");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    assert.match(await page.getByLabel("Latitude", { exact: true }).inputValue(), /30 02 46/);
    checks.push("manual position entry");

    await page.getByRole("tab", { name: "Route planning", exact: true }).click();
    await page.getByLabel("Latitude waypoint 1", { exact: true }).fill("30 03 00");
    await page.getByLabel("Longitude waypoint 1", { exact: true }).fill("047 57 00");
    await page.getByRole("button", { name: "إضافة نقطة", exact: true }).click();
    await page.getByLabel("Latitude waypoint 2", { exact: true }).fill("30 04 00");
    await page.getByLabel("Longitude waypoint 2", { exact: true }).fill("047 58 00");
    await page.getByRole("button", { name: "اعتماد المسار", exact: true }).click();
    await page.getByRole("button", { name: "Undo WP", exact: true }).waitFor();
    await page.getByRole("button", { name: "Clear route", exact: true }).click();
    await page.getByRole("button", { name: "Clear route", exact: true }).waitFor({ state: "detached" });
    checks.push("two-waypoint route creation and clearing");

    await page.getByRole("tab", { name: "Route monitoring", exact: true }).click();
    const vrm = page.getByRole("button", { name: "VRM/EBL", exact: true });
    await vrm.click();
    await page.getByLabel("EBL bearing degrees true").fill("90");
    await page.getByLabel("VRM range nautical miles").fill("0.5");
    assert.equal(await vrm.getAttribute("aria-pressed"), "true");
    await vrm.click();
    for (const label of ["PAST TRACK", "COURSE LINE"]) {
      const button = page.getByRole("button", { name: label, exact: true });
      const before = await button.getAttribute("aria-pressed");
      await button.click();
      assert.notEqual(await button.getAttribute("aria-pressed"), before);
      await button.click();
    }
    checks.push("VRM/EBL, past track and course line controls");

    await page.getByRole("tab", { name: "Sensors & connections", exact: true }).click();
    for (const label of ["Connect JRC", "DGPS Bluetooth", "Bluetooth COM / SPP", "Connect sounder", "Own ship GPS"]) {
      assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 1);
    }
    await page.getByRole("combobox", { name: "Port baud rate" }).selectOption("9600");
    checks.push("sensor controls and baud selection (no hardware connection)");
    await page.getByRole("tab", { name: "Windows", exact: true }).click();
    await page.getByRole("checkbox", { name: /Navigation information/ }).check();
    await page.getByRole("region", { name: "Live navigation information" }).waitFor({ state: "visible" });
    await page.getByRole("tab", { name: "Windows", exact: true }).click();
    await page.getByRole("button", { name: /Switch to light mode|Switch to dark mode/ }).click();
    checks.push("navigation window and theme switch");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: resolve(output, `${name}-chart.png`) });
    results.push({ name, viewport, checks, pageErrors, status: "passed" });
    console.log(`${name}: ${checks.length} UI checks passed`);
    await context.close();
  }
} finally {
  writeFileSync(resolve(output, "results.json"), JSON.stringify({ url, results }, null, 2));
  await browser.close();
}
