import { useEffect, useRef, useState } from "react";
import { ensureUdpBridge } from "./network-bridge";
import { DEFAULT_UDP_CONFIG, normalizeBridgeUrl, parseUdpPreferences, UDP_BRIDGE_URL, UDP_SETTINGS_KEY, validateUdpConfig, type UdpBatch, type UdpConfig, type UdpStatus } from "./network-udp-types";

type Callbacks = { beforeConnect: () => Promise<void>; onLine: (line: string) => void; onStop: () => void };
type Connection = { url: string; config: UdpConfig; clientId: string; sessionId: string | null };

async function request(url: string, path: string, data?: unknown, keepalive = false): Promise<UdpStatus> {
  const response = await fetch(`${normalizeBridgeUrl(url)}${path}`, data === undefined
    ? { signal: AbortSignal.timeout(2000), cache: "no-store" }
    : { method: "POST", headers: { "Content-Type": "application/json", "X-Marine-Bridge": "1" }, body: JSON.stringify(data), keepalive, signal: keepalive ? undefined : AbortSignal.timeout(5000) });
  const value = await response.json();
  if (!response.ok || value.bridge !== "marine360-udp-v1") throw new Error(value.error || "المنفذ المحدد ليس خدمة MARINE 360 UDP.");
  return value;
}

export function useNetworkUdp(callbacks: Callbacks) {
  const [config, setConfig] = useState<UdpConfig>({ ...DEFAULT_UDP_CONFIG });
  const [bridgeUrl, setBridgeUrl] = useState(UDP_BRIDGE_URL);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<UdpStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "listening" | "reconnecting" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const callbacksRef = useRef(callbacks);
  const connectionRef = useRef<Connection | null>(null);
  const streamRef = useRef<EventSource | null>(null);
  const generationRef = useRef(0);
  const clientIdRef = useRef("");
  callbacksRef.current = callbacks;

  function clientId() {
    if (clientIdRef.current) return clientIdRef.current;
    try {
      clientIdRef.current = sessionStorage.getItem("marine360-udp-client-v1") || crypto.randomUUID();
      sessionStorage.setItem("marine360-udp-client-v1", clientIdRef.current);
    } catch { clientIdRef.current = crypto.randomUUID(); }
    return clientIdRef.current;
  }

  useEffect(() => {
    const generation = generationRef;
    try {
      const saved = parseUdpPreferences(localStorage.getItem(UDP_SETTINGS_KEY));
      setConfig(saved.config); setBridgeUrl(saved.bridgeUrl);
    } catch { /* defaults remain usable without browser storage */ }
    setReady(true);
    return () => {
      generation.current++;
      streamRef.current?.close();
      const current = connectionRef.current;
      if (current) void request(current.url, "/stop", { clientId: current.clientId, sessionId: current.sessionId }, true).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(UDP_SETTINGS_KEY, JSON.stringify({ config, bridgeUrl })); }
    catch { /* applying the connection still works */ }
  }, [config, bridgeUrl, ready]);

  async function probe(wake = false): Promise<UdpStatus> {
    const url = normalizeBridgeUrl(bridgeUrl);
    try {
      const value = await request(url, `/health?clientId=${encodeURIComponent(clientId())}`);
      setStatus(value); setError(null); return value;
    } catch {
      if (wake && url === UDP_BRIDGE_URL && ["127.0.0.1", "localhost", "[::1]"].includes(window.location.hostname)) {
        const started = await ensureUdpBridge();
        if (!started.ok) throw new Error(started.error);
        const value = await request(url, `/health?clientId=${encodeURIComponent(clientId())}`);
        setStatus(value); setError(null); return value;
      }
      throw new Error("خدمة UDP المحلية غير متاحة. شغّل scripts/start-network-udp.ps1 على هذا الكمبيوتر، واسمح بالوصول إلى الشبكة المحلية إذا طلب المتصفح ذلك.");
    }
  }

  async function refresh() {
    try { await probe(true); }
    catch (err) { setError(err instanceof Error ? err.message : "تعذر الوصول إلى خدمة UDP."); }
  }

  async function connect(nextConfig = config) {
    const validation = validateUdpConfig(nextConfig);
    if (validation) { setError(validation); return; }
    const generation = ++generationRef.current;
    streamRef.current?.close();
    const previous = connectionRef.current;
    if (previous?.config.sourceIp) callbacksRef.current.onStop();
    setConfig(nextConfig); setPhase("starting"); setError(null);
    let opened: Connection | null = null;
    try {
      const available = await probe(true);
      if (generation !== generationRef.current) return;
      if (available.active && !available.owned) throw new Error("UDP مفتوح في تبويب آخر. افصله هناك أولًا.");
      const url = normalizeBridgeUrl(bridgeUrl);
      const value = await request(url, "/start", { config: nextConfig, clientId: clientId() });
      opened = { url, config: nextConfig, clientId: clientId(), sessionId: value.sessionId };
      if (generation !== generationRef.current) { await request(url, "/stop", opened); return; }
      connectionRef.current = opened;
      if (nextConfig.sourceIp) await callbacksRef.current.beforeConnect();
      if (generation !== generationRef.current) return;
      setStatus(value);
      let lastId = 0;
      const source = new EventSource(`${url}/stream?clientId=${encodeURIComponent(clientId())}`);
      streamRef.current = source;
      source.onopen = () => { if (generation === generationRef.current) setPhase("listening"); };
      source.addEventListener("status", (event) => {
        if (generation !== generationRef.current) return;
        const next = JSON.parse((event as MessageEvent).data) as UdpStatus;
        setStatus(next);
        if (!next.active || !next.owned) {
          source.close(); setPhase(next.error ? "error" : "idle"); setError(next.error);
          if (nextConfig.sourceIp) callbacksRef.current.onStop();
        }
      });
      source.addEventListener("nmea", (event) => {
        if (generation !== generationRef.current || !nextConfig.sourceIp) return;
        const batch = JSON.parse((event as MessageEvent).data) as UdpBatch;
        if (batch.sessionId !== value.sessionId || batch.sourceIp !== nextConfig.sourceIp || batch.id <= lastId || Date.now() - batch.receivedAt > 5000 || Date.now() < batch.receivedAt) return;
        lastId = batch.id;
        for (const line of batch.lines) callbacksRef.current.onLine(line);
      });
      source.onerror = () => {
        if (generation !== generationRef.current) return;
        setPhase("reconnecting");
        if (nextConfig.sourceIp) callbacksRef.current.onStop();
      };
    } catch (err) {
      if (opened) void request(opened.url, "/stop", opened).catch(() => {});
      if (generation !== generationRef.current) return;
      setPhase("error"); setError(err instanceof Error ? err.message : "تعذر فتح UDP.");
    }
  }

  async function disconnect() {
    const generation = ++generationRef.current;
    streamRef.current?.close(); streamRef.current = null;
    const current = connectionRef.current; connectionRef.current = null;
    if (current?.config.sourceIp) callbacksRef.current.onStop();
    setPhase("idle");
    if (current) {
      try {
        const value = await request(current.url, "/stop", { clientId: current.clientId, sessionId: current.sessionId });
        if (generation === generationRef.current) setStatus(value);
      } catch { if (generation === generationRef.current) setStatus(null); }
    }
  }

  const running = (phase === "listening" || phase === "reconnecting") && Boolean(status?.active && status.owned);
  const navigationActive = (running || phase === "starting") && Boolean((connectionRef.current?.config ?? config).sourceIp);
  const live = running && phase === "listening" && Boolean(status?.stats.lastFixAt && Date.now() - status.stats.lastFixAt < 5000);
  return { config, setConfig, bridgeUrl, setBridgeUrl, status, phase, error, running, navigationActive, live, connect, disconnect, refresh };
}

export type NetworkUdpController = ReturnType<typeof useNetworkUdp>;
