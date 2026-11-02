import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import { parseNmeaLine, parseDepthLine } from "../src/lib/nmea.ts";
import { DEFAULT_UDP_CONFIG, validateUdpConfig } from "../src/lib/network-udp-types.ts";
import { UdpNmeaDecoder } from "./udp-nmea.mjs";

export function localInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, values]) => (values ?? [])
    .filter((item) => item.family === "IPv4")
    .map(({ address, netmask, internal }) => ({ name, address, netmask, internal })));
}

function emptyStats() {
  return { packets: 0, bytes: 0, filtered: 0, sentences: 0, invalidChecksums: 0, fixes: 0, unsupported: 0, lastPacketAt: null, lastFixAt: null, lastNmeaAt: null, lastLine: "", format: "", senders: [] };
}

export class UdpReceiver extends EventEmitter {
  socket = null;
  owner = null;
  config = null;
  sessionId = null;
  error = null;
  stats = emptyStats();
  decoder = new UdpNmeaDecoder();
  sequence = 0;
  history = [];
  busy = false;

  snapshot(clientId) {
    return { bridge: "marine360-udp-v1", active: this.socket != null, owned: this.owner === clientId, sessionId: this.sessionId, config: this.config, error: this.error, interfaces: localInterfaces(), stats: this.stats };
  }

  async start(input, clientId) {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(clientId ?? "")) throw new Error("معرّف جلسة UDP غير صحيح.");
    const config = { ...DEFAULT_UDP_CONFIG, ...input };
    const error = validateUdpConfig(config);
    if (error) throw new Error(error);
    if (config.interfaceIp !== "0.0.0.0" && !localInterfaces().some((item) => item.address === config.interfaceIp)) throw new Error("IP بطاقة الشبكة المحددة غير موجود على هذا الكمبيوتر. حدّث قائمة البطاقات واختر بطاقة الاتصال بالجهاز.");
    if (this.owner && this.owner !== clientId) throw new Error("يوجد اتصال UDP مملوك لتبويب آخر. افصله من ذلك التبويب أولًا.");
    if (this.busy) throw new Error("يجري فتح منفذ UDP. انتظر اكتمال العملية.");
    if (this.socket && JSON.stringify(this.config) === JSON.stringify(config)) return;
    this.busy = true;
    try {
      await this.stop(clientId);
      this.owner = clientId;
      this.config = config;
      this.sessionId = randomUUID();
      this.stats = emptyStats();
      this.history = [];
      this.error = null;
      this.decoder = new UdpNmeaDecoder();
      const socket = createSocket({ type: "udp4", reuseAddr: config.mode === "multicast" });
      socket.on("message", (bytes, remote) => this.packet(bytes, remote));
      await new Promise((resolve, reject) => {
        const failed = (err) => { try { socket.close(); } catch { /* not bound */ } reject(err); };
        socket.once("error", failed);
        socket.bind({ port: config.port, address: config.mode === "multicast" ? "0.0.0.0" : config.interfaceIp }, () => {
          socket.removeListener("error", failed);
          try {
            if (config.mode === "multicast") socket.addMembership(config.group, config.interfaceIp === "0.0.0.0" ? undefined : config.interfaceIp);
            try { socket.setRecvBufferSize(1024 * 1024); } catch { /* retain the OS default buffer */ }
            resolve();
          } catch (err) { failed(err); }
        });
      });
      this.socket = socket;
      socket.on("error", (err) => {
        this.error = explainSocketError(err);
        this.socket = null;
        try { socket.close(); } catch { /* already closed */ }
        this.emit("status");
      });
      this.emit("status");
    } catch (err) {
      this.owner = null;
      this.socket = null;
      this.error = explainSocketError(err);
      this.emit("status");
      throw new Error(this.error);
    } finally { this.busy = false; }
  }

  async stop(clientId, force = false) {
    if (!force && this.owner && this.owner !== clientId) throw new Error("لا يمكن فصل اتصال تابع لتبويب آخر.");
    const socket = this.socket;
    this.socket = null;
    this.owner = null;
    if (socket) await new Promise((resolve) => { try { socket.close(resolve); } catch { resolve(); } });
    this.emit("status");
  }

  packet(bytes, remote) {
    const now = Date.now();
    const stats = this.stats;
    stats.packets++;
    stats.bytes += bytes.length;
    stats.lastPacketAt = now;
    let sender = stats.senders.find((item) => item.ip === remote.address);
    if (!sender) {
      sender = { ip: remote.address, port: remote.port, packets: 0, lastAt: now };
      stats.senders.push(sender);
      if (stats.senders.length > 16) stats.senders.shift();
    }
    sender.packets++;
    sender.lastAt = now;
    if (this.config.sourceIp && this.config.sourceIp !== remote.address) { stats.filtered++; return; }
    const decoded = this.decoder.decode(bytes, `${remote.address}:${remote.port}`, this.config.requireChecksum);
    stats.invalidChecksums += decoded.invalidChecksums;
    stats.unsupported += decoded.unsupported;
    stats.format = decoded.format;
    const lines = decoded.lines.filter((line) => {
      const fix = parseNmeaLine(line);
      const depth = parseDepthLine(line);
      if (fix?.valid && fix.lat != null && fix.lng != null) { stats.fixes++; stats.lastFixAt = now; }
      if (!fix && !depth) stats.unsupported++;
      return fix != null || depth != null;
    });
    stats.sentences += decoded.lines.length;
    if (decoded.lines.length) { stats.lastNmeaAt = now; stats.lastLine = decoded.lines.at(-1); }
    if (!lines.length) return;
    const batch = { id: ++this.sequence, sessionId: this.sessionId, sourceIp: remote.address, sourcePort: remote.port, receivedAt: now, lines };
    this.history.push(batch);
    if (this.history.length > 128) this.history.shift();
    this.emit("nmea", batch);
  }
}

function explainSocketError(err) {
  if (err?.code === "EADDRINUSE") return "منفذ UDP مستخدم ببرنامج آخر. أغلق المستمع الآخر أو اختر منفذ الإرسال الصحيح.";
  if (err?.code === "EADDRNOTAVAIL") return "بطاقة الشبكة أو IP المحلي غير متاح. اختر بطاقة متصلة بالجهاز.";
  if (err?.code === "EACCES" || err?.code === "EPERM") return "النظام منع فتح منفذ UDP. راجع جدار الحماية وصلاحية برنامج Node على شبكة الجهاز.";
  return err?.message || "تعذر فتح منفذ UDP.";
}

export async function startBridge({ port = 8092, allowOrigins = [], receiver = new UdpReceiver() } = {}) {
  const allowed = new Set(["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080", ...allowOrigins]);
  const subscribers = new Set();
  let orphanTimer;
  const scheduleCleanup = () => {
    clearTimeout(orphanTimer);
    if (!subscribers.size && receiver.owner) orphanTimer = setTimeout(() => void receiver.stop(null, true), 15000);
  };
  const json = (res, code, value) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  const sendStatus = () => {
    for (const item of subscribers) {
      if (item.res.writableEnded || item.res.destroyed) { subscribers.delete(item); continue; }
      item.res.write(`event: status\ndata: ${JSON.stringify(receiver.snapshot(item.clientId))}\n\n`);
    }
  };
  receiver.on("status", sendStatus);
  receiver.on("nmea", (batch) => {
    const payload = `id: ${batch.id}\nevent: nmea\ndata: ${JSON.stringify(batch)}\n\n`;
    for (const item of subscribers) {
      if (item.res.writableEnded || item.res.destroyed) { subscribers.delete(item); continue; }
      if (receiver.owner !== item.clientId) continue;
      if (item.res.writableLength > 256 * 1024) { item.res.destroy(); continue; }
      item.res.write(payload);
    }
  });
  const server = createServer(async (req, res) => {
    res.on("error", () => res.destroy());
    try {
      const host = (req.headers.host ?? "").split(":")[0];
      if (!["127.0.0.1", "localhost"].includes(host)) return json(res, 403, { error: "Local bridge only" });
      const origin = req.headers.origin;
      if (origin && !allowed.has(origin)) return json(res, 403, { error: "Origin not allowed" });
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Marine-Bridge, Last-Event-ID");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      const url = new URL(req.url, "http://127.0.0.1");
      const clientId = url.searchParams.get("clientId");
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, receiver.snapshot(clientId));
      if (req.method === "GET" && url.pathname === "/stream") {
        if (!clientId || receiver.owner !== clientId || !receiver.socket) return json(res, 409, { error: "لا توجد جلسة UDP مفتوحة لهذا التبويب." });
        clearTimeout(orphanTimer);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        const item = { clientId, res };
        subscribers.add(item);
        res.write(`event: status\ndata: ${JSON.stringify(receiver.snapshot(clientId))}\n\n`);
        const after = Number(req.headers["last-event-id"] ?? 0);
        for (const batch of receiver.history) {
          if (batch.id > after && batch.sessionId === receiver.sessionId && Date.now() - batch.receivedAt <= 5000) res.write(`id: ${batch.id}\nevent: nmea\ndata: ${JSON.stringify(batch)}\n\n`);
        }
        res.on("close", () => { subscribers.delete(item); scheduleCleanup(); });
        return;
      }
      if (req.method !== "POST" || !["/start", "/stop"].includes(url.pathname)) return json(res, 404, { error: "Not found" });
      if (req.headers["x-marine-bridge"] !== "1" || !req.headers["content-type"]?.startsWith("application/json")) return json(res, 403, { error: "Bridge control requires JSON and X-Marine-Bridge" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) return json(res, 413, { error: "Request too large" });
      }
      const input = JSON.parse(body);
      if (url.pathname === "/start") { await receiver.start(input.config, input.clientId); scheduleCleanup(); }
      else if (!input.sessionId || input.sessionId === receiver.sessionId) await receiver.stop(input.clientId);
      return json(res, 200, receiver.snapshot(input.clientId));
    } catch (err) { if (!res.headersSent) json(res, 400, { error: err.message }); else res.end(); }
  });
  const heartbeat = setInterval(sendStatus, 1000);
  heartbeat.unref();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return {
    receiver, server, url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      clearInterval(heartbeat); clearTimeout(orphanTimer);
      const closing = [...subscribers]; subscribers.clear();
      for (const item of closing) item.res.end();
      await receiver.stop(null, true);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const port = portIndex < 0 ? 8092 : Number(args[portIndex + 1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid bridge HTTP port");
  const allowOrigins = args.flatMap((arg, i) => arg === "--allow-origin" ? [new URL(args[i + 1]).origin] : []);
  const bridge = await startBridge({ port, allowOrigins });
  console.log(`MARINE 360 UDP bridge ready: ${bridge.url}`);
  console.log("UDP opens only when Connect is selected in Sensors & connections.");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => void bridge.close().then(() => process.exit(0)));
}
