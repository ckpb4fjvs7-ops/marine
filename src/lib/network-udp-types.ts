export const UDP_BRIDGE_URL = "http://127.0.0.1:8092";
export const UDP_SETTINGS_KEY = "marine360-network-udp-v1";
export type UdpConfig = {
  sourceIp: string;
  port: number;
  mode: "multicast" | "unicast";
  group: string;
  interfaceIp: string;
  requireChecksum: boolean;
};
export const DEFAULT_UDP_CONFIG: UdpConfig = {
  sourceIp: "", port: 60004, mode: "multicast", group: "239.192.0.4", interfaceIp: "0.0.0.0", requireChecksum: true,
};
export type UdpInterface = { name: string; address: string; netmask: string; internal: boolean };
export type UdpStatus = {
  bridge: "marine360-udp-v1";
  active: boolean;
  owned: boolean;
  sessionId: string | null;
  config: UdpConfig | null;
  interfaces: UdpInterface[];
  error: string | null;
  stats: {
    packets: number; bytes: number; filtered: number; sentences: number; invalidChecksums: number;
    fixes: number; unsupported: number; lastPacketAt: number | null; lastFixAt: number | null;
    lastNmeaAt: number | null; lastLine: string; format: string;
    senders: Array<{ ip: string; port: number; packets: number; lastAt: number }>;
  };
};
export type UdpBatch = { id: number; sessionId: string; sourceIp: string; sourcePort: number; receivedAt: number; lines: string[] };

export function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

export function validateUdpConfig(value: UdpConfig): string | null {
  if (!value || typeof value.sourceIp !== "string" || typeof value.interfaceIp !== "string" || typeof value.group !== "string") return "إعدادات IP غير صحيحة.";
  if (value.sourceIp && (!isIpv4(value.sourceIp) || Number(value.sourceIp.split(".")[0]) >= 224 || value.sourceIp === "0.0.0.0")) return "أدخل IP صحيحًا للجهاز المرسل، أو اتركه فارغًا للاكتشاف فقط.";
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return "يجب أن يكون UDP Port رقمًا من 1 إلى 65535.";
  if (value.mode !== "unicast" && value.mode !== "multicast") return "اختر وضع UDP صحيحًا.";
  if (!isIpv4(value.interfaceIp)) return "عنوان بطاقة الشبكة المحلية غير صحيح.";
  if (value.mode === "multicast" && (!isIpv4(value.group) || Number(value.group.split(".")[0]) < 224 || Number(value.group.split(".")[0]) > 239)) return "عنوان Multicast يجب أن يكون ضمن 224.0.0.0 إلى 239.255.255.255.";
  if (typeof value.requireChecksum !== "boolean") return "إعداد checksum غير صحيح.";
  return null;
}

export function normalizeBridgeUrl(value: string): string {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password) throw new Error("استخدم عنوان خدمة UDP المحلية: http://127.0.0.1:8092");
  return url.origin;
}

export function parseUdpPreferences(raw: string | null): { config: UdpConfig; bridgeUrl: string } {
  try {
    const saved = JSON.parse(raw ?? "null");
    if (!saved || typeof saved !== "object") throw new Error();
    const config = { ...DEFAULT_UDP_CONFIG, ...saved.config } as UdpConfig;
    if (validateUdpConfig(config)) throw new Error();
    return { config, bridgeUrl: normalizeBridgeUrl(saved.bridgeUrl ?? UDP_BRIDGE_URL) };
  } catch { return { config: { ...DEFAULT_UDP_CONFIG }, bridgeUrl: UDP_BRIDGE_URL }; }
}
