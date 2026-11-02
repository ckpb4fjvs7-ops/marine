import { getRequest } from "@tanstack/react-start/server";
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

let starting: Promise<{ ok: boolean; error?: string }> | null = null;
async function healthy(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:8092/health", { signal: AbortSignal.timeout(500) });
    const value = await response.json();
    return value.bridge === "marine360-udp-v1";
  } catch { return false; }
}

export async function ensureLocalUdpBridge(): Promise<{ ok: boolean; error?: string }> {
  const request = getRequest();
  const url = new URL(request.url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || process.env.VERCEL) return { ok: false, error: "شغّل خدمة UDP على الكمبيوتر المتصل بالجهاز بواسطة scripts/start-network-udp.ps1، ثم أعد الاتصال." };
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).origin !== url.origin) return { ok: false, error: "يجب تشغيل الخدمة من الموقع المحلي نفسه." };
  if (await healthy()) return { ok: true };
  if (starting) return starting;
  starting = (async () => {
    const script = join(process.cwd(), "scripts", "udp-bridge.mjs");
    if (!existsSync(script)) return { ok: false, error: "لم يُعثر على خدمة UDP المحلية. شغّل scripts/start-network-udp.ps1 من مجلد المشروع." };
    const directory = join(process.cwd(), "test-results", "network-udp");
    mkdirSync(directory, { recursive: true });
    const stdout = openSync(join(directory, "bridge.stdout.log"), "a");
    const stderr = openSync(join(directory, "bridge.stderr.log"), "a");
    let failure: Error | null = null;
    try {
      const child = spawn(process.execPath, ["--experimental-strip-types", script], { cwd: process.cwd(), detached: true, windowsHide: true, stdio: ["ignore", stdout, stderr] });
      child.on("error", (err) => { failure = err; });
      child.unref();
    } finally { closeSync(stdout); closeSync(stderr); }
    for (let attempt = 0; attempt < 25; attempt++) {
      if (failure) break;
      if (await healthy()) return { ok: true };
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { ok: false, error: "تعذر تشغيل خدمة UDP على 127.0.0.1:8092. راجع test-results/network-udp/bridge.stderr.log أو شغّل scripts/start-network-udp.ps1." };
  })();
  try { return await starting; } finally { starting = null; }
}
