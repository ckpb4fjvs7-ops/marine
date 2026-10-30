import { useCallback, useEffect, useRef, useState } from "react";
import type L from "leaflet";
import type * as THREE from "three";
import { LocateFixed, Map as MapIcon, Box, Crosshair, Cable, Bluetooth, Flag, Moon, Sun, Move, Cloud, Wind, Waves, RefreshCw, X, Compass, Radio, Ship, LayoutGrid, Clock } from "lucide-react";
import { parseDepthLine, parseNmeaLine, type NmeaFix } from "@/lib/nmea";
import { describeUmmTide, type TideTurn } from "@/lib/tide";
import { compassDirection, describeWeatherCode, getCurrentWeather, type WeatherSnapshot } from "@/lib/weather";
import { getNearbyAis } from "@/lib/ais-source";
import type { AisTarget } from "@/lib/ais";
import { getUmmQasrTide } from "@/lib/umm-tide";
import { notifyAnchorBreach } from "@/lib/anchor-alert";
import { ScrollFade } from "@animate-ui/react/primitives/effects/scroll-fade";
import { StartupSplash } from "@/components/startup-splash";
import { NavtexPanel } from "@/components/navtex-panel";
import { MarineClock } from "@/components/marine-clock";
import { CHANNEL_MARKS, type ChannelMark } from "@/lib/channel-marks";
import {
  LEGEND,
  completeChannel,
  crossTrack,
  depthCss,
  depthRgb,
  destinationPoint,
  haversineKm,
  project,
  sampleAt,
  unproject,
  type CrossTrack,
  type Survey,
} from "@/lib/survey";

const SHIP_ICON =
  '<span class="ship-rot"><svg viewBox="0 0 64 64" width="48" height="48" aria-hidden="true"><path d="M32 4 L46 26 L44 50 Q32 60 20 50 L18 26 Z" fill="#f0b64f" stroke="#173746" stroke-width="2.5" stroke-linejoin="round"/><path d="M32 12 V28" stroke="#173746" stroke-width="2" stroke-linecap="round"/><rect x="25" y="30" width="14" height="11" rx="1.5" fill="#087f83"/><path d="M18 42 H46" stroke="#173746" stroke-width="1.6"/></svg></span><span class="ship-fix"></span>';

type ShipPort = {
  open(options: {
    baudRate: number;
    dataBits?: number;
    stopBits?: number;
    parity?: "none" | "even" | "odd";
    bufferSize?: number;
    flowControl?: "none" | "hardware";
  }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
};

type BleNmeaCharacteristic = {
  value: DataView | null;
  properties?: { notify?: boolean };
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  addEventListener(type: "characteristicvaluechanged", listener: EventListener): void;
  removeEventListener(type: "characteristicvaluechanged", listener: EventListener): void;
};

type BleNmeaDevice = {
  name?: string;
  gatt?: {
    connected: boolean;
    connect(): Promise<{
      getPrimaryServices(): Promise<Array<{
        getCharacteristics(): Promise<BleNmeaCharacteristic[]>;
      }>>;
    }>;
    disconnect(): void;
  };
  addEventListener(type: "gattserverdisconnected", listener: EventListener): void;
  removeEventListener(type: "gattserverdisconnected", listener: EventListener): void;
};

type WebBluetoothApi = {
  requestDevice(options: { acceptAllDevices: true; optionalServices: Array<string | number> }): Promise<BleNmeaDevice>;
};

const BLE_NMEA_SERVICES = [
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART Service
  "0000ffe0-0000-1000-8000-00805f9b34fb", // HM-10 UART service
];

const JRC_BAUDS = [4800, 9600, 19200, 38400];
const DGPS_BAUDS = [4800, 9600, 19200, 38400, 57600, 115200, 2400];

function jrcSerial(): { requestPort(): Promise<ShipPort> } | null {
  const serial = (navigator as Navigator & { serial?: { requestPort(): Promise<ShipPort> } }).serial;
  return serial ?? null;
}

function inPreviewFrame(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

function standaloneHref(): string {
  const url = new URL(window.location.href);
  url.searchParams.set("jrc", "1");
  return url.toString();
}

type Hit = { lat: number; lng: number; depth: number | null };
type WpRow = { id: number; lat: string; lng: string; ns: "N" | "S"; ew: "E" | "W" };
type ViewMode = "map" | "model" | "both";
type PlanPoint = { lat: number; lng: number };
type WeatherLocationMode = "port" | "ship";
const UMM_QASR_PORT = { lat: 30 + 2 / 60, lng: 47 + 57 / 60 };

const SATELLITE =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const CHART = "https://t2.openseamap.org/tile/{z}/{x}/{y}.png";
const SEAMARK = "https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png";

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&" + "amp;";
    if (ch === "<") return "&" + "lt;";
    if (ch === ">") return "&" + "gt;";
    if (ch === '"') return "&" + "quot;";
    return "&#" + "39;";
  });
}

function parseCoord(raw: string, limit: number, negative: boolean): number | null {
  let text = raw.trim();
  if (!text) return null;
  text = text.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  text = text.replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)));
  const south = /[Ss]/.test(text);
  const west = /[Ww]/.test(text);
  const north = /[Nn]/.test(text);
  const east = /[Ee]/.test(text);
  text = text.replace(/[NnSsEeWw]/g, " ");
  text = text.replace(/[º°]/g, " ").replace(/['′’]/g, " ").replace(/["″”]/g, " ");
  text = text.replace(/[٫،,]/g, ".");
  text = text.replace(/(\d)[-–−](\d)/g, "$1.$2");
  text = text.replace(/\s+/g, " ").trim();
  const chunks = text.split(" ").filter(Boolean);
  let value: number;
  if (chunks.length === 1 && chunks[0].split(".").length >= 3) {
    const bits = chunks[0].split(".");
    const degrees = Number(bits[0]);
    if (!Number.isFinite(degrees)) return null;
    const minutes = bits.length === 3 ? Number(`${bits[1]}.${bits[2]}`) : Number(bits[1]);
    const seconds = bits.length >= 4 ? Number(`${bits[2]}.${bits.slice(3).join("")}`) : 0;
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || minutes >= 60 || seconds >= 60) return null;
    const sign = degrees < 0 ? -1 : 1;
    value = sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
  } else {
    const parts = chunks.map(Number);
    if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 1) {
      const abs = Math.abs(parts[0]);
      if (abs <= limit) value = parts[0];
      else {
        const degrees = Math.floor(abs / 100);
        const minutes = abs - degrees * 100;
        if (degrees > limit || minutes >= 60) return null;
        value = Math.sign(parts[0] || 1) * (degrees + minutes / 60);
      }
    } else {
      let minutes = Math.abs(parts[1]);
      let seconds = parts.length > 2 ? Math.abs(parts[2]) : 0;
      let degrees = Math.abs(parts[0]);
      if (seconds >= 60) {
        minutes += Math.floor(seconds / 60);
        seconds -= Math.floor(seconds / 60) * 60;
      }
      if (minutes >= 60) {
        degrees += Math.floor(minutes / 60);
        minutes -= Math.floor(minutes / 60) * 60;
      }
      const sign = parts[0] < 0 ? -1 : 1;
      value = sign * (degrees + minutes / 60 + seconds / 3600);
    }
  }
  if (Math.abs(value) > limit) return null;
  if (south || west) value = -Math.abs(value);
  else if (north || east) value = Math.abs(value);
  else if (negative) value = -Math.abs(value);
  return value;
}

function formatDms(value: number, degreeWidth: number): string {
  const abs = Math.abs(value);
  let degrees = Math.floor(abs);
  let minutes = Math.floor((abs - degrees) * 60);
  let seconds = (abs - degrees - minutes / 60) * 3600;
  if (seconds >= 59.995) {
    seconds = 0;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes = 0;
    degrees += 1;
  }
  return `${String(degrees).padStart(degreeWidth, "0")} ${String(minutes).padStart(2, "0")} ${seconds.toFixed(2).padStart(5, "0")}`;
}

function formatCourse(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const deg = ((Math.round(value) % 360) + 360) % 360;
  return String(deg).padStart(3, "0");
}

function formatDepth(depth: number | null): string {
  if (depth == null) return "Outside survey lines";
  const abs = Math.abs(depth).toFixed(2);
  if (depth < -0.05) return `${abs} m below surface`;
  if (depth > 0.05) return `${abs} m above datum`;
  return "About at the surface";
}

function coverage(surveys: Survey[], lat: number, lng: number): { km: number; inside: boolean } {
  let km = Infinity;
  let inside = false;
  for (const data of surveys) {
    km = Math.min(km, haversineKm(lat, lng, (data.south + data.north) / 2, (data.west + data.east) / 2));
    if (lat >= data.south && lat <= data.north && lng >= data.west && lng <= data.east) inside = true;
  }
  return { km: Number.isFinite(km) ? km : 0, inside };
}

function depthFromSurveys(surveys: Survey[], lat: number, lng: number): number | null {
  let depth: number | null = null;
  for (const data of surveys) {
    const sample = sampleAt(data, lat, lng);
    if (sample.depth != null) depth = sample.depth;
  }
  return depth;
}

function initialBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const p = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * p) * Math.cos(lat2 * p);
  const x =
    Math.cos(lat1 * p) * Math.sin(lat2 * p) -
    Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos((lng2 - lng1) * p);
  return (Math.atan2(y, x) * 180) / Math.PI + 360;
}

function formatNm(km: number, digits = 1): string {
  return `${(km / 1.852).toFixed(digits)} NM`;
}

function offsetReadout(offset: CrossTrack | null): { value: string; unit: string } | null {
  if (!offset) return null;
  if (offset.side === "on track") return { value: "on track", unit: "" };
  if (offset.meters >= 1852) return { value: (offset.meters / 1852).toFixed(2), unit: `${offset.side} NM` };
  return { value: String(Math.round(offset.meters)), unit: `${offset.side} m` };
}

const LEGEND_GRADIENT = `linear-gradient(to right, ${LEGEND.map((stop) => {
  const pct = ((stop - LEGEND[0]) / (LEGEND[LEGEND.length - 1] - LEGEND[0])) * 100;
  return `${depthCss(stop)} ${pct}%`;
}).join(",")})`;

function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

type EtaQuote = {
  km: number;
  nm: number;
  bearing: number;
  minutes: number | null;
  arrival: string | null;
  reason: "ok" | "no-speed" | "stopped" | "there";
};

function etaQuote(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
  sogKn: number | null,
): EtaQuote {
  const km = haversineKm(lat1, lng1, lat2, lng2);
  const nm = km / 1.852;
  const bearing = initialBearing(lat1, lng1, lat2, lng2) % 360;
  if (km < 0.03) return { km, nm, bearing, minutes: 0, arrival: null, reason: "there" };
  if (sogKn == null) return { km, nm, bearing, minutes: null, arrival: null, reason: "no-speed" };
  if (sogKn < 0.2) return { km, nm, bearing, minutes: null, arrival: null, reason: "stopped" };
  const hours = nm / sogKn;
  const minutes = Math.max(1, Math.round(hours * 60));
  const at = new Date(Date.now() + hours * 3600000);
  const arrival = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return { km, nm, bearing, minutes, arrival, reason: "ok" };
}

export function SurveyExplorer() {
  const mapEl = useRef<HTMLDivElement>(null);
  const viewEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const seamarkRef = useRef<L.TileLayer | null>(null);
  const daymarkLayerRef = useRef<L.LayerGroup | null>(null);
  const daymarkGroupRef = useRef<THREE.Group | null>(null);
  const daymarksOnRef = useRef(true);
  const baseRef = useRef<"chart" | "satellite">("chart");
  const seamarksRef = useRef(true);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const depthLayerRef = useRef<L.ImageOverlay | null>(null);
  const depthChromeRef = useRef<L.LayerGroup | null>(null);
  const depthsOnRef = useRef(false);
  const pickRef = useRef<L.Marker | null>(null);
  const leafletRef = useRef<typeof L | null>(null);
  const destMarkerRef = useRef<L.Marker | null>(null);
  const routeRef = useRef<L.Polyline | null>(null);
  const trackPtsRef = useRef<Array<[number, number]>>([]);
  const trackLineRef = useRef<L.Polyline | null>(null);
  const courseLineRef = useRef<L.Polyline | null>(null);
  const vrmCircleRef = useRef<L.Circle | null>(null);
  const eblLineRef = useRef<L.Polyline | null>(null);
  const vrmOnRef = useRef(false);
  const eblDegRef = useRef(0);
  const vrmNmRef = useRef(0.5);
  const armAnchorRef = useRef<(lat: number, lng: number) => void>(() => {});
  const setVrmFromChartRef = useRef<(lat: number, lng: number) => void>(() => {});
  const anchorOnRef = useRef(false);
  const anchorRef = useRef<{ lat: number; lng: number } | null>(null);
  const anchorRadiusRef = useRef(100);
  const anchorOutRef = useRef(false);
  const anchorAckRef = useRef(false);
  const anchorPickRef = useRef(false);
  const anchorShownRef = useRef<number | null>(null);
  const anchorCircleRef = useRef<L.Circle | null>(null);
  const anchorMarkRef = useRef<L.Marker | null>(null);
  const anchorLineRef = useRef<L.Polyline | null>(null);
  const beepRef = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const aisLayerRef = useRef<L.LayerGroup | null>(null);
  const aisMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const trackOnRef = useRef(true);
  const courseOnRef = useRef(true);
  const courseUpRef = useRef(false);
  const courseMinRef = useRef(6);
  const planOnRef = useRef(false);
  const planPtsRef = useRef<PlanPoint[]>([]);
  const planLineRef = useRef<L.Polyline | null>(null);
  const planMarksRef = useRef<L.LayerGroup | null>(null);
  const planLinkRef = useRef<L.Polyline | null>(null);
  const drawPlanRef = useRef<() => void>(() => {});
  const addPlanRef = useRef<(lat: number, lng: number) => void>(() => {});
  const spinGuardRef = useRef(false);
  const paintShipRef = useRef<(course: number | null) => void>(() => {});
  const cogRef = useRef<number | null>(null);
  const headingRef = useRef<number | null>(null);
  const sogRef = useRef<number | null>(null);
  const syncNavRef = useRef<(lat: number, lng: number) => void>(() => {});
  const etaModeRef = useRef(false);
  const voyageOnRef = useRef(false);
  const voyageLayerRef = useRef<L.LayerGroup | null>(null);
  const fittedDestRef = useRef("");
  const surveyRef = useRef<Survey | null>(null);
  const surveysRef = useRef<Survey[]>([]);
  const depthLayersRef = useRef<L.ImageOverlay[]>([]);
  const showDepthMapRef = useRef<(key: "gas" | "river") => void>(() => {});
  const depthMapRef = useRef<"gas" | "river">("gas");
  const pinRef = useRef<THREE.Group | null>(null);
  const bedRef = useRef<THREE.Mesh | null>(null);
  const exagRef = useRef(6);
  const shipSizeRef = useRef(1);
  const depthOffsetRef = useRef(0);
  const hitRef = useRef<Hit | null>(null);
  const watchRef = useRef<number | null>(null);
  const serialPortRef = useRef<ShipPort | null>(null);
  const serialReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const serialDoneRef = useRef<Promise<void>>(Promise.resolve());
  const serialStopRef = useRef(false);
  const bluetoothDeviceRef = useRef<BleNmeaDevice | null>(null);
  const bluetoothCharacteristicRef = useRef<BleNmeaCharacteristic | null>(null);
  const bluetoothValueHandlerRef = useRef<EventListener | null>(null);
  const bluetoothDisconnectHandlerRef = useRef<EventListener | null>(null);
  const sounderPortRef = useRef<ShipPort | null>(null);
  const sounderReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const sounderDoneRef = useRef<Promise<void>>(Promise.resolve());
  const sounderStopRef = useRef(false);
  const shipFramedRef = useRef(false);
  const syncPinRef = useRef<(lat: number, lng: number) => void>(() => {});
  const frameShipRef = useRef<(lat: number, lng: number) => void>(() => {});
  const stopTrackingRef = useRef<() => void>(() => {});
  const apiRef = useRef<{
    place?: (lat: number, lng: number, pan: boolean) => void;
    focus?: (lat: number, lng: number) => void;
    locate?: (lat: number, lng: number, sogKn?: number | null, headingDeg?: number | null) => void;
  }>({});

  const [survey, setSurvey] = useState<Survey | null>(null);
  const [depthMap, setDepthMap] = useState<"gas" | "river">("gas");
  const [error, setError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [shipName, setShipName] = useState("");
  const dismissSplash = useCallback(() => {
    setShipName(window.localStorage.getItem("own-ship-name")?.trim() || "");
    setBooting(false);
  }, []);
  useEffect(() => {
    if (shipName) document.title = shipName;
  }, [shipName]);
  const [hit, setHit] = useState<Hit | null>(null);
  const [gpsNote, setGpsNote] = useState<string | null>(null);
  const [base, setBase] = useState<"chart" | "satellite">("chart");
  const [seamarks, setSeamarks] = useState(true);
  const [daymarksOn, setDaymarksOn] = useState(true);
  const [depthsOn, setDepthsOn] = useState(false);
  const [exag, setExag] = useState(6);
  const [shipSize, setShipSize] = useState(1);
  const [depthOffset, setDepthOffset] = useState(0);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [pane, setPane] = useState<ViewMode>("map");
  const [menu, setMenu] = useState<"comms" | "chart" | "nav" | "plan" | "windows" | null>(null);
  const [infoPanelVisible, setInfoPanelVisible] = useState(false);
  const [infoPosition, setInfoPosition] = useState({ x: 12, y: 12 });
  const [weatherPanelVisible, setWeatherPanelVisible] = useState(false);
  const [navtexVisible, setNavtexVisible] = useState(false);
  const [compassVisible, setCompassVisible] = useState(false);
  const [clockVisible, setClockVisible] = useState(false);
  const [weatherLocationMode, setWeatherLocationMode] = useState<WeatherLocationMode>("port");
  const [weatherPosition, setWeatherPosition] = useState({ x: 12, y: 120 });
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [weatherRefreshKey, setWeatherRefreshKey] = useState(0);
  const infoPanelRef = useRef<HTMLElement | null>(null);
  const weatherPanelRef = useRef<HTMLElement | null>(null);
  const weatherControllerRef = useRef<AbortController | null>(null);
  const weatherDebounceRef = useRef<number | null>(null);
  const weatherLastRequestRef = useRef<{ lat: number; lng: number; mode: WeatherLocationMode } | null>(null);
  const weatherDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);
  const infoDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);
  const [rightOpen, setRightOpen] = useState(false);
  const [sideToolsOpen, setSideToolsOpen] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [serialOn, setSerialOn] = useState(false);
  const [serialSource, setSerialSource] = useState<"JRC" | "Bluetooth SPP" | null>(null);
  const [bluetoothOn, setBluetoothOn] = useState(false);
  const [sounderOn, setSounderOn] = useState(false);
  const [sounderM, setSounderM] = useState<number | null>(null);
  const [sounderRef, setSounderRef] = useState<"surface" | "transducer" | "keel">("transducer");
  const [sounderNote, setSounderNote] = useState<string | null>(null);
  const [baud, setBaud] = useState(4800);
  const [framed, setFramed] = useState(false);
  const [linkHref, setLinkHref] = useState("");
  const [sogKn, setSogKn] = useState<number | null>(null);
  const [cogDeg, setCogDeg] = useState<number | null>(null);
  const [headingDeg, setHeadingDeg] = useState<number | null>(null);
  const [trackOn, setTrackOn] = useState(true);
  const [courseOn, setCourseOn] = useState(true);
  const [courseMin, setCourseMin] = useState(6);
  const [vrmOn, setVrmOn] = useState(false);
  const [eblText, setEblText] = useState("0");
  const [vrmText, setVrmText] = useState("0.50");
  const [anchorOn, setAnchorOn] = useState(false);
  const [anchorPick, setAnchorPick] = useState(false);
  const [anchorRadius, setAnchorRadius] = useState(100);
  const [anchorDist, setAnchorDist] = useState<number | null>(null);
  const [anchorOut, setAnchorOut] = useState(false);
  const [anchorAck, setAnchorAck] = useState(false);
  const [alarms, setAlarms] = useState<Array<{ id: number; at: string; text: string }>>([]);
  const [alarmOpen, setAlarmOpen] = useState(false);
  const alarmSeq = useRef(1);
  const [courseUp, setCourseUp] = useState(false);
  const [manualBearing, setManualBearing] = useState(false);
  const [planOn, setPlanOn] = useState(false);
  const [planPts, setPlanPts] = useState<PlanPoint[]>([]);
  const [turns, setTurns] = useState<TideTurn[] | null>(null);
  const [minute, setMinute] = useState(0);
  const [etaMode, setEtaMode] = useState(false);
  const [voyageOn, setVoyageOn] = useState(false);
  const [wps, setWps] = useState<Array<{ lat: number; lng: number }>>([]);
  const [wpRows, setWpRows] = useState<WpRow[]>([
    { id: 1, lat: "", lng: "", ns: "N", ew: "E" },
    { id: 2, lat: "", lng: "", ns: "N", ew: "E" },
  ]);
  const [wpNote, setWpNote] = useState<string | null>(null);
  const wpSeq = useRef(3);
  const [dest, setDest] = useState<{ lat: number; lng: number } | null>(null);
  const [latDraft, setLatDraft] = useState("");
  const [lngDraft, setLngDraft] = useState("");
  const [latHemi, setLatHemi] = useState<"N" | "S">("N");
  const [lngHemi, setLngHemi] = useState<"E" | "W">("E");
  const [aisOn, setAisOn] = useState(false);
  const [aisNm, setAisNm] = useState(15);
  const [aisPosition, setAisPosition] = useState({ x: 12, y: 12 });
  const aisPanelRef = useRef<HTMLDivElement | null>(null);
  const aisDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);
  const [aisShips, setAisShips] = useState<AisTarget[]>([]);
  const [aisNote, setAisNote] = useState<string | null>(null);
  const [aisCredit, setAisCredit] = useState("Open Waters AIS");

  useEffect(() => {
    let savedTheme: "light" | "dark" = "dark";
    try {
      const saved = window.localStorage.getItem("thiq-ar-theme");
      if (saved === "dark" || saved === "light") savedTheme = saved;
    } catch {
      // Keep the night theme when browser storage is unavailable.
    }
    document.documentElement.dataset.theme = savedTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      savedTheme === "dark" ? "#07141c" : "#eaf2f5",
    );
    setTheme(savedTheme);
  }, []);

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      nextTheme === "dark" ? "#07141c" : "#eaf2f5",
    );
    try {
      window.localStorage.setItem("thiq-ar-theme", nextTheme);
    } catch {
      // The current page still changes theme when browser storage is unavailable.
    }
  }

  etaModeRef.current = etaMode;
  voyageOnRef.current = voyageOn;
  courseUpRef.current = courseUp;
  daymarksOnRef.current = daymarksOn;
  depthsOnRef.current = depthsOn;
  baseRef.current = base;
  seamarksRef.current = seamarks;

  function bowDeg(): number | null {
    return headingRef.current ?? cogRef.current;
  }

  function paintShip(course: number | null) {
    const el = pickRef.current?.getElement()?.querySelector(".ship-rot");
    const map = mapRef.current as (L.Map & { getBearing?: () => number }) | null;
    const bearing = map?.getBearing?.() ?? 0;
    if (el instanceof HTMLElement) el.style.transform = `rotate(${(course ?? 0) + bearing}deg)`;
    paintAis(bearing);
  }

  function paintAis(bearing?: number) {
    const map = mapRef.current as (L.Map & { getBearing?: () => number }) | null;
    const turn = bearing ?? map?.getBearing?.() ?? 0;
    map?.getContainer().querySelectorAll<HTMLElement>(".ais-rot").forEach((node) => {
      const course = Number(node.dataset.course || 0);
      node.style.transform = `rotate(${course + turn}deg)`;
    });
  }

  function aisPopup(ship: AisTarget, km: number | null): string {
    const rows: [string, string][] = [
      ["MMSI", ship.mmsi],
      ["IMO", ship.imo],
      ["Call sign", ship.callsign],
      ["Flag", ship.flag],
      ["Type", ship.type],
      ["Status", ship.status],
      ["SOG", ship.sog == null ? "" : `${ship.sog.toFixed(1)} kn`],
      ["COG", ship.cog == null ? "" : `${ship.cog.toFixed(0).padStart(3, "0")}°`],
      ["Heading", ship.heading == null ? "" : `${ship.heading.toFixed(0).padStart(3, "0")}°`],
      ["Destination", ship.destination],
      ["ETA", ship.eta],
      ["Draught", ship.draught == null ? "" : `${ship.draught.toFixed(1)} m`],
      ["Dimensions", ship.length || ship.width ? `${ship.length ?? "—"} × ${ship.width ?? "—"} m` : ""],
      ["Report", ship.seen],
      ["Range", km == null ? "" : formatNm(km)],
    ];
    const body = rows
      .filter(([, value]) => value)
      .map(([label, value]) => `<div><span style="color:#587381">${esc(label)}</span> ${esc(value)}</div>`)
      .join("");
    return `<div dir="ltr" style="font-family:IBM Plex Sans,sans-serif"><strong>${esc(ship.name)}</strong>${body}</div>`;
  }

  function applyBearing() {
    const map = mapRef.current as (L.Map & { setBearing?: (bearing: number) => void; getBearing?: () => number }) | null;
    const head = bowDeg();
    if (!map?.setBearing || !courseUpRef.current || head == null) {
      paintShip(head);
      return;
    }
    const target = (360 - head) % 360;
    const current = map.getBearing?.() ?? 0;
    let delta = target - current;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    if (Math.abs(delta) >= 0.8) map.setBearing(target);
    paintShip(head);
  }

  paintShipRef.current = paintShip;

  function drawTrack() {
    const map = mapRef.current;
    const Leaflet = leafletRef.current;
    const pts = trackPtsRef.current;
    if (!map || !Leaflet || !trackOnRef.current || pts.length < 2) return;
    if (!trackLineRef.current) {
      trackLineRef.current = Leaflet.polyline(pts, { color: "#bd641d", weight: 3, opacity: 0.92 }).addTo(map);
    } else {
      trackLineRef.current.setLatLngs(pts);
    }
  }

  function pushTrack(lat: number, lng: number) {
    const pts = trackPtsRef.current;
    const last = pts[pts.length - 1];
    if (last && haversineKm(last[0], last[1], lat, lng) < 0.004) return;
    pts.push([lat, lng]);
    if (pts.length > 8000) pts.splice(0, pts.length - 8000);
    drawTrack();
  }

  function drawVrm(lat: number, lng: number) {
    const map = mapRef.current;
    const Leaflet = leafletRef.current;
    if (!map || !Leaflet || !vrmOnRef.current) {
      vrmCircleRef.current?.remove();
      vrmCircleRef.current = null;
      eblLineRef.current?.remove();
      eblLineRef.current = null;
      return;
    }
    const nm = Math.min(40, Math.max(0.02, vrmNmRef.current));
    const radius = nm * 1852;
    if (!vrmCircleRef.current) {
      vrmCircleRef.current = Leaflet.circle([lat, lng], {
        radius,
        color: "#006d91",
        weight: 1.5,
        fill: false,
        interactive: false,
      }).addTo(map);
    } else {
      vrmCircleRef.current.setLatLng([lat, lng]);
      vrmCircleRef.current.setRadius(radius);
    }
    const tip = destinationPoint(lat, lng, eblDegRef.current, nm * 1.852 * 1.12);
    const pts: L.LatLngExpression[] = [
      [lat, lng],
      [tip.lat, tip.lng],
    ];
    if (!eblLineRef.current) {
      eblLineRef.current = Leaflet.polyline(pts, {
        color: "#006d91",
        weight: 1.5,
        dashArray: "7 5",
        interactive: false,
      }).addTo(map);
    } else {
      eblLineRef.current.setLatLngs(pts);
    }
  }

  function setVrmFromChart(lat: number, lng: number) {
    const here = hitRef.current;
    if (!here) return;
    const km = haversineKm(here.lat, here.lng, lat, lng);
    const bearing = initialBearing(here.lat, here.lng, lat, lng) % 360;
    applyVrm(bearing, km / 1.852);
  }

  function commitVrm(bearing: number, nm: number) {
    if (!Number.isFinite(bearing) || !Number.isFinite(nm)) return;
    eblDegRef.current = ((bearing % 360) + 360) % 360;
    vrmNmRef.current = Math.min(40, Math.max(0.02, nm));
    const here = hitRef.current;
    if (here) syncNav(here.lat, here.lng);
  }

  function applyVrm(bearing: number, nm: number) {
    commitVrm(bearing, nm);
    if (!Number.isFinite(bearing) || !Number.isFinite(nm)) return;
    setEblText(String(Math.round(eblDegRef.current)));
    setVrmText(vrmNmRef.current.toFixed(2));
  }

  function toggleVrm() {
    const next = !vrmOnRef.current;
    vrmOnRef.current = next;
    setVrmOn(next);
    const here = hitRef.current;
    if (here) syncNav(here.lat, here.lng);
    else if (!next) drawVrm(0, 0);
  }

  function pushAlarm(text: string) {
    const at = new Date().toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const id = alarmSeq.current;
    alarmSeq.current += 1;
    setAlarms((list) => [{ id, at, text }, ...list].slice(0, 50));
  }

  function stopBeep() {
    if (beepRef.current != null) {
      window.clearInterval(beepRef.current);
      beepRef.current = null;
    }
  }

  function unlockAudio() {
    const Ctx = window.AudioContext;
    if (!Ctx) return;
    if (!audioRef.current) audioRef.current = new Ctx();
    void audioRef.current.resume();
  }

  function pulseBeep() {
    const ctx = audioRef.current;
    if (!ctx || ctx.state !== "running") return;
    const startAt = ctx.currentTime + 0.02;
    for (let i = 0; i < 6; i += 1) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = i % 2 === 0 ? 720 : 960;
      const start = startAt + i * 0.18;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.45, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.15);
    }
  }

  function startBeep() {
    unlockAudio();
    const ctx = audioRef.current;
    void ctx?.resume().then(() => {
      pulseBeep();
    });
    if (beepRef.current != null) return;
    beepRef.current = window.setInterval(() => {
      if (!anchorOutRef.current || anchorAckRef.current) {
        stopBeep();
        return;
      }
      const live = audioRef.current;
      if (!live) return;
      void live.resume().then(() => pulseBeep());
    }, 1400);
  }

  function clearAnchorLayers() {
    anchorCircleRef.current?.remove();
    anchorCircleRef.current = null;
    anchorMarkRef.current?.remove();
    anchorMarkRef.current = null;
    anchorLineRef.current?.remove();
    anchorLineRef.current = null;
  }

  function drawAnchor(lat: number, lng: number) {
    const map = mapRef.current;
    const Leaflet = leafletRef.current;
    const watch = anchorRef.current;
    if (!map || !Leaflet || !anchorOnRef.current || !watch) {
      clearAnchorLayers();
      return;
    }
    const radius = anchorRadiusRef.current;
    const meters = haversineKm(lat, lng, watch.lat, watch.lng) * 1000;
    const outside = meters > radius;
    const color = outside ? "#c74236" : "#a9650c";
    if (!anchorCircleRef.current) {
      anchorCircleRef.current = Leaflet.circle([watch.lat, watch.lng], {
        radius,
        color: "#c74236",
        weight: 2,
        fillColor: "#c74236",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
    } else {
      anchorCircleRef.current.setLatLng([watch.lat, watch.lng]);
      anchorCircleRef.current.setRadius(radius);
      anchorCircleRef.current.setStyle({ color: "#c74236", fillColor: "#c74236" });
    }
    if (!anchorMarkRef.current) {
      const icon = Leaflet.divIcon({
        className: "ship-pin",
        html: '<span style="display:block;width:14px;height:14px;margin:5px;border-radius:2px;background:#f0b64f;border:2px solid #173746"></span>',
        iconSize: [24, 24],
        iconAnchor: [12, 12],
      });
      anchorMarkRef.current = Leaflet.marker([watch.lat, watch.lng], { icon, interactive: false, zIndexOffset: 800 }).addTo(map);
    } else {
      anchorMarkRef.current.setLatLng([watch.lat, watch.lng]);
    }
    const pts: L.LatLngExpression[] = [
      [watch.lat, watch.lng],
      [lat, lng],
    ];
    if (!anchorLineRef.current) {
      anchorLineRef.current = Leaflet.polyline(pts, { color, weight: 1.5, dashArray: "4 4", interactive: false }).addTo(map);
    } else {
      anchorLineRef.current.setLatLngs(pts);
      anchorLineRef.current.setStyle({ color });
    }
    const shown = Math.round(meters);
    if (shown !== anchorShownRef.current) {
      anchorShownRef.current = shown;
      setAnchorDist(shown);
    }
    if (outside !== anchorOutRef.current) {
      anchorOutRef.current = outside;
      setAnchorOut(outside);
      if (outside) {
        pushAlarm(`Anchor watch: ship left the circle, ${Math.round(meters)} m from the anchor. Limit ${anchorRadiusRef.current} m.`);
        const ship = window.localStorage.getItem("own-ship-name")?.trim() || "السفينة";
        void notifyAnchorBreach({ data: { meters, limit: anchorRadiusRef.current, ship } });
      } else {
        anchorAckRef.current = false;
        setAnchorAck(false);
        stopBeep();
        pushAlarm("Anchor watch: ship back inside the circle.");
      }
    }
    if (outside && !anchorAckRef.current && beepRef.current == null) startBeep();
  }

  function armAnchor(lat: number, lng: number) {
    anchorRef.current = { lat, lng };
    anchorOnRef.current = true;
    anchorOutRef.current = false;
    anchorAckRef.current = false;
    anchorShownRef.current = null;
    setAnchorOn(true);
    setAnchorOut(false);
    setAnchorAck(false);
    setAnchorPick(false);
    anchorPickRef.current = false;
    unlockAudio();
    const here = hitRef.current;
    if (here) syncNav(here.lat, here.lng);
    else drawAnchor(lat, lng);
  }

  function dropAnchor() {
    const here = hitRef.current;
    if (!here) {
      setGpsNote("Need an own-ship position before dropping the anchor.");
      return;
    }
    armAnchor(here.lat, here.lng);
  }

  function setAnchorRadiusM(meters: number) {
    if (!Number.isFinite(meters)) return;
    const next = Math.min(2000, Math.max(20, meters));
    anchorRadiusRef.current = next;
    setAnchorRadius(next);
    const here = hitRef.current;
    if (here) drawAnchor(here.lat, here.lng);
  }

  function clearAnchor() {
    anchorOnRef.current = false;
    anchorRef.current = null;
    anchorPickRef.current = false;
    anchorOutRef.current = false;
    anchorAckRef.current = false;
    setAnchorOn(false);
    setAnchorPick(false);
    setAnchorOut(false);
    setAnchorAck(false);
    setAnchorDist(null);
    stopBeep();
    clearAnchorLayers();
  }

  function ackAnchor() {
    anchorAckRef.current = true;
    setAnchorAck(true);
    stopBeep();
    pushAlarm("Anchor watch acknowledged.");
  }

  function syncNav(lat: number, lng: number) {
    const map = mapRef.current;
    const Leaflet = leafletRef.current;
    applyBearing();
    paintShip(bowDeg());
    drawVrm(lat, lng);
    drawAnchor(lat, lng);
    if (!map || !Leaflet) return;
    const course = cogRef.current ?? headingRef.current;
    if (!courseOnRef.current || course == null) {
      courseLineRef.current?.remove();
      courseLineRef.current = null;
      return;
    }
    const sog = sogRef.current;
    const minutes = courseMinRef.current;
    const nm = sog != null && sog >= 0.2 ? Math.max(sog * (minutes / 60), 0.05) : 0.15;
    const tip = destinationPoint(lat, lng, course, nm * 1.852);
    const pts: L.LatLngExpression[] = [
      [lat, lng],
      [tip.lat, tip.lng],
    ];
    if (!courseLineRef.current) {
      courseLineRef.current = Leaflet.polyline(pts, { color: "#a43d77", weight: 2, opacity: 0.95 }).addTo(map);
    } else {
      courseLineRef.current.setLatLngs(pts);
    }
  }

  syncNavRef.current = syncNav;

  function toggleTrack() {
    const next = !trackOnRef.current;
    trackOnRef.current = next;
    setTrackOn(next);
    if (!next) {
      trackLineRef.current?.remove();
      trackLineRef.current = null;
      return;
    }
    drawTrack();
  }

  function toggleCourse() {
    const next = !courseOnRef.current;
    courseOnRef.current = next;
    setCourseOn(next);
    const here = hitRef.current;
    if (here) syncNav(here.lat, here.lng);
  }

  function setCourseMinutes(minutes: number) {
    courseMinRef.current = minutes;
    setCourseMin(minutes);
    const here = hitRef.current;
    if (here) syncNav(here.lat, here.lng);
  }

  function setCourseUpMode(next: boolean) {
    const map = mapRef.current as (L.Map & { setBearing?: (bearing: number) => void }) | null;
    setManualBearing(false);
    if (!next) map?.setBearing?.(0);
    if (courseUpRef.current === next) {
      paintShip(bowDeg());
      return;
    }
    courseUpRef.current = next;
    setCourseUp(next);
    applyBearing();
    const here = hitRef.current;
    if (here) syncNav(here.lat, here.lng);
    if (next && bowDeg() == null) {
      setGpsNote("Course up is waiting for the JRC heading. Connect the set so the chart turns with the ship's head.");
    }
  }

  function drawPlan() {
    const map = mapRef.current;
    const Leaflet = leafletRef.current;
    if (!map || !Leaflet) return;
    planLineRef.current?.remove();
    planMarksRef.current?.remove();
    planLinkRef.current?.remove();
    planLineRef.current = null;
    planMarksRef.current = null;
    planLinkRef.current = null;
    const pts = planPtsRef.current;
    if (pts.length === 0) return;
    if (pts.length >= 2) {
      planLineRef.current = Leaflet.polyline(
        pts.map((point) => [point.lat, point.lng] as [number, number]),
        { color: "#087f83", weight: 3, dashArray: "10 8" },
      ).addTo(map);
    }
    const marks = Leaflet.layerGroup();
    pts.forEach((point) => {
      Leaflet.circleMarker([point.lat, point.lng], {
        radius: 5,
        color: "#087f83",
        weight: 2,
        fillColor: "#f9fcfd",
        fillOpacity: 1,
      }).addTo(marks);
    });
    const ship = hitRef.current;
    if (ship && pts.length >= 2) {
      const offset = crossTrack(ship, pts);
      if (offset) {
        planLinkRef.current = Leaflet.polyline(
          [
            [ship.lat, ship.lng],
            [offset.lat, offset.lng],
          ],
          { color: "#a43d77", weight: 2, dashArray: "2 6" },
        ).addTo(map);
      }
    }
    marks.addTo(map);
    planMarksRef.current = marks;
  }

  drawPlanRef.current = drawPlan;
  planPtsRef.current = planPts;
  planOnRef.current = planOn;

  function addPlanPoint(lat: number, lng: number) {
    setPlanPts((points) => [...points, { lat, lng }]);
  }

  addPlanRef.current = addPlanPoint;

  stopTrackingRef.current = () => {
    if (watchRef.current != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    setTracking(false);
  };

  armAnchorRef.current = armAnchor;
  setVrmFromChartRef.current = setVrmFromChart;

  useEffect(() => {
    exagRef.current = exag;
    if (bedRef.current) {
      bedRef.current.scale.y = exag;
      bedRef.current.position.y = depthOffsetRef.current * exag;
    }
    const current = hitRef.current;
    if (current) syncPinRef.current(current.lat, current.lng);
  }, [exag]);

  useEffect(() => {
    shipSizeRef.current = shipSize;
    pinRef.current?.scale.setScalar(12 * shipSize);
  }, [shipSize]);

  useEffect(() => {
    depthOffsetRef.current = depthOffset;
    if (bedRef.current) bedRef.current.position.y = depthOffset * exagRef.current;
  }, [depthOffset]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    let cancelled = false;
    void import("leaflet").then(({ default: Leaflet }) => {
      if (cancelled || mapRef.current !== map) return;
      if (baseLayerRef.current) map.removeLayer(baseLayerRef.current);
      const tiles = Leaflet.tileLayer(base === "satellite" ? SATELLITE : CHART, {
        maxZoom: base === "satellite" ? 19 : 18,
        attribution: base === "satellite" ? "Tiles © Esri" : "© OpenSeaMap",
      });
      tiles.addTo(map);
      tiles.bringToBack();
      baseLayerRef.current = tiles;
      const opacity = base === "chart" ? 0.92 : 0.96;
      depthLayerRef.current?.setOpacity(opacity);
      for (const layer of depthLayersRef.current) layer.setOpacity(opacity);
    });
    return () => {
      cancelled = true;
    };
  }, [base]);

  useEffect(() => {
    const layer = seamarkRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    if (seamarks) layer.addTo(map);
    else map.removeLayer(layer);
  }, [seamarks]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const layer of depthLayersRef.current) {
      if (depthsOn) layer.addTo(map);
      else if (map.hasLayer(layer)) map.removeLayer(layer);
    }
    const chrome = depthChromeRef.current;
    if (chrome) {
      if (depthsOn) chrome.addTo(map);
      else if (map.hasLayer(chrome)) map.removeLayer(chrome);
    }
  }, [depthsOn]);

  useEffect(() => {
    const layer = daymarkLayerRef.current;
    const map = mapRef.current;
    if (layer && map) {
      if (daymarksOn) layer.addTo(map);
      else map.removeLayer(layer);
    }
    const group = daymarkGroupRef.current;
    if (group) group.visible = daymarksOn && depthMapRef.current === "river";
  }, [daymarksOn]);

  useEffect(() => {
    const mapNode = mapEl.current;
    const viewNode = viewEl.current;
    if (!mapNode || !viewNode) return;
    const view = viewNode;
    const mapHost = mapNode;

    let disposed = false;
    let frame = 0;
    let release = () => {};

    void (async () => {
      const [leaflet, THREE, orbit] = await Promise.all([
        import("leaflet"),
        import("three"),
        import("three/examples/jsm/controls/OrbitControls.js"),
      ]);
      const { OrbitControls } = orbit;
      await import("leaflet/dist/leaflet.css");
      if (disposed) return;
      const L = leaflet.default;
      (globalThis as { L?: typeof L }).L = L;
      await import("leaflet-rotate");
      if (disposed) return;
      leafletRef.current = L;

    const map = L.map(mapHost, {
      zoomControl: true,
      attributionControl: true,
      rotate: true,
      bearing: 0,
      rotateControl: false,
      touchRotate: false,
      shiftKeyRotate: false,
      compassBearing: false,
    } as L.MapOptions);
    mapRef.current = map;
    aisLayerRef.current = L.layerGroup().addTo(map);

    const host = map.getContainer();
    const rotatable = map as L.Map & { setBearing?: (bearing: number) => void; getBearing?: () => number };
    let spinning = false;
    let spun = false;
    let startAngle = 0;
    let startBearing = 0;
    function pointerAngle(event: PointerEvent) {
      const rect = host.getBoundingClientRect();
      const x = event.clientX - (rect.left + rect.width / 2);
      const y = event.clientY - (rect.top + rect.height / 2);
      return (Math.atan2(x, -y) * 180) / Math.PI;
    }
    function onMapPointerDown(event: PointerEvent) {
      if (event.button !== 2) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".leaflet-control")) return;
      spinning = true;
      spun = false;
      startAngle = pointerAngle(event);
      startBearing = rotatable.getBearing?.() ?? 0;
      host.style.cursor = "grabbing";
      host.setPointerCapture(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    }
    function onMapPointerMove(event: PointerEvent) {
      if (!spinning || !rotatable.setBearing) return;
      const delta = pointerAngle(event) - startAngle;
      if (!spun && Math.abs(delta) > 1) {
        spun = true;
        setManualBearing(true);
        if (courseUpRef.current) {
          courseUpRef.current = false;
          setCourseUp(false);
        }
      }
      rotatable.setBearing(startBearing + delta);
      paintShipRef.current(headingRef.current ?? cogRef.current);
    }
    function onMapPointerUp(event: PointerEvent) {
      if (!spinning) return;
      spinning = false;
      if (spun) spinGuardRef.current = true;
      host.style.removeProperty("cursor");
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    }
    function blockMenu(event: Event) {
      event.preventDefault();
    }
    host.addEventListener("pointerdown", onMapPointerDown, true);
    host.addEventListener("pointermove", onMapPointerMove);
    host.addEventListener("pointerup", onMapPointerUp);
    host.addEventListener("pointercancel", onMapPointerUp);
    host.addEventListener("contextmenu", blockMenu);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x07141c);
    renderer.domElement.style.position = "absolute";
    renderer.domElement.style.inset = "0";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "crosshair";
    view.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 20000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.48;

    const ambient = new THREE.AmbientLight(0xffffff, 0.72);
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    sun.position.set(400, 700, 280);
    scene.add(ambient, sun);

    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0x3194aa,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    scene.add(water);

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let pickPlane: import("three").Mesh | null = null;

    function syncPin(lat: number, lng: number) {
      const data = surveyRef.current;
      const pin = pinRef.current;
      if (!data || !pin) return;
      const padLat = (data.north - data.south) * 0.08;
      const padLng = (data.east - data.west) * 0.08;
      if (lat < data.south - padLat || lat > data.north + padLat || lng < data.west - padLng || lng > data.east + padLng) {
        pin.visible = false;
        return;
      }
      const { x, y } = project(data, lat, lng);
      pin.position.set(x, 0, -y);
      pin.scale.setScalar(12 * shipSizeRef.current);
      const heading = headingRef.current ?? cogRef.current;
      if (heading != null) pin.rotation.y = (-heading * Math.PI) / 180;
      pin.visible = true;
    }
    syncPinRef.current = syncPin;
    frameShipRef.current = (lat, lng) => {
      const data = surveyRef.current;
      if (!data) return;
      const padLat = (data.north - data.south) * 0.08;
      const padLng = (data.east - data.west) * 0.08;
      if (lat < data.south - padLat || lat > data.north + padLat || lng < data.west - padLng || lng > data.east + padLng) return;
      const { x, y } = project(data, lat, lng);
      const dx = camera.position.x - controls.target.x;
      const dy = camera.position.y - controls.target.y;
      const dz = camera.position.z - controls.target.z;
      controls.target.set(x, 0, -y);
      camera.position.set(x + dx, dy, -y + dz);
      controls.update();
    };

    function place(lat: number, lng: number, pan: boolean, fromDrag = false) {
      const data = surveyRef.current;
      if (!data) return;
      const next = { lat, lng, depth: depthFromSurveys(surveysRef.current, lat, lng) };
      hitRef.current = next;
      setHit(next);
      setLatDraft(formatDms(lat, 2));
      setLngDraft(formatDms(lng, 3));
      setLatHemi(lat < 0 ? "S" : "N");
      setLngHemi(lng < 0 ? "W" : "E");
      const marker = pickRef.current;
      if (marker && !fromDrag) marker.setLatLng([lat, lng]);
      if (pan) map.panTo([lat, lng]);
      syncPin(lat, lng);
      syncNavRef.current(lat, lng);
    }

    function resize() {
      const w = view.clientWidth;
      const h = view.clientHeight;
      if (w < 2 || h < 2) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      map.invalidateSize();
    }
    const observer = new ResizeObserver(resize);

    function loop() {
      if (disposed) return;
      const pin = pinRef.current;
      const heading = headingRef.current ?? cogRef.current;
      if (pin && heading != null) pin.rotation.y = (-heading * Math.PI) / 180;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    }

    let downX = 0;
    let downY = 0;
    const onPointerDown = (event: PointerEvent) => {
      downX = event.clientX;
      downY = event.clientY;
    };
    const onPointerUp = (event: PointerEvent) => {
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 7) return;
      const data = surveyRef.current;
      const bed = bedRef.current;
      if (!data || !bed) return;
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      ndc.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      let hits = raycaster.intersectObject(bed, false);
      if (hits.length === 0 && pickPlane) hits = raycaster.intersectObject(pickPlane, false);
      const picked = hits[0];
      if (!picked) return;
      const geo = unproject(data, picked.point.x, -picked.point.z);
      if (voyageOnRef.current) {
        setWps((points) => [...points, { lat: geo.lat, lng: geo.lng }]);
        return;
      }
      if (etaModeRef.current) {
        setDest({ lat: geo.lat, lng: geo.lng });
        return;
      }
      stopTrackingRef.current();
      place(geo.lat, geo.lng, true);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    Promise.all([
      fetch("/survey.json").then((r) => {
        if (!r.ok) throw new Error("Could not load the survey");
        return r.json() as Promise<Survey>;
      }),
      fetch("/survey-river.json")
        .then((r) => (r.ok ? (r.json() as Promise<Survey>) : null))
        .catch(() => null),
    ])
      .then(([data, river]) => {
        if (disposed) return;
        const riverBedSurvey = river ? completeChannel(river) : null;
        const loaded = [data, riverBedSurvey].filter((item): item is Survey => item != null);
        surveysRef.current = loaded;
        surveyRef.current = data;
        setSurvey(data);

        const tiles = L.tileLayer(baseRef.current === "satellite" ? SATELLITE : CHART, {
          maxZoom: baseRef.current === "satellite" ? 19 : 18,
          attribution: baseRef.current === "satellite" ? "Tiles © Esri" : "© OpenSeaMap",
        });
        if (baseLayerRef.current) map.removeLayer(baseLayerRef.current);
        tiles.addTo(map);
        tiles.bringToBack();
        baseLayerRef.current = tiles;

        const depthLayers: L.ImageOverlay[] = [];
        const depthChrome = L.layerGroup();
        const union = L.latLngBounds([data.south, data.west], [data.north, data.east]);
        const paintArea = (area: Survey, color: string, label: string) => {
          const bounds = L.latLngBounds(
            [area.south - area.dy / area.mPerLat / 2, area.west - area.dx / area.mPerLon / 2],
            [area.north + area.dy / area.mPerLat / 2, area.east + area.dx / area.mPerLon / 2],
          );
          union.extend(bounds);
          L.rectangle(bounds, { color, weight: 1, fill: false, dashArray: "4 4" }).addTo(depthChrome);
          const canvas = paintOverlay(area);
          const depth = L.imageOverlay(canvas.toDataURL(), bounds, { opacity: 0.92, interactive: false });
          depthLayers.push(depth);
          const icon = L.divIcon({
            className: "survey-tag",
            html: `<span class="survey-tag__label" style="border-color:${color}">${esc(label)}</span>`,
            iconSize: [148, 22],
            iconAnchor: [74, 22],
          });
          L.marker([area.north, (area.west + area.east) / 2], {
            icon,
            interactive: false,
            keyboard: false,
            zIndexOffset: 500,
          }).addTo(depthChrome);
        };
        paintArea(data, "#087f83", "مقطع الغاز السائل");
        if (riverBedSurvey) paintArea(riverBedSurvey, "#d08a2f", "مدخل النهر");
        depthLayersRef.current = depthLayers;
        depthLayerRef.current = depthLayers[0] ?? null;
        depthChromeRef.current = depthChrome;
        if (depthsOnRef.current) {
          for (const layer of depthLayers) layer.addTo(map);
          depthChrome.addTo(map);
        }
        map.fitBounds(union, { padding: [24, 24] });

        if (!map.getPane("seamarks")) {
          const pane = map.createPane("seamarks", map.getPane("rotatePane") ?? undefined);
          pane.style.zIndex = "450";
          pane.style.pointerEvents = "none";
        }
        const seamark = L.tileLayer(SEAMARK, { pane: "seamarks", maxZoom: 18, opacity: 1 });
        seamarkRef.current = seamark;
        if (seamarksRef.current) seamark.addTo(map);

        const areas: { key: "gas" | "river"; survey: Survey; bed: THREE.Mesh }[] = [];
        const gasBed = buildBed(THREE, data, scene);
        areas.push({ key: "gas", survey: data, bed: gasBed });
        const dayLayer = L.layerGroup(
          CHANNEL_MARKS.map((mark) => {
            const icon = L.divIcon({
              className: "daymark-pin",
              html: daymarkHtml(mark.kind, mark.label),
              iconSize: [72, 28],
              iconAnchor: [10, 26],
            });
            const marker = L.marker([mark.lat, mark.lng], { icon, keyboard: false, zIndexOffset: 640 });
            marker.bindTooltip(daymarkTitle(mark), { direction: "top", opacity: 0.95 });
            return marker;
          }),
        );
        daymarkLayerRef.current = dayLayer;
        if (daymarksOnRef.current) dayLayer.addTo(map);
        if (riverBedSurvey) {
          const riverBed = buildBed(THREE, riverBedSurvey, scene);
          riverBed.visible = false;
          const dayGroup = new THREE.Group();
          const span = Math.max((riverBedSurvey.nx - 1) * riverBedSurvey.dx, (riverBedSurvey.ny - 1) * riverBedSurvey.dy);
          const markScale = Math.max(span / 900, 1);
          const padLat = (riverBedSurvey.north - riverBedSurvey.south) * 0.2;
          const padLng = (riverBedSurvey.east - riverBedSurvey.west) * 0.2;
          for (const mark of CHANNEL_MARKS) {
            if (
              mark.lat < riverBedSurvey.south - padLat ||
              mark.lat > riverBedSurvey.north + padLat ||
              mark.lng < riverBedSurvey.west - padLng ||
              mark.lng > riverBedSurvey.east + padLng
            ) {
              continue;
            }
            const mesh = buildDaymark(THREE, mark.kind);
            const { x, y } = project(riverBedSurvey, mark.lat, mark.lng);
            mesh.position.set(x, 0, -y);
            mesh.scale.setScalar(markScale);
            dayGroup.add(mesh);
          }
          dayGroup.visible = false;
          scene.add(dayGroup);
          daymarkGroupRef.current = dayGroup;
          areas.push({ key: "river", survey: riverBedSurvey, bed: riverBed });
        }

        pickPlane = new THREE.Mesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
        );
        pickPlane.rotation.x = -Math.PI / 2;
        scene.add(pickPlane);

        const showModel = (key: "gas" | "river") => {
          const area = areas.find((item) => item.key === key) ?? areas[0];
          surveyRef.current = area.survey;
          bedRef.current = area.bed;
          setSurvey(area.survey);
          for (const item of areas) item.bed.visible = item === area;
          if (daymarkGroupRef.current) {
            daymarkGroupRef.current.visible = area.key === "river" && daymarksOnRef.current;
          }
          area.bed.scale.y = exagRef.current;
          area.bed.position.y = depthOffsetRef.current * exagRef.current;
          const width = (area.survey.nx - 1) * area.survey.dx;
          const height = (area.survey.ny - 1) * area.survey.dy;
          const center = project(
            area.survey,
            (area.survey.south + area.survey.north) / 2,
            (area.survey.west + area.survey.east) / 2,
          );
          const span = Math.max(width, height);
          water.position.set(center.x, 0, -center.y);
          water.scale.set(width * 1.08, height * 1.08, 1);
          if (pickPlane) {
            pickPlane.position.set(center.x, 0, -center.y);
            pickPlane.scale.set(width * 1.15, height * 1.15, 1);
          }
          controls.target.set(center.x, -18, -center.y);
          camera.position.set(center.x + span * 0.05, span * 0.42, -center.y + span * 0.42);
          controls.update();
          const ship = hitRef.current;
          if (ship) syncPin(ship.lat, ship.lng);
        };
        showDepthMapRef.current = showModel;
        showModel(depthMapRef.current === "river" && riverBedSurvey ? "river" : "gas");

        const pin = buildDredger(THREE);
        pin.visible = false;
        scene.add(pin);
        pinRef.current = pin;

        const midLat = (data.south + data.north) / 2;
        const midLng = (data.west + data.east) / 2;
        const icon = L.divIcon({
          className: "ship-pin",
          html: SHIP_ICON,
          iconSize: [48, 48],
          iconAnchor: [24, 24],
        });
        const marker = L.marker([midLat, midLng], { icon, draggable: true, autoPan: true, zIndexOffset: 900 });
        marker.addTo(map);
        pickRef.current = marker;
        marker.on("dragstart", () => stopTrackingRef.current());
        marker.on("drag", () => {
          const ll = marker.getLatLng();
          place(ll.lat, ll.lng, false, true);
        });

        map.on("click", (event) => {
          if (spinGuardRef.current) {
            spinGuardRef.current = false;
            return;
          }
          if (voyageOnRef.current) {
            setWps((points) => [...points, { lat: event.latlng.lat, lng: event.latlng.lng }]);
            return;
          }
          if (planOnRef.current) {
            addPlanRef.current(event.latlng.lat, event.latlng.lng);
            return;
          }
          if (etaModeRef.current) {
            setDest({ lat: event.latlng.lat, lng: event.latlng.lng });
            return;
          }
          if (anchorPickRef.current) {
            armAnchorRef.current(event.latlng.lat, event.latlng.lng);
            return;
          }
          if (vrmOnRef.current) {
            setVrmFromChartRef.current(event.latlng.lat, event.latlng.lng);
            return;
          }
          stopTrackingRef.current();
          place(event.latlng.lat, event.latlng.lng, false);
        });

        place(midLat, midLng, false);
        function focus(lat: number, lng: number) {
          place(lat, lng, false);
          let tries = 0;
          const settle = () => {
            const host = map.getContainer();
            if ((host.clientWidth < 2 || host.clientHeight < 2) && tries < 30) {
              tries += 1;
              requestAnimationFrame(settle);
              return;
            }
            map.invalidateSize();
            marker.setLatLng([lat, lng]);
            const zoom = Math.min(18, Math.max(map.getZoom() || 0, 17));
            map.setView([lat, lng], zoom, { animate: false });
            const areas = surveysRef.current;
            const index = areas.findIndex(
              (area) => lat >= area.south && lat <= area.north && lng >= area.west && lng <= area.east,
            );
            if (index === 0) pickDepthMap("gas");
            else if (index === 1) pickDepthMap("river");
            frameShipRef.current(lat, lng);
          };
          requestAnimationFrame(settle);
        }
        apiRef.current.focus = focus;
        drawPlanRef.current();
        resize();
        observer.observe(view);
        observer.observe(mapHost);
        loop();
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : "Load error");
      });

    function locate(lat: number, lng: number, sogKn?: number | null, headingDeg?: number | null) {
      const data = surveyRef.current;
      const map = mapRef.current;
      const covered = coverage(surveysRef.current, lat, lng);
      if (surveysRef.current.length && covered.km > 80) {
        setGpsNote(`Ignored a fix ${formatNm(covered.km, 0)} from the survey. It is not a position in this area.`);
        return;
      }
      if (sogKn != null && Number.isFinite(sogKn)) {
        sogRef.current = sogKn;
        setSogKn(sogKn);
      }
      if (headingDeg != null && Number.isFinite(headingDeg)) {
        const norm = ((headingDeg % 360) + 360) % 360;
        headingRef.current = norm;
        setHeadingDeg(norm);
        cogRef.current = norm;
        setCogDeg(norm);
      }
      if (!data || !map) return;
      const speed = sogRef.current == null ? "" : ` · ${sogRef.current.toFixed(1)} kn`;
      const onSurvey = covered.inside;
      place(lat, lng, false);
      if (!shipFramedRef.current) {
        shipFramedRef.current = true;
        if (onSurvey) map.panTo([lat, lng]);
        else {
          const bounds = L.latLngBounds([data.south, data.west], [data.north, data.east]);
          for (const area of surveysRef.current) bounds.extend([area.south, area.west]).extend([area.north, area.east]);
          bounds.extend([lat, lng]);
          map.fitBounds(bounds, { padding: [32, 32], animate: false });
        }
      }
      setGpsNote(
        onSurvey
          ? `Own ship on the survey${speed}`
          : `Own ship is ${formatNm(covered.km)} from the survey centre${speed}`,
      );
    }

    apiRef.current.locate = locate;
    apiRef.current.place = place;

    release = () => {
      host.removeEventListener("pointerdown", onMapPointerDown, true);
      host.removeEventListener("pointermove", onMapPointerMove);
      host.removeEventListener("pointerup", onMapPointerUp);
      host.removeEventListener("pointercancel", onMapPointerUp);
      host.removeEventListener("contextmenu", blockMenu);
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
      depthLayerRef.current = null;
      depthLayersRef.current = [];
      depthChromeRef.current = null;
      seamarkRef.current = null;
      daymarkLayerRef.current = null;
      daymarkGroupRef.current = null;
      pickRef.current = null;
      pinRef.current = null;
      bedRef.current = null;
      destMarkerRef.current = null;
      routeRef.current = null;
      voyageLayerRef.current = null;
      trackLineRef.current = null;
      courseLineRef.current = null;
      vrmCircleRef.current = null;
      eblLineRef.current = null;
      anchorCircleRef.current = null;
      anchorMarkRef.current = null;
      anchorLineRef.current = null;
      aisLayerRef.current = null;
      aisMarkersRef.current.clear();
      leafletRef.current = null;
      syncPinRef.current = () => {};
    };
    })();

    return () => {
      disposed = true;
      release();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (watchRef.current != null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchRef.current);
      }
      serialStopRef.current = true;
      sounderStopRef.current = true;
      const reader = serialReaderRef.current;
      const port = serialPortRef.current;
      const bluetoothDevice = bluetoothDeviceRef.current;
      const bluetoothCharacteristic = bluetoothCharacteristicRef.current;
      const bluetoothValueHandler = bluetoothValueHandlerRef.current;
      const bluetoothDisconnectHandler = bluetoothDisconnectHandlerRef.current;
      const sounderReader = sounderReaderRef.current;
      const sounderPort = sounderPortRef.current;
      serialReaderRef.current = null;
      serialPortRef.current = null;
      bluetoothDeviceRef.current = null;
      bluetoothCharacteristicRef.current = null;
      bluetoothValueHandlerRef.current = null;
      bluetoothDisconnectHandlerRef.current = null;
      sounderReaderRef.current = null;
      sounderPortRef.current = null;
      void reader?.cancel().catch(() => {});
      void port?.close().catch(() => {});
      if (bluetoothCharacteristic && bluetoothValueHandler) {
        bluetoothCharacteristic.removeEventListener("characteristicvaluechanged", bluetoothValueHandler);
        void bluetoothCharacteristic.stopNotifications().catch(() => {});
      }
      if (bluetoothDevice && bluetoothDisconnectHandler) {
        bluetoothDevice.removeEventListener("gattserverdisconnected", bluetoothDisconnectHandler);
      }
      bluetoothDevice?.gatt?.disconnect();
      void sounderReader?.cancel().catch(() => {});
      void sounderPort?.close().catch(() => {});
      stopBeep();
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setMinute((value) => value + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setWeatherRefreshKey((value) => value + 1), 15 * 60_000);
    return () => window.clearInterval(id);
  }, []);

  const weatherRefreshHandledRef = useRef(0);
  useEffect(() => {
    const position = weatherLocationMode === "port" ? UMM_QASR_PORT : hit;
    if (!position) {
      weatherControllerRef.current?.abort();
      if (weatherDebounceRef.current !== null) window.clearTimeout(weatherDebounceRef.current);
      weatherLastRequestRef.current = null;
      setWeather(null);
      setWeatherError(null);
      setWeatherLoading(false);
      return;
    }

    const previous = weatherLastRequestRef.current;
    const forced = weatherRefreshKey !== weatherRefreshHandledRef.current || previous?.mode !== weatherLocationMode;
    const moved = previous ? haversineKm(previous.lat, previous.lng, position.lat, position.lng) : Infinity;
    if (!forced && moved < 2) return;
    weatherRefreshHandledRef.current = weatherRefreshKey;

    if (weatherDebounceRef.current !== null) window.clearTimeout(weatherDebounceRef.current);
    const target = { lat: position.lat, lng: position.lng };
    if (previous && (previous.mode !== weatherLocationMode || moved >= 2)) setWeather(null);
    weatherLastRequestRef.current = { ...target, mode: weatherLocationMode };
    weatherDebounceRef.current = window.setTimeout(() => {
      weatherControllerRef.current?.abort();
      const controller = new AbortController();
      weatherControllerRef.current = controller;
      setWeatherLoading(true);
      setWeatherError(null);
      void getCurrentWeather(target.lat, target.lng, controller.signal)
        .then((snapshot) => {
          if (!controller.signal.aborted) setWeather(snapshot);
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted) {
            setWeatherError(cause instanceof Error ? cause.message : "Unable to load current weather.");
          }
        })
        .finally(() => {
          if (weatherControllerRef.current === controller) setWeatherLoading(false);
        });
    }, 350);

  }, [hit?.lat, hit?.lng, weatherLocationMode, weatherRefreshKey]);

  useEffect(() => () => {
    weatherControllerRef.current?.abort();
    if (weatherDebounceRef.current !== null) window.clearTimeout(weatherDebounceRef.current);
  }, []);

  useEffect(() => {
    if (!aisOn) return;
    let cancelled = false;
    async function pull() {
      const here = hitRef.current;
      if (!here) {
        if (!cancelled) setAisNote("Wait for own-ship position, then try again.");
        return;
      }
      const result = await getNearbyAis({ data: { lat: here.lat, lng: here.lng, km: Math.min(80, aisNm * 1.852) } });
      if (cancelled) return;
      if (!result.ok) {
        setAisShips([]);
        setAisNote(result.error);
        return;
      }
      setAisShips(result.ships);
      setAisCredit(result.credit);
      setAisNote(result.ships.length ? null : "No AIS targets inside this range.");
    }
    void pull();
    const id = window.setInterval(() => void pull(), 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [aisOn, aisNm]);

  useEffect(() => {
    const prime = () => {
      const Ctx = window.AudioContext;
      if (!Ctx) return;
      if (!audioRef.current) audioRef.current = new Ctx();
      void audioRef.current.resume();
    };
    window.addEventListener("pointerdown", prime);
    return () => window.removeEventListener("pointerdown", prime);
  }, []);

  useEffect(() => {
    const Leaflet = leafletRef.current;
    const layer = aisLayerRef.current;
    if (!Leaflet || !layer) return;
    layer.clearLayers();
    aisMarkersRef.current.clear();
    if (!aisOn) return;
    const here = hitRef.current;
    for (const ship of aisShips) {
      const course = ship.heading ?? ship.cog ?? 0;
      const icon = Leaflet.divIcon({
        className: "ais-pin",
        html: `<div class="ais-rot" data-course="${course}" style="width:22px;height:22px;color:${ship.color}"><svg viewBox="0 0 22 22" width="22" height="22"><polygon points="11,1 20,20 11,15 2,20" fill="currentColor" stroke="#173746" stroke-width="1"/></svg></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      const marker = Leaflet.marker([ship.lat, ship.lng], { icon, zIndexOffset: 700 });
      const km = here ? haversineKm(here.lat, here.lng, ship.lat, ship.lng) : null;
      marker.bindPopup(aisPopup(ship, km), { maxWidth: 280 });
      marker.addTo(layer);
      aisMarkersRef.current.set(ship.id, marker);
    }
    paintAis();
  }, [aisShips, aisOn]);

  useEffect(() => {
    let cancelled = false;
    async function pull() {
      try {
        const next = await getUmmQasrTide();
        if (!cancelled) {
          setTurns(next);
        }
      } catch {
        // Keep the last available tide values if a refresh fails.
      }
    }
    void pull();
    const id = window.setInterval(() => void pull(), 30 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const inside = inPreviewFrame();
    setFramed(inside);
    const current = new URL(window.location.href);
    const asked = current.searchParams.get("jrc") === "1";
    setLinkHref(standaloneHref());
    if (!inside && asked) {
      setGpsNote("Press Connect JRC and select the USB adapter port of the JLR-7500.");
    }
  }, []);

  useEffect(() => {
    const id = requestAnimationFrame(() => mapRef.current?.invalidateSize());
    return () => cancelAnimationFrame(id);
  }, [pane, rightOpen]);

  useEffect(() => {
    drawPlanRef.current();
  }, [planPts, hit]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getContainer().style.cursor = etaMode || vrmOn || planOn || anchorPick || voyageOn ? "crosshair" : "";
  }, [etaMode, vrmOn, planOn, anchorPick, voyageOn, survey]);

  useEffect(() => {
    const map = mapRef.current;
    const Leaflet = leafletRef.current;
    const ship = hitRef.current;
    if (!map || !Leaflet || !ship) return;
    if (!dest) {
      destMarkerRef.current?.remove();
      destMarkerRef.current = null;
      routeRef.current?.remove();
      routeRef.current = null;
      fittedDestRef.current = "";
      return;
    }
    if (!destMarkerRef.current) {
      const icon = Leaflet.divIcon({
        className: "dest-pin",
        html: '<span class="dest-pin-core"></span>',
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      destMarkerRef.current = Leaflet.marker([dest.lat, dest.lng], {
        icon,
        interactive: false,
        zIndexOffset: 700,
      }).addTo(map);
    } else {
      destMarkerRef.current.setLatLng([dest.lat, dest.lng]);
    }
    const line: L.LatLngExpression[] = [
      [ship.lat, ship.lng],
      [dest.lat, dest.lng],
    ];
    if (!routeRef.current) {
      routeRef.current = Leaflet.polyline(line, {
        color: "#a43d77",
        weight: 3,
        opacity: 0.95,
        dashArray: "8 7",
      }).addTo(map);
    } else {
      routeRef.current.setLatLngs(line);
    }
    const key = `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;
    if (fittedDestRef.current !== key) {
      fittedDestRef.current = key;
      map.fitBounds(Leaflet.latLngBounds([ship.lat, ship.lng], [dest.lat, dest.lng]), {
        padding: [48, 48],
        maxZoom: 16,
      });
    }
  }, [dest, hit]);

  useEffect(() => {
    const map = mapRef.current;
    const Leaflet = leafletRef.current;
    if (!map || !Leaflet) return;
    if (!voyageLayerRef.current) voyageLayerRef.current = Leaflet.layerGroup().addTo(map);
    const layer = voyageLayerRef.current;
    layer.clearLayers();
    if (wps.length === 0) return;
    const ship = hitRef.current;
    const line: L.LatLngExpression[] = [];
    if (ship) line.push([ship.lat, ship.lng]);
    wps.forEach((wp, index) => {
      line.push([wp.lat, wp.lng]);
      const icon = Leaflet.divIcon({
        className: "ship-pin",
        html: `<span style="display:grid;place-items:center;width:22px;height:22px;border-radius:999px;background:#a43d77;color:#ffffff;font:700 11px sans-serif;border:2px solid #ffffff">${index + 1}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      Leaflet.marker([wp.lat, wp.lng], { icon, interactive: false, zIndexOffset: 650 }).addTo(layer);
    });
    if (line.length >= 2) {
      Leaflet.polyline(line, { color: "#a43d77", weight: 3, opacity: 0.95 }).addTo(layer);
    }
  }, [wps, hit]);

  function askGps() {
    if (!navigator.geolocation) {
      setGpsNote("This browser has no position fix.");
      return;
    }
    if (watchRef.current != null) {
      stopTrackingRef.current();
      setGpsNote("Tracking stopped. The mark stays on the last fix.");
      return;
    }
    setGpsNote("Tracking GPS. The mark moves on the chart and the model together.");
    setTracking(true);
    watchRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const speedKn = pos.coords.speed == null ? null : pos.coords.speed * 1.943844;
        apiRef.current.locate?.(pos.coords.latitude, pos.coords.longitude, speedKn, pos.coords.heading);
      },
      () => {
        stopTrackingRef.current();
        setGpsNote("Could not read the position. Allow GPS access and try again.");
      },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }

  function serialErrorNote(err: unknown): string {
    const name = err instanceof DOMException ? err.name : "";
    const message = err instanceof Error ? err.message : "";
    if (name === "SecurityError" || name === "NotAllowedError") {
      return "The in-chat preview cannot read the serial cable. Open the link window, then press Connect JRC.";
    }
    if (name === "NetworkError" || name === "InvalidStateError") {
      return "COM20 is already open. The OpenSeaMap chart is not the cause. Close any other program using that COM port, press Delete COM, then Create COM, then Connect JRC once.";
    }
    return message ? `Could not open the port: ${message}` : "Could not open the port. Confirm the adapter shows as a USB serial port.";
  }

  function applyNmeaFix(fix: NmeaFix | null) {
    if (!fix || !fix.valid) return;
    if (fix.lat != null && fix.lng != null) {
      const surveys = surveysRef.current;
      if (surveys.length) {
        const away = coverage(surveys, fix.lat, fix.lng);
        if (away.km > 80) {
          setGpsNote(`Ignored a fix ${formatNm(away.km, 0)} from the survey. It is not a position in this area.`);
          return;
        }
      }
    }
    if (fix.sogKn != null) {
      sogRef.current = fix.sogKn;
      setSogKn(fix.sogKn);
    }
    if (fix.cogDeg != null) {
      cogRef.current = ((fix.cogDeg % 360) + 360) % 360;
      setCogDeg(cogRef.current);
    }
    if (fix.headingDeg != null) {
      headingRef.current = ((fix.headingDeg % 360) + 360) % 360;
      setHeadingDeg(headingRef.current);
    }
    if (fix.lat != null && fix.lng != null) {
      pushTrack(fix.lat, fix.lng);
      apiRef.current.locate?.(fix.lat, fix.lng, fix.sogKn ?? sogRef.current);
    } else if (hitRef.current && (fix.cogDeg != null || fix.headingDeg != null || fix.sogKn != null)) {
      syncNav(hitRef.current.lat, hitRef.current.lng);
    }
  }

  function clearBluetoothConnection() {
    const device = bluetoothDeviceRef.current;
    const characteristic = bluetoothCharacteristicRef.current;
    const valueHandler = bluetoothValueHandlerRef.current;
    const disconnectHandler = bluetoothDisconnectHandlerRef.current;
    bluetoothDeviceRef.current = null;
    bluetoothCharacteristicRef.current = null;
    bluetoothValueHandlerRef.current = null;
    bluetoothDisconnectHandlerRef.current = null;
    if (characteristic && valueHandler) {
      characteristic.removeEventListener("characteristicvaluechanged", valueHandler);
      void characteristic.stopNotifications().catch(() => {});
    }
    if (device && disconnectHandler) device.removeEventListener("gattserverdisconnected", disconnectHandler);
    if (device?.gatt?.connected) device.gatt.disconnect();
  }

  async function disconnectBluetooth() {
    clearBluetoothConnection();
    setBluetoothOn(false);
    setSogKn(null);
    sogRef.current = null;
    setGpsNote("DGPS Bluetooth disconnected. The mark stays on the last position.");
  }

  async function connectBluetooth() {
    if (bluetoothDeviceRef.current) {
      await disconnectBluetooth();
      return;
    }
    if (serialPortRef.current) {
      setGpsNote("Disconnect JRC before connecting another GPS receiver.");
      return;
    }
    if (inPreviewFrame() || !window.isSecureContext) {
      window.open(standaloneHref(), "_blank");
      setFramed(true);
      setGpsNote("Open the link window, then press DGPS Bluetooth and select the BLE receiver.");
      return;
    }
    const bluetooth = (navigator as Navigator & { bluetooth?: WebBluetoothApi }).bluetooth;
    if (!bluetooth) {
      setGpsNote("Bluetooth LE is unavailable here. Open this page in Chrome or Edge on a supported device.");
      return;
    }

    stopTrackingRef.current();
    try {
      const device = await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_NMEA_SERVICES });
      bluetoothDeviceRef.current = device;
      const disconnectHandler: EventListener = () => {
        if (bluetoothDeviceRef.current !== device) return;
        const characteristic = bluetoothCharacteristicRef.current;
        const valueHandler = bluetoothValueHandlerRef.current;
        if (characteristic && valueHandler) characteristic.removeEventListener("characteristicvaluechanged", valueHandler);
        bluetoothDeviceRef.current = null;
        bluetoothCharacteristicRef.current = null;
        bluetoothValueHandlerRef.current = null;
        bluetoothDisconnectHandlerRef.current = null;
        device.removeEventListener("gattserverdisconnected", disconnectHandler);
        setBluetoothOn(false);
        setSogKn(null);
        sogRef.current = null;
        setGpsNote("DGPS Bluetooth connection lost. Reconnect the receiver to resume GPS updates.");
      };
      bluetoothDisconnectHandlerRef.current = disconnectHandler;
      device.addEventListener("gattserverdisconnected", disconnectHandler);

      const server = await device.gatt?.connect();
      if (!server) throw new Error("This device does not provide a Bluetooth LE GATT connection.");
      const services = await server.getPrimaryServices();
      const decoder = new TextDecoder("ascii");
      let buffer = "";
      let hasReceivedNmea = false;
      let selected: BleNmeaCharacteristic | null = null;
      for (const service of services) {
        const characteristics = await service.getCharacteristics();
        for (const characteristic of characteristics) {
          if (characteristic.properties?.notify === true) {
            selected = characteristic;
            break;
          }
        }
        if (selected) break;
      }
      if (!selected) {
        throw new Error("No readable NMEA notification characteristic was found. This app supports BLE NMEA receivers using Nordic UART or HM-10 services.");
      }

      const valueHandler: EventListener = (event) => {
        const characteristic = event.target as BleNmeaCharacteristic | null;
        const value = characteristic?.value;
        if (!value) return;
        buffer += decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), { stream: true });
        let cut = buffer.search(/[\r\n]/);
        while (cut >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          const fix = parseNmeaLine(line);
          if (fix) {
            applyNmeaFix(fix);
            if (!hasReceivedNmea) {
              hasReceivedNmea = true;
              setGpsNote(`DGPS Bluetooth live on ${device.name || "receiver"}.`);
            }
          }
          cut = buffer.search(/[\r\n]/);
        }
        if (buffer.length > 4096) buffer = buffer.slice(-256);
      };
      bluetoothCharacteristicRef.current = selected;
      bluetoothValueHandlerRef.current = valueHandler;
      selected.addEventListener("characteristicvaluechanged", valueHandler);
      await selected.startNotifications();
      setBluetoothOn(true);
      setSogKn(null);
      sogRef.current = null;
      setGpsNote(`DGPS Bluetooth connected to ${device.name || "receiver"}. Waiting for NMEA position data.`);
    } catch (err) {
      const device = bluetoothDeviceRef.current;
      clearBluetoothConnection();
      setBluetoothOn(false);
      if (err instanceof DOMException && (err.name === "NotFoundError" || err.name === "AbortError")) return;
      const message = err instanceof Error ? err.message : "Could not connect to the Bluetooth receiver.";
      if (/notification characteristic|primary service|GATT|service/i.test(message)) {
        setGpsNote(`${message} Check that the receiver exposes BLE NMEA and is not connected to another device.`);
      } else if (device) {
        setGpsNote(`Bluetooth connection failed: ${message}`);
      } else {
        setGpsNote(`Could not select a Bluetooth receiver: ${message}`);
      }
    }
  }

  async function disconnectJrc() {
    const source = serialSource;
    serialStopRef.current = true;
    const reader = serialReaderRef.current;
    const port = serialPortRef.current;
    const done = serialDoneRef.current;
    serialReaderRef.current = null;
    serialPortRef.current = null;
    setSerialOn(false);
    setSerialSource(null);
    setSogKn(null);
    sogRef.current = null;
    try {
      await reader?.cancel();
    } catch {
      /* read ended */
    }
    await done.catch(() => {});
    try {
      await port?.close();
    } catch {
      /* port closed */
    }
    setGpsNote(`${source || "GPS"} disconnected. The mark stays on the last position.`);
  }

  async function readPort(
    port: ShipPort,
    rate: number,
    probeMs: number,
    fastReject: boolean,
  ): Promise<{ bytes: number; sample: string; locked: boolean }> {
    const reader = port.readable?.getReader();
    if (!reader) return { bytes: 0, sample: "", locked: false };
    serialReaderRef.current = reader;
    let finish = () => {};
    serialDoneRef.current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const decoder = new TextDecoder("iso-8859-1");
    let buffer = "";
    let bytes = 0;
    let sample = "";
    let locked = false;
    const timer =
      probeMs > 0
        ? window.setTimeout(() => {
            if (!locked) void reader.cancel().catch(() => {});
          }, probeMs)
        : 0;
    try {
      while (!serialStopRef.current) {
        const { value, done } = await reader.read();
        if (done) {
          if (locked && !serialStopRef.current) {
            setSerialOn(false);
            setSerialSource(null);
            serialPortRef.current = null;
            setGpsNote("The set cable dropped or the port closed.");
          }
          break;
        }
        if (!value?.length) continue;
        bytes += value.length;
        const text = decoder.decode(value, { stream: true });
        sample = (sample + text).slice(-160);
        buffer += text;
        let cut = buffer.search(/[\r\n]/);
        while (cut >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          const fix = parseNmeaLine(line);
          if (fix) {
            if (!locked) {
              locked = true;
              if (timer) window.clearTimeout(timer);
              setBaud(rate);
            }
            applyNmeaFix(fix);
          }
          cut = buffer.search(/[\r\n]/);
        }
        if (buffer.length > 4096) buffer = buffer.slice(-256);
        if (fastReject && !locked && bytes > 96 && !sample.includes("$")) {
          const printable = [...sample].filter((ch) => ch >= " " && ch <= "~").length;
          if (sample.length > 0 && printable / sample.length < 0.72) {
            void reader.cancel().catch(() => {});
          }
        }
      }
    } catch {
      if (locked && !serialStopRef.current) {
        setSerialOn(false);
        setSerialSource(null);
        serialPortRef.current = null;
        setGpsNote("The set cable dropped or the port closed.");
      }
    } finally {
      if (timer) window.clearTimeout(timer);
      serialReaderRef.current = null;
      try {
        reader.releaseLock();
      } catch {
        /* reader cancelled */
      }
      finish();
    }
    return { bytes, sample, locked };
  }

  async function openShipPort(port: ShipPort, rate: number) {
    const options = {
      baudRate: rate,
      dataBits: 8 as const,
      stopBits: 1 as const,
      parity: "none" as const,
      flowControl: "none" as const,
      bufferSize: 65536,
    };
    const attempt = () => port.open(options).then(() => "ok" as const, (err: unknown) => err);
    let openTimer = 0;
    let openResult = await Promise.race([
      attempt(),
      new Promise<"timeout">((resolve) => {
        openTimer = window.setTimeout(() => resolve("timeout"), 8000);
      }),
    ]);
    window.clearTimeout(openTimer);
    if (openResult === "ok") return;
    const busy = openResult instanceof DOMException && (openResult.name === "InvalidStateError" || openResult.name === "NetworkError");
    if (!busy && openResult !== "timeout") throw openResult;
    try {
      await port.close();
    } catch {
      /* already closed or still held */
    }
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    if (serialStopRef.current) return;
    openTimer = 0;
    openResult = await Promise.race([
      attempt(),
      new Promise<"timeout">((resolve) => {
        openTimer = window.setTimeout(() => resolve("timeout"), 8000);
      }),
    ]);
    window.clearTimeout(openTimer);
    if (openResult === "ok") return;
    if (openResult instanceof DOMException && openResult.name === "InvalidStateError") return;
    if (openResult === "timeout") throw new Error("COM did not open. In HW VSP, press Delete COM, then Create COM, and connect once.");
    throw openResult;
  }

  async function scanAndRead(port: ShipPort, firstBaud: number, source: "JRC" | "Bluetooth SPP") {
    const catalog = source === "Bluetooth SPP" ? DGPS_BAUDS : [firstBaud];
    const order = [firstBaud, ...catalog.filter((rate) => rate !== firstBaud)];
    let sawBytes = false;
    let sample = "";
    for (let index = 0; index < order.length; index += 1) {
      if (serialStopRef.current || serialPortRef.current !== port) return;
      const rate = order[index];
      setGpsNote(source === "Bluetooth SPP" ? `DGPS trying ${rate} baud…` : `COM open at ${rate}. The chart is not involved. Reading the receiver…`);
      try {
        await openShipPort(port, rate);
      } catch (err) {
        if (serialStopRef.current) return;
        serialPortRef.current = null;
        setSerialOn(false);
        setSerialSource(null);
        setGpsNote(serialErrorNote(err));
        return;
      }
      try {
        await port.setSignals?.({ dataTerminalReady: true, requestToSend: false });
      } catch {
        /* adapter has no control lines */
      }
      const probeMs = source === "JRC" ? 0 : index === 0 ? 7000 : 3500;
      const held = await readPort(port, rate, probeMs, false);
      if (held.locked || serialStopRef.current || serialPortRef.current !== port) return;
      sawBytes = sawBytes || held.bytes > 0;
      if (held.sample) sample = held.sample;
      if (source === "JRC") break;
      if (index < order.length - 1) {
        try {
          await port.close();
        } catch {
          /* reopen at another baud */
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400));
      }
    }
    if (serialStopRef.current || serialPortRef.current !== port) return;
    try {
      await port.close();
    } catch {
      /* closed */
    }
    serialPortRef.current = null;
    setSerialOn(false);
    setSerialSource(null);
    if (!sawBytes) {
      setGpsNote(source === "Bluetooth SPP"
        ? `DGPS tried ${order.join(", ")} baud and no data arrived. Check the receiver is on and select its outgoing COM port.`
        : "No data arrived. In HW VSP, VSP must say Created and LAN Connected to 169.254.1.0 port 5018. On the Trimble, GGA, RMC and VTG must be 1Hz.");
      return;
    }
    const hint = sample.replace(/[^\t\n\r\x20-\x7e]/g, "·").trim().slice(0, 70);
    setGpsNote(
      hint
        ? `Data arrived, but it is not a position. Set the unit FORMAT to NMEA. Sample: ${hint}`
        : "Unreadable data. Set the unit FORMAT to NMEA.",
    );
  }

  async function connectJrc() {
    if (serialPortRef.current) {
      if (serialSource === "JRC") await disconnectJrc();
      else setGpsNote("Disconnect the Bluetooth COM receiver before connecting JRC.");
      return;
    }
    if (bluetoothDeviceRef.current) {
      setGpsNote("Disconnect DGPS Bluetooth before connecting JRC.");
      return;
    }
    if (inPreviewFrame() || !window.isSecureContext) {
      window.open(standaloneHref(), "_blank");
      setFramed(true);
      setGpsNote("The preview cannot read the cable. In the new window press Connect JRC and choose the adapter port.");
      return;
    }
    const serial = jrcSerial();
    if (!serial) {
      setGpsNote("This browser cannot read a USB port. Open the page in Chrome or Edge on the computer.");
      return;
    }
    stopTrackingRef.current();
    try {
      const port = await serial.requestPort();
      serialPortRef.current = port;
      serialStopRef.current = false;
      shipFramedRef.current = false;
      setSerialOn(true);
      setSerialSource("JRC");
      setSogKn(null);
      sogRef.current = null;
      void scanAndRead(port, baud, "JRC");
    } catch (err) {
      serialPortRef.current = null;
      setSerialOn(false);
      setSerialSource(null);
      if (err instanceof DOMException && (err.name === "NotFoundError" || err.name === "AbortError")) return;
      const name = err instanceof DOMException ? err.name : "";
      if (name === "SecurityError" || name === "NotAllowedError") setFramed(true);
      setGpsNote(serialErrorNote(err));
    }
  }

  async function connectBluetoothSpp() {
    if (serialPortRef.current) {
      if (serialSource === "Bluetooth SPP") await disconnectJrc();
      else setGpsNote("Disconnect JRC before connecting a Bluetooth COM receiver.");
      return;
    }
    if (bluetoothDeviceRef.current) {
      setGpsNote("Disconnect the DGPS Bluetooth LE receiver before selecting a Bluetooth COM port.");
      return;
    }
    if (inPreviewFrame() || !window.isSecureContext) {
      window.open(standaloneHref(), "_blank");
      setFramed(true);
      setGpsNote("Pair the receiver in Windows first, then open the link window and select its Bluetooth COM port.");
      return;
    }
    const serial = jrcSerial();
    if (!serial) {
      setGpsNote("Bluetooth COM ports are unavailable here. Use Chrome or Edge on a computer after pairing the receiver in Windows.");
      return;
    }
    stopTrackingRef.current();
    try {
      setGpsNote("Select the Bluetooth serial port for the paired DGPS receiver.");
      const port = await serial.requestPort();
      serialPortRef.current = port;
      serialStopRef.current = false;
      shipFramedRef.current = false;
      setSerialOn(true);
      setSerialSource("Bluetooth SPP");
      setSogKn(null);
      sogRef.current = null;
      void scanAndRead(port, baud, "Bluetooth SPP");
    } catch (err) {
      serialPortRef.current = null;
      setSerialOn(false);
      setSerialSource(null);
      if (err instanceof DOMException && (err.name === "NotFoundError" || err.name === "AbortError")) return;
      const message = err instanceof Error ? err.message : "Could not open the Bluetooth COM port.";
      setGpsNote(`Could not open the Bluetooth port: ${message}. Pair the receiver in Windows and select its incoming COM port.`);
    }
  }

  async function disconnectSounder() {
    sounderStopRef.current = true;
    const reader = sounderReaderRef.current;
    const port = sounderPortRef.current;
    const done = sounderDoneRef.current;
    sounderReaderRef.current = null;
    sounderPortRef.current = null;
    setSounderOn(false);
    setSounderM(null);
    try {
      await reader?.cancel();
    } catch {
      /* read ended */
    }
    await done.catch(() => {});
    try {
      await port?.close();
    } catch {
      /* port closed */
    }
    setSounderNote("Echo sounder disconnected.");
  }

  async function readSounder(port: ShipPort, rate: number, probeMs: number): Promise<{ bytes: number; sample: string; locked: boolean }> {
    const reader = port.readable?.getReader();
    if (!reader) return { bytes: 0, sample: "", locked: false };
    sounderReaderRef.current = reader;
    let finish = () => {};
    sounderDoneRef.current = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const decoder = new TextDecoder("iso-8859-1");
    let buffer = "";
    let bytes = 0;
    let sample = "";
    let locked = false;
    const timer =
      probeMs > 0
        ? window.setTimeout(() => {
            if (!locked) void reader.cancel().catch(() => {});
          }, probeMs)
        : 0;
    try {
      while (!sounderStopRef.current) {
        const { value, done } = await reader.read();
        if (done) {
          if (locked && !sounderStopRef.current) {
            setSounderOn(false);
            sounderPortRef.current = null;
            setSounderM(null);
            setSounderNote("Echo sounder cable dropped or the port closed.");
          }
          break;
        }
        if (!value?.length) continue;
        bytes += value.length;
        const text = decoder.decode(value, { stream: true });
        sample = (sample + text).slice(-160);
        buffer += text;
        let cut = buffer.search(/[\r\n]/);
        while (cut >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          const depth = parseDepthLine(line);
          if (depth) {
            if (!locked) {
              locked = true;
              if (timer) window.clearTimeout(timer);
              setSounderNote(`Echo sounder live at ${rate} baud.`);
            }
            setSounderM(depth.meters);
            setSounderRef(depth.ref);
          }
          cut = buffer.search(/[\r\n]/);
        }
        if (buffer.length > 4096) buffer = buffer.slice(-256);
      }
    } catch {
      if (locked && !sounderStopRef.current) {
        setSounderOn(false);
        sounderPortRef.current = null;
        setSounderM(null);
        setSounderNote("Echo sounder cable dropped or the port closed.");
      }
    } finally {
      if (timer) window.clearTimeout(timer);
      sounderReaderRef.current = null;
      try {
        reader.releaseLock();
      } catch {
        /* reader cancelled */
      }
      finish();
    }
    return { bytes, sample, locked };
  }

  async function scanSounder(port: ShipPort) {
    let sawBytes = false;
    let sample = "";
    for (let index = 0; index < JRC_BAUDS.length; index += 1) {
      if (sounderStopRef.current || sounderPortRef.current !== port) return;
      const rate = JRC_BAUDS[index];
      setSounderNote(`Sounder trying ${rate} baud…`);
      try {
        await port.open({
          baudRate: rate,
          dataBits: 8,
          stopBits: 1,
          parity: "none",
          flowControl: "none",
          bufferSize: 65536,
        });
      } catch (err) {
        if (sounderStopRef.current) return;
        sounderPortRef.current = null;
        setSounderOn(false);
        setSounderNote(serialErrorNote(err));
        return;
      }
      try {
        await port.setSignals?.({ dataTerminalReady: true, requestToSend: false });
      } catch {
        /* adapter has no control lines */
      }
      const last = index === JRC_BAUDS.length - 1;
      const probe = await readSounder(port, rate, last ? 2600 : 1800);
      sawBytes = sawBytes || probe.bytes > 0;
      if (probe.sample) sample = probe.sample;
      if (probe.locked || sounderStopRef.current || sounderPortRef.current !== port) {
        if (sounderPortRef.current !== port) {
          try {
            await port.close();
          } catch {
            /* closed with the drop */
          }
        }
        return;
      }
      try {
        await port.close();
      } catch {
        /* reopen at another baud */
      }
    }
    if (sounderStopRef.current || sounderPortRef.current !== port) return;
    try {
      await port.close();
    } catch {
      /* closed */
    }
    sounderPortRef.current = null;
    setSounderOn(false);
    if (!sawBytes) {
      setSounderNote("Sounder port is open but no data is arriving. Wire JFE-680 NMEA OUT A/B to the USB adapter.");
      return;
    }
    const hint = sample.replace(/[^\t\n\r\x20-\x7e]/g, "·").trim().slice(0, 70);
    setSounderNote(hint ? `Sounder data is not depth. Sample: ${hint}` : "Sounder data is not a depth sentence.");
  }

  async function connectSounder() {
    if (sounderPortRef.current) {
      await disconnectSounder();
      return;
    }
    if (inPreviewFrame() || !window.isSecureContext) {
      window.open(standaloneHref(), "_blank");
      setFramed(true);
      setSounderNote("The preview cannot read the cable. In the new window press Connect sounder.");
      return;
    }
    const serial = jrcSerial();
    if (!serial) {
      setSounderNote("This browser cannot read a USB port. Open the page in Chrome or Edge on the computer.");
      return;
    }
    try {
      const port = await serial.requestPort();
      sounderPortRef.current = port;
      sounderStopRef.current = false;
      setSounderOn(true);
      setSounderM(null);
      void scanSounder(port);
    } catch (err) {
      sounderPortRef.current = null;
      setSounderOn(false);
      if (err instanceof DOMException && (err.name === "NotFoundError" || err.name === "AbortError")) return;
      const name = err instanceof DOMException ? err.name : "";
      if (name === "SecurityError" || name === "NotAllowedError") setFramed(true);
      setSounderNote(serialErrorNote(err));
    }
  }

  function pickDepthMap(key: "gas" | "river") {
    depthMapRef.current = key;
    setDepthMap(key);
    showDepthMapRef.current(key);
  }

  function jumpToDraft() {
    const lat = parseCoord(latDraft, 90, latHemi === "S");
    const lng = parseCoord(lngDraft, 180, lngHemi === "W");
    if (lat == null || lng == null) {
      setGpsNote("Enter a valid latitude and longitude.");
      return;
    }
    stopTrackingRef.current();
    setGpsNote(null);
    setPane("map");
    apiRef.current.focus?.(lat, lng);
  }

  function loadWpRows(points: Array<{ lat: number; lng: number }>) {
    const rows: WpRow[] = points.length
      ? points.map((point, index) => ({
          id: index + 1,
          lat: formatDms(point.lat, 2),
          lng: formatDms(point.lng, 3),
          ns: point.lat < 0 ? "S" : "N",
          ew: point.lng < 0 ? "W" : "E",
        }))
      : [{ id: 1, lat: "", lng: "", ns: "N", ew: "E" }];
    wpSeq.current = rows.length + 1;
    setWpRows(rows);
    setWpNote(null);
  }

  function applyWpTable() {
    const next: Array<{ lat: number; lng: number }> = [];
    for (let index = 0; index < wpRows.length; index += 1) {
      const row = wpRows[index];
      if (!row.lat.trim() && !row.lng.trim()) continue;
      let lat = parseCoord(row.lat, 90, row.ns === "S");
      let lng = parseCoord(row.lng, 180, row.ew === "W");
      if (lat == null || lng == null) {
        setWpNote(`النقطة ${index + 1}: اكتب خط العرض والطول مثل 30 02 23.66 و 047 57 10.66`);
        return;
      }
      if (lat > 40 && lat < 55 && lng > 29 && lng < 32) {
        const hold = lat;
        lat = lng;
        lng = hold;
      }
      next.push({ lat, lng });
    }
    if (!next.length) {
      setWpNote("أضف نقطة واحدة على الأقل.");
      return;
    }
    setWps(next);
    loadWpRows(next);
    setVoyageOn(false);
    setPane("map");
    const map = mapRef.current;
    const Leaflet = leafletRef.current;
    if (map && Leaflet) {
      const bounds = Leaflet.latLngBounds(next.map((point) => [point.lat, point.lng] as [number, number]));
      const ship = hitRef.current;
      if (ship) bounds.extend([ship.lat, ship.lng]);
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
    }
  }

  function goToShip() {
    const here = hitRef.current;
    if (!here) return;
    mapRef.current?.panTo([here.lat, here.lng], { animate: true });
    frameShipRef.current(here.lat, here.lng);
  }

  function recenter() {
    const list = surveysRef.current;
    const map = mapRef.current;
    if (!list.length || !map) return;
    const points: [number, number][] = [];
    for (const area of list) points.push([area.south, area.west], [area.north, area.east]);
    map.fitBounds(points, { padding: [24, 24] });
  }

  const planOffset = offsetReadout(hit && planPts.length >= 2 ? crossTrack(hit, planPts) : null);
  const routeOffset = offsetReadout(hit && wps.length >= 2 ? crossTrack(hit, wps) : null);
  const weatherPoint = weatherLocationMode === "port" ? UMM_QASR_PORT : hit;
  const tideView = turns ? describeUmmTide(turns, Date.now() + minute * 0) : null;
  const voyage = (() => {
    if (!hit || wps.length === 0) return null;
    const legs: Array<{ n: number; course: string; nm: number; eta: string | null }> = [];
    let from = { lat: hit.lat, lng: hit.lng };
    let hours = 0;
    let nm = 0;
    let open = sogKn != null && sogKn >= 0.2;
    for (let i = 0; i < wps.length; i += 1) {
      const quote = etaQuote(from.lat, from.lng, wps[i].lat, wps[i].lng, sogKn);
      nm += quote.nm;
      if (open && quote.reason === "ok") hours += quote.nm / (sogKn as number);
      else if (quote.reason !== "there") open = false;
      const eta =
        quote.reason === "there"
          ? "now"
          : open
            ? new Date(Date.now() + hours * 3600000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : null;
      legs.push({
        n: i + 1,
        course: formatCourse(quote.bearing),
        nm: quote.nm,
        eta,
      });
      from = wps[i];
    }
    return {
      legs,
      nm,
      eta: open ? new Date(Date.now() + hours * 3600000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null,
    };
  })();

  return (
    <div className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-fg">
      <header className="relative z-30 flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
        <div className="flex items-center gap-2 pe-1">
          <span className="grid size-8 place-items-center rounded-full border border-accent/50 text-accent" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="12" cy="12" r="8" />
              <path d="M12 4.5 V8 M12 16 V19.5 M4.5 12 H8 M16 12 H19.5" />
              <path d="M12 8.5 L14 12 L12 15.5 L10 12 Z" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <div className="leading-none">
            <h1 className="text-sm font-semibold tracking-wide">{shipName || "السفينة"}</h1>
            <p className="text-[10px] text-muted">Maritime Navigation</p>
          </div>
        </div>
        <button
          type="button"
          onClick={goToShip}
          title="Go to ship — centre own ship on the chart and the model"
          className="h-8 rounded-lg bg-accent px-3 text-xs font-bold tracking-wide text-bg"
        >
          GTS
        </button>
        <button
          type="button"
          onClick={() => setAlarmOpen(true)}
          aria-label={alarms.length ? `Open ${alarms.length} active alerts` : "Open alert history"}
          className={`h-8 rounded-lg border px-2.5 text-xs font-medium ${alarms.length ? "border-alert-border bg-alert-bg text-alert-fg" : "border-line bg-surface-2"}`}
        >
          Alerts{alarms.length ? ` ${alarms.length}` : ""}
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          aria-pressed={theme === "dark"}
          title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
          className="grid size-8 place-items-center rounded-full border border-line bg-surface-2 text-accent transition-colors hover:bg-accent hover:text-bg"
        >
          {theme === "light" ? <Moon className="size-4" aria-hidden="true" /> : <Sun className="size-4" aria-hidden="true" />}
        </button>
        <div className="ms-auto flex rounded-lg border border-line bg-surface-2 p-0.5">
          <button
            type="button"
            onClick={() => setPane("map")}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${pane === "map" ? "bg-accent text-bg" : "text-fg"}`}
          >
            <MapIcon className="size-3.5" />
            Chart
          </button>
          <button
            type="button"
            onClick={() => setPane("model")}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium ${pane === "model" ? "bg-accent text-bg" : "text-fg"}`}
          >
            <Box className="size-3.5" />
            Model
          </button>
          <button
            type="button"
            onClick={() => setPane("both")}
            className={`h-7 rounded-md px-2 text-xs font-medium ${pane === "both" ? "bg-accent text-bg" : "text-fg"}`}
          >
            Both
          </button>
        </div>
      </header>

      <section className="ecdis-ribbon relative z-30 shrink-0 border-b border-line bg-surface" aria-label="ECDIS ribbon">
        <nav role="tablist" aria-label="ECDIS functions" className="flex gap-1 overflow-x-auto border-b border-line px-2 pt-1">
          <button type="button" role="tab" id="ecdis-tab-chart" aria-controls="tool-menu" aria-selected={menu === "chart"} onClick={() => { setMenu((current) => current === "chart" ? null : "chart"); if (menu !== "chart") setPane("map"); }} className={`shrink-0 border-b-2 px-3 py-2 text-xs font-medium ${menu === "chart" ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"}`}>Chart display</button>
          <button type="button" role="tab" id="ecdis-tab-plan" aria-controls="tool-menu" aria-selected={menu === "plan"} onClick={() => setMenu((current) => current === "plan" ? null : "plan")} className={`shrink-0 border-b-2 px-3 py-2 text-xs font-medium ${menu === "plan" ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"}`}>Route planning</button>
          <button type="button" role="tab" id="ecdis-tab-nav" aria-controls="tool-menu" aria-selected={menu === "nav"} onClick={() => setMenu((current) => current === "nav" ? null : "nav")} className={`shrink-0 border-b-2 px-3 py-2 text-xs font-medium ${menu === "nav" ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"}`}>Route monitoring</button>
          <button type="button" role="tab" id="ecdis-tab-comms" aria-controls="tool-menu" aria-selected={menu === "comms"} onClick={() => setMenu((current) => current === "comms" ? null : "comms")} className={`shrink-0 border-b-2 px-3 py-2 text-xs font-medium ${menu === "comms" ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"}`}>Sensors & connections</button>
          <button type="button" role="tab" id="ecdis-tab-windows" aria-controls="tool-menu" aria-selected={menu === "windows"} onClick={() => setMenu((current) => current === "windows" ? null : "windows")} className={`shrink-0 border-b-2 px-3 py-2 text-xs font-medium ${menu === "windows" ? "border-accent text-accent" : "border-transparent text-muted hover:text-fg"}`}>Windows</button>
        </nav>
            <div key={menu ?? "closed"} id="tool-menu" role="tabpanel" aria-labelledby={menu ? `ecdis-tab-${menu}` : undefined} className={`${menu ? "menu-drop ecdis-ribbon__commands [&_button]:justify-start [&_a]:justify-start" : "hidden"}`}>
          {menu === "windows" ? (
            <>
              <label className="flex h-10 min-w-64 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-xs">
                <input
                  type="checkbox"
                  checked={infoPanelVisible}
                  onChange={(event) => setInfoPanelVisible(event.target.checked)}
                  aria-controls="info-window"
                  className="size-4 accent-accent"
                />
                <LocateFixed className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="flex flex-col leading-tight">
                  <span className="font-semibold">Navigation information</span>
                  <span className="text-[10px] text-muted">Tide · depth · speed · course</span>
                </span>
              </label>
              <label className="flex h-10 min-w-64 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-xs">
                <input
                  type="checkbox"
                  checked={weatherPanelVisible}
                  onChange={(event) => setWeatherPanelVisible(event.target.checked)}
                  aria-controls="weather-window"
                  className="size-4 accent-accent"
                />
                <Cloud className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="flex flex-col leading-tight">
                  <span className="font-semibold">Marine weather</span>
                  <span className="text-[10px] text-muted">Conditions · wind · waves · forecast</span>
                </span>
              </label>
              <label className="flex h-10 min-w-64 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-xs">
                <input
                  type="checkbox"
                  checked={navtexVisible}
                  onChange={(event) => setNavtexVisible(event.target.checked)}
                  aria-controls="navtex-window"
                  className="size-4 accent-accent"
                />
                <Radio className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="flex flex-col leading-tight">
                  <span className="font-semibold">NAVTEX</span>
                  <span className="text-[10px] text-muted">NAVAREA IX warnings</span>
                </span>
              </label>
              <label className="flex h-10 min-w-64 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-xs">
                <input
                  type="checkbox"
                  checked={compassVisible}
                  onChange={(event) => setCompassVisible(event.target.checked)}
                  aria-controls="gyro-compass-window"
                  className="size-4 accent-accent"
                />
                <Compass className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="flex flex-col leading-tight">
                  <span className="font-semibold">Gyro & wind compass</span>
                  <span className="text-[10px] text-muted">GPS course · wind direction</span>
                </span>
              </label>
              <label className="flex h-10 min-w-64 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-xs">
                <input
                  type="checkbox"
                  checked={clockVisible}
                  onChange={(event) => setClockVisible(event.target.checked)}
                  aria-label="ساعة بحرية"
                  aria-controls="marine-clock-window"
                  className="size-4 accent-accent"
                />
                <Clock className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="flex flex-col leading-tight" dir="rtl">
                  <span className="font-semibold">ساعة بحرية</span>
                  <span className="text-[10px] text-muted" dir="ltr">Basra time · UTC · Date</span>
                </span>
              </label>
              <label className="flex h-10 min-w-64 items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-xs">
                <input
                  type="checkbox"
                  checked={rightOpen}
                  onChange={(event) => setRightOpen(event.target.checked)}
                  className="size-4 accent-accent"
                />
                <Ship className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="flex flex-col leading-tight">
                  <span className="font-semibold">Own ship</span>
                  <span className="text-[10px] text-muted">Position · route · depth key</span>
                </span>
              </label>
            </>
          ) : null}
          {menu === "comms" ? (
            <>
              {framed ? (
                <a
                  href={linkHref || undefined}
                  target="_blank"
                  rel="opener"
                  onClick={() => setGpsNote("In the new window press Connect JRC and select the adapter port.")}
                  className="flex h-8 items-center gap-2 rounded-lg bg-accent px-3 text-xs font-medium text-bg"
                >
                  <Cable className="size-3.5" />
                  Open link window
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => void connectJrc()}
                  disabled={serialOn && serialSource !== "JRC"}
                  className={`flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium ${serialOn && serialSource === "JRC" ? "bg-sand text-bg" : "bg-accent text-bg"} disabled:cursor-not-allowed disabled:opacity-50`}
                >
                  <Cable className="size-3.5" />
                  {serialOn && serialSource === "JRC" ? "Disconnect JRC" : "Connect JRC"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void connectBluetooth()}
                title="Connect a BLE DGPS receiver that sends NMEA over Nordic UART or HM-10. Browser Bluetooth does not support Classic SPP."
                disabled={serialOn}
                className={`flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium ${bluetoothOn ? "bg-sand text-bg" : "bg-surface-2"} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <Bluetooth className="size-3.5" />
                {bluetoothOn ? "Disconnect DGPS Bluetooth" : "DGPS Bluetooth"}
              </button>
              <button
                type="button"
                onClick={() => void connectBluetoothSpp()}
                title="يربط منفذ DGPS التسلسلي ويجرب كل السرعات: 4800 ثم 9600 و19200 و38400 و57600 و115200 و2400."
                disabled={serialOn && serialSource !== "Bluetooth SPP" || bluetoothOn}
                className={`flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium ${serialOn && serialSource === "Bluetooth SPP" ? "bg-sand text-bg" : "bg-surface-2"} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <Bluetooth className="size-3.5" />
                {serialOn && serialSource === "Bluetooth SPP" ? "Disconnect Bluetooth COM" : "Bluetooth COM / SPP"}
              </button>
              <button
                type="button"
                onClick={() => void connectSounder()}
                title="JFE-680 NMEA OUT on a second USB adapter. Depth sentences DPT, DBT, DBS."
                className={`flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium ${sounderOn ? "bg-sand text-bg" : "bg-surface-2"}`}
              >
                <Cable className="size-3.5" />
                {sounderOn ? "Disconnect sounder" : "Connect sounder"}
              </button>
              <label
                className="flex h-8 items-center gap-2 rounded-lg bg-surface-2 px-3 text-xs"
                title="أول سرعة تُجرَّب. ربط DGPS يكمل بقية السرعات تلقائياً."
              >
                <span className="text-muted">Baud</span>
                <select
                  value={baud}
                  disabled={serialOn}
                  onChange={(event) => setBaud(Number(event.target.value))}
                  aria-label="Port baud rate"
                  className="bg-transparent"
                  suppressHydrationWarning
                >
                  <option value={4800}>4800</option>
                  <option value={9600}>9600</option>
                  <option value={19200}>19200</option>
                  <option value={38400}>38400</option>
                  <option value={57600}>57600</option>
                  <option value={115200}>115200</option>
                  <option value={2400}>2400</option>
                </select>
              </label>
              <button type="button" onClick={askGps} className={`flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium ${tracking ? "bg-sand text-bg" : "bg-surface-2"}`}>
                <LocateFixed className="size-3.5" />
                {tracking ? "Stop tracking" : "Own ship GPS"}
              </button>
            </>
          ) : null}
          {menu === "chart" ? (
            <>
              <button
                type="button"
                onClick={() => setBase((v) => (v === "chart" ? "satellite" : "chart"))}
                className={`h-8 rounded-lg px-3 text-xs ${base === "chart" ? "bg-accent text-bg" : "bg-surface-2"}`}
              >
                {base === "chart" ? "Nautical chart" : "Satellite"}
              </button>
              <button
                type="button"
                onClick={() => setSeamarks((v) => !v)}
                className={`h-8 rounded-lg px-3 text-xs ${seamarks ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="Buoys, lights, wrecks and hazards from OpenSeaMap"
                aria-pressed={seamarks}
              >
                Marks & hazards
              </button>
              <button
                type="button"
                onClick={() => setDepthsOn((v) => !v)}
                className={`h-8 rounded-lg px-3 text-xs ${depthsOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="إخفاء أو إظهار خرائط الأعماق على الخريطة. العوامات تبقى"
                aria-pressed={depthsOn}
              >
                {depthsOn ? "إخفاء الأعماق" : "إظهار الأعماق"}
              </button>
              <button
                type="button"
                onClick={() => setDaymarksOn((v) => !v)}
                className={`h-8 rounded-lg px-3 text-xs ${daymarksOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="عوامات خور عبد الله في خط العرض وخط الطول المسجّلين"
                aria-pressed={daymarksOn}
              >
                Day marks
              </button>
              <div className="flex h-8 items-center gap-1 rounded-lg bg-surface-2 p-0.5" title="Chart orientation. Right-drag rotates the chart">
                <button
                  type="button"
                  onClick={() => setCourseUpMode(false)}
                  className={`h-7 rounded-md px-2 text-xs font-medium ${!courseUp && !manualBearing ? "bg-accent text-bg" : "text-fg"}`}
                >
                  North up
                </button>
                <button
                  type="button"
                  onClick={() => setCourseUpMode(true)}
                  className={`h-7 rounded-md px-2 text-xs font-medium ${courseUp ? "bg-accent text-bg" : "text-fg"}`}
                >
                  Course up
                </button>
              </div>
              <button type="button" onClick={recenter} className="flex h-8 items-center gap-2 rounded-lg bg-surface-2 px-3 text-xs">
                <Crosshair className="size-3.5" />
                Survey centre
              </button>
            </>
          ) : null}
          {menu === "nav" ? (
            <>
              <button
                type="button"
                onClick={toggleTrack}
                className={`h-8 rounded-lg px-3 text-xs font-medium ${trackOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="Track recorded from the JRC set"
                aria-pressed={trackOn}
              >
                PAST TRACK
              </button>
              <button
                type="button"
                onClick={toggleCourse}
                className={`h-8 rounded-lg px-3 text-xs font-medium ${courseOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="Course from the set. Length is minutes at the current SOG"
                aria-pressed={courseOn}
              >
                COURSE LINE
              </button>
              <label className="flex h-8 items-center gap-2 rounded-lg bg-surface-2 px-3 text-xs">
                <span className="text-muted">Length</span>
                <select
                  value={courseMin}
                  onChange={(event) => setCourseMinutes(Number(event.target.value))}
                  aria-label="Course line length in minutes"
                  className="bg-transparent"
                >
                  <option value={1}>1 min</option>
                  <option value={3}>3 min</option>
                  <option value={6}>6 min</option>
                  <option value={12}>12 min</option>
                </select>
              </label>
              <button
                type="button"
                onClick={toggleVrm}
                className={`h-8 rounded-lg px-3 text-xs font-medium ${vrmOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="Variable range marker and electronic bearing line from own ship"
                aria-pressed={vrmOn}
              >
                VRM/EBL
              </button>
              {vrmOn ? (
                <>
                  <label className="flex h-8 items-center gap-2 rounded-lg bg-surface-2 px-3 text-xs">
                    <span className="text-muted">EBL</span>
                    <input
                      type="number"
                      min={0}
                      max={359}
                      value={eblText}
                      aria-label="EBL bearing degrees true"
                      spellCheck={false}
                      onChange={(event) => {
                        setEblText(event.target.value);
                        commitVrm(Number(event.target.value), vrmNmRef.current);
                      }}
                      onBlur={() => setEblText(String(Math.round(eblDegRef.current)))}
                      className="w-14 bg-transparent"
                    />
                    <span className="text-muted">°T</span>
                  </label>
                  <label className="flex h-8 items-center gap-2 rounded-lg bg-surface-2 px-3 text-xs">
                    <span className="text-muted">VRM</span>
                    <input
                      type="number"
                      min={0.05}
                      max={40}
                      step={0.05}
                      value={vrmText}
                      aria-label="VRM range nautical miles"
                      spellCheck={false}
                      onChange={(event) => {
                        setVrmText(event.target.value);
                        commitVrm(eblDegRef.current, Number(event.target.value));
                      }}
                      onBlur={() => setVrmText(vrmNmRef.current.toFixed(2))}
                      className="w-16 bg-transparent"
                    />
                    <span className="text-muted">NM</span>
                  </label>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setAisOn((on) => !on)}
                className={`h-8 rounded-lg px-3 text-xs font-medium ${aisOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="AIS targets from VesselFinder"
                aria-pressed={aisOn}
              >
                AIS{aisOn && aisShips.length ? ` ${aisShips.length}` : ""}
              </button>
              <p className="mt-2 px-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted">Anchor watch</p>
              <button
                type="button"
                onClick={dropAnchor}
                className={`h-8 rounded-lg px-3 text-xs font-medium ${anchorOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="Set the anchor at own ship and watch the swing circle"
                aria-pressed={anchorOn}
              >
                Anchor watch
              </button>
              <button
                type="button"
                onClick={() => {
                  const next = !anchorPickRef.current;
                  anchorPickRef.current = next;
                  setAnchorPick(next);
                }}
                className={`h-8 rounded-lg px-3 text-xs font-medium ${anchorPick ? "bg-sand text-bg" : "bg-surface-2"}`}
                title="Click the chart to place the anchor"
                aria-pressed={anchorPick}
              >
                Set on chart
              </button>
              <label className="flex h-8 items-center gap-2 rounded-lg bg-surface-2 px-3 text-xs">
                <span className="text-muted">Radius</span>
                <select
                  value={anchorRadius}
                  onChange={(event) => setAnchorRadiusM(Number(event.target.value))}
                  aria-label="Anchor watch radius in metres"
                  className="bg-transparent"
                >
                  <option value={50}>50 m</option>
                  <option value={100}>100 m</option>
                  <option value={150}>150 m</option>
                  <option value={200}>200 m</option>
                  <option value={300}>300 m</option>
                  <option value={500}>500 m</option>
                </select>
              </label>
              {anchorOn ? (
                <button type="button" onClick={clearAnchor} className="h-8 rounded-lg bg-surface-2 px-3 text-xs">
                  Clear anchor
                </button>
              ) : null}
            </>
          ) : null}
          {menu === "plan" ? (
            <>
              <button
                type="button"
                onClick={() => setVoyageOn((on) => !on)}
                aria-pressed={voyageOn}
                className={`h-8 rounded-lg px-3 text-xs font-medium ${voyageOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="Click the chart to add waypoints. Distance, course and ETA follow own-ship SOG."
              >
                Voyage
              </button>
              {wps.length > 0 ? (
                <button type="button" onClick={() => setWps((points) => points.slice(0, -1))} className="h-8 rounded-lg bg-surface-2 px-3 text-xs">
                  Undo WP
                </button>
              ) : null}
              {wps.length > 0 ? (
                <button type="button" onClick={() => { setWps([]); loadWpRows([]); }} className="h-8 rounded-lg bg-surface-2 px-3 text-xs">
                  Clear route
                </button>
              ) : null}
              <div className="wp-table rounded-lg border border-line bg-surface-2 p-2">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold">مسار بالنقاط</p>
                  <button
                    type="button"
                    onClick={() => {
                      const id = wpSeq.current;
                      wpSeq.current += 1;
                      setWpRows((rows) => [...rows, { id, lat: "", lng: "", ns: "N", ew: "E" }]);
                    }}
                    className="h-7 rounded-md bg-bg px-2 text-xs"
                  >
                    إضافة نقطة
                  </button>
                  <button type="button" onClick={() => loadWpRows(wps)} className="h-7 rounded-md bg-bg px-2 text-xs">
                    من الخريطة
                  </button>
                  <button type="button" onClick={applyWpTable} className="h-7 rounded-md bg-accent px-2 text-xs font-medium text-bg">
                    اعتماد المسار
                  </button>
                </div>
                <table className="w-full text-xs" dir="ltr">
                  <thead className="text-muted">
                    <tr>
                      <th className="w-8 py-0.5 text-left font-medium">WP</th>
                      <th className="py-0.5 text-left font-medium">Latitude</th>
                      <th className="py-0.5 text-left font-medium">Longitude</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody>
                    {wpRows.map((row, index) => (
                      <tr key={row.id}>
                        <td className="py-0.5 pr-1 text-muted">{index + 1}</td>
                        <td className="py-0.5 pr-1">
                          <div className="flex overflow-hidden rounded border border-line">
                            <input
                              value={row.lat}
                              onChange={(event) => {
                                const lat = event.target.value;
                                setWpRows((rows) => rows.map((item) => item.id === row.id ? { ...item, lat } : item));
                              }}
                              placeholder="30 02.4605"
                              aria-label={`Latitude waypoint ${index + 1}`}
                              spellCheck={false}
                              className="h-7 min-w-0 flex-1 bg-bg px-1"
                            />
                            <button type="button" onClick={() => setWpRows((rows) => rows.map((item) => item.id === row.id ? { ...item, ns: "N" } : item))} className={`h-7 w-6 text-[10px] font-semibold ${row.ns === "N" ? "bg-accent text-bg" : "text-muted"}`}>N</button>
                            <button type="button" onClick={() => setWpRows((rows) => rows.map((item) => item.id === row.id ? { ...item, ns: "S" } : item))} className={`h-7 w-6 text-[10px] font-semibold ${row.ns === "S" ? "bg-accent text-bg" : "text-muted"}`}>S</button>
                          </div>
                        </td>
                        <td className="py-0.5 pr-1">
                          <div className="flex overflow-hidden rounded border border-line">
                            <input
                              value={row.lng}
                              onChange={(event) => {
                                const lng = event.target.value;
                                setWpRows((rows) => rows.map((item) => item.id === row.id ? { ...item, lng } : item));
                              }}
                              placeholder="047 56.8876"
                              aria-label={`Longitude waypoint ${index + 1}`}
                              spellCheck={false}
                              className="h-7 min-w-0 flex-1 bg-bg px-1"
                            />
                            <button type="button" onClick={() => setWpRows((rows) => rows.map((item) => item.id === row.id ? { ...item, ew: "E" } : item))} className={`h-7 w-6 text-[10px] font-semibold ${row.ew === "E" ? "bg-accent text-bg" : "text-muted"}`}>E</button>
                            <button type="button" onClick={() => setWpRows((rows) => rows.map((item) => item.id === row.id ? { ...item, ew: "W" } : item))} className={`h-7 w-6 text-[10px] font-semibold ${row.ew === "W" ? "bg-accent text-bg" : "text-muted"}`}>W</button>
                          </div>
                        </td>
                        <td className="py-0.5">
                          <button
                            type="button"
                            aria-label={`حذف النقطة ${index + 1}`}
                            onClick={() => setWpRows((rows) => rows.length === 1 ? [{ id: row.id, lat: "", lng: "", ns: "N", ew: "E" }] : rows.filter((item) => item.id !== row.id))}
                            className="h-7 rounded px-1 text-muted"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {wpNote ? <p className="mt-1 text-xs text-sand" role="status">{wpNote}</p> : null}
              </div>
              <button
                type="button"
                onClick={() => setPlanOn((on) => !on)}
                className={`h-8 rounded-lg px-3 text-xs font-medium ${planOn ? "bg-accent text-bg" : "bg-surface-2"}`}
                title="Draw the survey line on the chart"
                aria-pressed={planOn}
              >
                Survey line
              </button>
              {planPts.length > 0 ? (
                <button type="button" onClick={() => setPlanPts([])} className="h-8 rounded-lg bg-surface-2 px-3 text-xs">
                  Clear line
                </button>
              ) : null}
              <p className="mt-2 px-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted">ETA calculation</p>
              <button
                type="button"
                onClick={() => setEtaMode((on) => !on)}
                aria-pressed={etaMode}
                className={`flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium ${etaMode ? "bg-sand text-bg" : "bg-surface-2"}`}
              >
                <Flag className="size-3.5" />
                {etaMode ? "End pick" : "ETA"}
              </button>
              {dest ? (
                <button type="button" onClick={() => setDest(null)} className="h-8 rounded-lg bg-surface-2 px-3 text-xs">
                  Clear point
                </button>
              ) : null}
            </>
          ) : null}
            </div>
      </section>

      {voyageOn ? (
        <p className="shrink-0 border-b border-line bg-surface px-3 py-0.5 text-xs text-sand">
          Click the chart to add waypoints. Each leg shows course, distance and ETA at the current SOG.
        </p>
      ) : null}
      {etaMode ? (
        <p className="shrink-0 border-b border-line bg-surface px-3 py-0.5 text-xs text-sand">
          Pick any point on the chart or the model. ETA uses own-ship position and SOG from the set.
        </p>
      ) : null}
      {vrmOn ? (
        <p className="shrink-0 border-b border-line bg-surface px-3 py-0.5 text-xs text-sand">
          Click the chart to set EBL and VRM from own ship. The ring and line follow the ship.
        </p>
      ) : null}
      {anchorOut ? (
        <p className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-alert-bg px-3 py-1 text-xs text-alert-fg" role="alert">
          ANCHOR WATCH: ship is {anchorDist ?? "—"} m from the anchor. Limit {anchorRadius} m.
          {anchorAck ? (
            <span>Acknowledged. Sound is off until the ship re-enters, then leaves again.</span>
          ) : (
            <>
              <span>Alarm sounding.</span>
              <button type="button" onClick={ackAnchor} className="h-7 rounded-md bg-alert-strong px-2 font-medium text-alert-strong-fg">
                Acknowledge
              </button>
            </>
          )}
        </p>
      ) : anchorOn ? (
        <p className="shrink-0 border-b border-line bg-surface px-3 py-0.5 text-xs text-sand" role="status">
          Anchor watch armed. {anchorDist == null ? "Waiting for position." : `${Math.max(0, anchorRadius - anchorDist)} m inside the ${anchorRadius} m circle.`}
        </p>
      ) : null}
      {anchorPick ? (
        <p className="shrink-0 border-b border-line bg-surface px-3 py-0.5 text-xs text-sand">
          Click the chart to drop the anchor. The circle stays fixed there.
        </p>
      ) : null}
      {planOn ? (
        <p className="shrink-0 border-b border-line bg-surface px-3 py-0.5 text-xs text-sand">
          Click the chart to lay the survey line. Port and starboard offset shows in the readout above.
        </p>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">

      <div className={`grid min-h-0 min-w-0 flex-1 overflow-hidden ${pane === "both" ? "grid-rows-2 lg:grid-cols-2 lg:grid-rows-1" : "grid-rows-1"}`}>
        <div className={`${pane === "model" ? "hidden" : "relative isolate flex"} min-h-0 flex-col overflow-hidden`}>
          <div ref={mapEl} className="min-h-0 flex-1" />
          <button
            type="button"
            onClick={() => setDepthsOn((v) => !v)}
            className={`absolute bottom-3 left-3 z-[500] h-8 rounded-lg border border-line px-3 text-xs font-medium shadow ${depthsOn ? "bg-accent text-bg" : "bg-surface/95 text-fg"}`}
            title="إخفاء أو إظهار خرائط الأعماق. العوامات تبقى"
            aria-pressed={depthsOn}
          >
            {depthsOn ? "إخفاء الأعماق" : "إظهار الأعماق"}
          </button>
          {voyage && voyage.legs.length > 0 ? (
            <div className="absolute top-3 right-3 z-[500] max-h-[52%] w-[min(22rem,calc(100%-1.5rem))] overflow-auto rounded-xl border border-line bg-surface/95 p-2 text-xs shadow-lg">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <p className="font-medium">Voyage</p>
                <p dir="ltr" className="text-sand">
                  {voyage.nm.toFixed(2)} NM
                  {voyage.eta ? ` · ETA ${voyage.eta}` : " · no SOG"}
                </p>
              </div>
              <table className="w-full text-left" dir="ltr">
                <thead className="text-muted">
                  <tr>
                    <th className="py-0.5 font-medium">WP</th>
                    <th className="py-0.5 font-medium">Course</th>
                    <th className="py-0.5 font-medium">Dist</th>
                    <th className="py-0.5 font-medium">ETA</th>
                  </tr>
                </thead>
                <tbody>
                  {voyage.legs.map((leg) => (
                    <tr key={leg.n} className={leg.n === 1 ? "text-sand" : ""}>
                      <td className="py-0.5">{leg.n}</td>
                      <td className="py-0.5">{leg.course}°</td>
                      <td className="py-0.5">{leg.nm.toFixed(2)} NM</td>
                      <td className="py-0.5">{leg.eta ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {aisOn ? (
            <div
              ref={aisPanelRef}
              className="absolute z-[500] flex h-72 min-h-40 w-72 min-w-56 resize flex-col overflow-hidden rounded-xl border border-line bg-surface/95 text-sm shadow-lg"
              style={{ left: aisPosition.x, top: aisPosition.y }}
            >
              <div
                className="flex h-9 shrink-0 cursor-move touch-none select-none items-center gap-2 border-b border-line px-2"
                title="اسحب اللوحة. كبّرها من الزاوية السفلية."
                onPointerDown={(event) => {
                  if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button, select"))) return;
                  aisDragRef.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    startLeft: aisPosition.x,
                    startTop: aisPosition.y,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onPointerMove={(event) => {
                  const drag = aisDragRef.current;
                  const panel = aisPanelRef.current;
                  const bounds = panel?.parentElement;
                  if (!drag || drag.pointerId !== event.pointerId || !panel || !bounds) return;
                  const maxLeft = Math.max(0, bounds.clientWidth - panel.offsetWidth);
                  const maxTop = Math.max(0, bounds.clientHeight - panel.offsetHeight);
                  setAisPosition({
                    x: Math.max(0, Math.min(maxLeft, drag.startLeft + event.clientX - drag.startX)),
                    y: Math.max(0, Math.min(maxTop, drag.startTop + event.clientY - drag.startY)),
                  });
                }}
                onPointerUp={() => { aisDragRef.current = null; }}
                onPointerCancel={() => { aisDragRef.current = null; }}
              >
                <p className="min-w-0 flex-1 truncate text-xs font-semibold">Nearby targets</p>
                <select
                  value={aisNm}
                  onChange={(event) => setAisNm(Number(event.target.value))}
                  aria-label="Target range"
                  className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs"
                >
                  <option value={5}>5 NM</option>
                  <option value={15}>15 NM</option>
                  <option value={25}>25 NM</option>
                  <option value={40}>40 NM</option>
                </select>
                <button
                  type="button"
                  onClick={() => setAisOn(false)}
                  aria-label="إغلاق قائمة السفن"
                  title="إغلاق"
                  className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              </div>
              <p className="shrink-0 px-2 pt-1.5 text-[11px] leading-4 text-muted" title={aisCredit}>
                {aisNote || "AIS targets around own ship."}{" "}
                <a className="underline" href="https://www.vesselfinder.com/" target="_blank" rel="noreferrer">
                  VesselFinder
                </a>
              </p>
              <ScrollFade className="min-h-0 flex-1 px-2 pb-2" size={32}>
              <ul className="space-y-1">
                {aisShips.map((ship) => {
                  const km = hit ? haversineKm(hit.lat, hit.lng, ship.lat, ship.lng) : null;
                  return (
                    <li key={ship.id}>
                      <button
                        type="button"
                        className="w-full rounded-lg bg-surface-2 px-2 py-1.5 text-left"
                        onClick={() => {
                          mapRef.current?.panTo([ship.lat, ship.lng]);
                          aisMarkersRef.current.get(ship.id)?.openPopup();
                        }}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">{ship.name}</span>
                          <span className="text-xs text-sand" dir="ltr">
                            {km == null ? "" : formatNm(km)}
                          </span>
                        </span>
                        <span className="block truncate text-xs text-muted">
                          {ship.type}
                          {ship.sog != null ? ` · ${ship.sog.toFixed(1)} kn` : ""}
                          {ship.cog != null ? ` · ${ship.cog.toFixed(0).padStart(3, "0")}°` : ""}
                          {ship.status ? ` · ${ship.status}` : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              </ScrollFade>
            </div>
          ) : null}
        </div>
        <div className={`${pane === "map" ? "hidden" : "flex"} relative min-h-0 flex-col overflow-hidden`}>
          <div ref={viewEl} className="relative min-h-0 flex-1 overflow-hidden" />
          <div
            className="absolute top-2 left-1/2 z-20 flex -translate-x-1/2 rounded-lg border border-line bg-surface/95 p-0.5 shadow"
            dir="rtl"
            role="tablist"
            aria-label="خرائط الأعماق"
          >
            <button
              type="button"
              role="tab"
              aria-selected={depthMap === "gas"}
              onClick={() => pickDepthMap("gas")}
              className={`h-7 rounded-md px-2.5 text-xs font-medium ${depthMap === "gas" ? "bg-accent text-bg" : "text-fg"}`}
            >
              مقطع الغاز السائل
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={depthMap === "river"}
              onClick={() => pickDepthMap("river")}
              className={`h-7 rounded-md px-2.5 text-xs font-medium ${depthMap === "river" ? "bg-accent text-bg" : "text-fg"}`}
            >
              مدخل النهر
            </button>
          </div>
          <div className="pointer-events-none absolute bottom-3 left-3 right-3 flex flex-col gap-1">
            <p className="w-fit rounded-lg bg-surface/90 px-3 py-1 text-xs text-muted">
              Click the model to move the fix · drag to orbit
            </p>
            {hit ? (
              <p className="w-fit rounded-lg bg-surface/90 px-3 py-1 text-xs text-sand" dir="ltr">
                {hit ? `${formatDms(hit.lat, 2)}${hit.lat < 0 ? " S" : " N"} , ${formatDms(hit.lng, 3)}${hit.lng < 0 ? " W" : " E"} — ${formatDepth(hit.depth)}` : "No position yet"}
              </p>
            ) : null}
          </div>
        </div>
      </div>
        <aside className={`side-slot relative z-[800] flex shrink-0 flex-col overflow-hidden bg-bg ${rightOpen ? "w-72 border-l border-line" : "w-0"}`}>
          <div className="flex h-full w-72 min-w-72 flex-col gap-2 overflow-y-auto p-2">
            <section className="rounded-xl border border-line bg-surface p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-xs font-medium">Own ship (GPS)</p>
                <span className={`text-[10px] ${serialOn || bluetoothOn || tracking ? "text-accent" : "text-muted"}`}>{serialOn || bluetoothOn || tracking ? "Connected" : "Manual"}</span>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" dir="ltr">
                <dt className="text-muted">Position</dt>
                <dd className="text-right">{hit ? `${formatDms(hit.lat, 2)} ${hit.lat < 0 ? "S" : "N"}` : "—"}<br />{hit ? `${formatDms(hit.lng, 3)} ${hit.lng < 0 ? "W" : "E"}` : ""}</dd>
                <dt className="text-muted">SOG</dt>
                <dd className="text-right">{sogKn == null ? "—" : `${sogKn.toFixed(1)} kn`}</dd>
                <dt className="text-muted">COG</dt>
                <dd className="text-right">{cogDeg == null ? "—" : `${formatCourse(cogDeg)}°`}</dd>
                <dt className="text-muted">Depth</dt>
                <dd className="text-right">{sounderM != null ? `${sounderM.toFixed(1)} m` : hit?.depth == null ? "—" : formatDepth(hit.depth)}</dd>
              </dl>
              <button type="button" onClick={goToShip} className="mt-2 h-8 w-full rounded-lg bg-accent text-xs font-bold text-bg" title="Go to ship — centre own ship">GTS — Go to ship</button>
            </section>
            <section className="rounded-xl border border-line bg-surface p-2 text-xs">
              <p className="mb-1 font-medium">Route</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" dir="ltr">
                <dt className="text-muted">Next</dt>
                <dd className="text-right">{wps.length ? `WP 1` : dest ? "ETA point" : "—"}</dd>
                <dt className="text-muted">To go</dt>
                <dd className="text-right">{voyage ? `${voyage.nm.toFixed(2)} NM` : "—"}</dd>
                <dt className="text-muted">ETA</dt>
                <dd className="text-right">{voyage?.eta ?? "—"}</dd>
                <dt className="text-muted">XTE</dt>
                <dd className="text-right">{routeOffset ? `${routeOffset.value} ${routeOffset.unit}` : "—"}</dd>
              </dl>
            </section>
            <section className="rounded-xl border border-line bg-surface p-2 text-xs">
              <p className="mb-1 font-medium">Depth key</p>
              <p className="mb-1 text-[11px] text-muted">{depthMap === "river" ? "مدخل النهر — أعماق متصلة ومعالم نهارية" : "مقطع الغاز السائل"}</p>
              <div
                className="h-3 rounded-full"
                style={{ background: LEGEND_GRADIENT }}
              />
              <div className="relative mt-1 h-4 text-[10px] text-muted" dir="ltr">
                {LEGEND.filter((_, index) => index % 2 === 0).map((stop) => {
                  const pct = ((stop - LEGEND[0]) / (LEGEND[LEGEND.length - 1] - LEGEND[0])) * 100;
                  const shift = pct < 8 ? "translateX(0)" : pct > 92 ? "translateX(-100%)" : "translateX(-50%)";
                  return (
                    <span key={stop} className="absolute top-0" style={{ left: `${pct}%`, transform: shift }}>
                      {stop > 0 ? `+${stop}` : stop}
                    </span>
                  );
                })}
              </div>
            </section>
            <button type="button" onClick={() => setRightOpen(false)} className="mt-auto text-left text-[11px] text-muted">Hide panel</button>
          </div>
        </aside>
        <div
          className={`side-tools absolute top-2 z-[1200] flex flex-col items-end gap-1 ${rightOpen ? "is-shifted" : ""} ${sideToolsOpen ? "is-open" : ""}`}
          aria-label="Window shortcuts"
          onMouseEnter={() => setSideToolsOpen(true)}
          onMouseLeave={() => setSideToolsOpen(false)}
        >
          <button type="button" title="الأدوات" aria-expanded={sideToolsOpen} className="side-tools__trigger grid size-9 place-items-center rounded-lg border border-line bg-surface/95 text-accent shadow">
            <LayoutGrid className="size-4" aria-hidden="true" />
          </button>
          <div className="side-tools__list">
            <div>
              <button type="button" aria-pressed={infoPanelVisible} title="Navigation information" onClick={() => setInfoPanelVisible((open) => !open)} className={`grid size-9 place-items-center rounded-lg border border-line shadow ${infoPanelVisible ? "bg-accent text-bg" : "bg-surface/95 text-accent"}`}>
                <LocateFixed className="size-4" aria-hidden="true" />
              </button>
              <button type="button" aria-pressed={weatherPanelVisible} title="Marine weather" onClick={() => setWeatherPanelVisible((open) => !open)} className={`grid size-9 place-items-center rounded-lg border border-line shadow ${weatherPanelVisible ? "bg-accent text-bg" : "bg-surface/95 text-accent"}`}>
                <Cloud className="size-4" aria-hidden="true" />
              </button>
              <button type="button" aria-pressed={navtexVisible} title="NAVTEX" onClick={() => setNavtexVisible((open) => !open)} className={`grid size-9 place-items-center rounded-lg border border-line shadow ${navtexVisible ? "bg-accent text-bg" : "bg-surface/95 text-accent"}`}>
                <Radio className="size-4" aria-hidden="true" />
              </button>
              <button type="button" aria-pressed={compassVisible} title="Gyro and wind" onClick={() => setCompassVisible((open) => !open)} className={`grid size-9 place-items-center rounded-lg border border-line shadow ${compassVisible ? "bg-accent text-bg" : "bg-surface/95 text-accent"}`}>
                <Compass className="size-4" aria-hidden="true" />
              </button>
              <button type="button" aria-pressed={clockVisible} title="ساعة بحرية" onClick={() => setClockVisible((open) => !open)} className={`grid size-9 place-items-center rounded-lg border border-line shadow ${clockVisible ? "bg-accent text-bg" : "bg-surface/95 text-accent"}`}>
                <Clock className="size-4" aria-hidden="true" />
              </button>
              <button type="button" aria-pressed={rightOpen} title="Own ship" onClick={() => setRightOpen((open) => !open)} className={`grid size-9 place-items-center rounded-lg border border-line shadow ${rightOpen ? "bg-accent text-bg" : "bg-surface/95 text-accent"}`}>
                <Ship className="size-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
        <section
          ref={infoPanelRef}
          id="info-window"
          aria-label="Live navigation information"
          aria-hidden={!infoPanelVisible}
          className={`absolute z-[1100] ${infoPanelVisible ? "flex" : "hidden"} max-h-[calc(100%-1.5rem)] min-h-24 w-[min(28rem,calc(100%-1.5rem))] min-w-64 resize flex-col overflow-auto rounded-xl border border-line bg-surface/95 shadow-xl backdrop-blur`}
          style={{ left: infoPosition.x, top: infoPosition.y }}
        >
          <div
            className="flex h-7 shrink-0 touch-none cursor-move select-none items-center justify-between gap-2 border-b border-line px-2 text-[10px] text-muted"
            title="Drag to move this panel. Resize it from the lower-right corner."
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              infoDragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startLeft: infoPosition.x,
                startTop: infoPosition.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = infoDragRef.current;
              const panel = infoPanelRef.current;
              const bounds = panel?.parentElement;
              if (!drag || drag.pointerId !== event.pointerId || !panel || !bounds) return;
              const maxLeft = Math.max(0, bounds.clientWidth - panel.offsetWidth);
              const maxTop = Math.max(0, bounds.clientHeight - panel.offsetHeight);
              setInfoPosition({
                x: Math.max(0, Math.min(maxLeft, drag.startLeft + event.clientX - drag.startX)),
                y: Math.max(0, Math.min(maxTop, drag.startTop + event.clientY - drag.startY)),
              });
            }}
            onPointerUp={() => {
              infoDragRef.current = null;
            }}
            onPointerCancel={() => {
              infoDragRef.current = null;
            }}
          >
            <span className="flex items-center gap-1.5 font-semibold uppercase tracking-[0.12em] text-fg">
              <Move className="size-3" aria-hidden="true" />
              Live data
            </span>
            <span className="truncate">Drag to move · resize corner</span>
          </div>
          <div className="grid min-w-0 shrink-0 grid-cols-3 gap-px bg-line">
            <Instrument
              label="Tide"
              value={tideView ? tideView.phase : "—"}
              unit={tideView ? `${tideView.remain} left` : ""}
            />
            <Instrument label="HW" value={tideView ? tideView.highTime : "—"} unit={tideView ? "today" : ""} />
            <Instrument label="LW" value={tideView ? tideView.lowTime : "—"} unit={tideView ? "today" : ""} />
            <Instrument label="SOG" value={sogKn == null ? "—" : sogKn.toFixed(1)} unit={sogKn == null ? "" : "kn"} />
            <Instrument
              label="Depth"
              value={sounderM != null ? sounderM.toFixed(1) : hit?.depth == null ? "—" : Math.abs(hit.depth).toFixed(1)}
              unit={
                sounderM != null
                  ? sounderRef === "keel"
                    ? "m keel"
                    : sounderRef === "transducer"
                      ? "m TX"
                      : "m"
                  : hit?.depth == null
                    ? ""
                    : hit.depth < -0.05
                      ? "m below"
                      : hit.depth > 0.05
                        ? "m above"
                        : "m"
              }
            />
            <Instrument
              label="COG"
              value={cogDeg == null ? "—" : formatCourse(cogDeg)}
              unit={cogDeg == null ? "" : "°"}
            />
            <Instrument
              label="XTE"
              value={planOffset ? planOffset.value : "—"}
              unit={planOffset ? planOffset.unit : ""}
            />
          </div>
        </section>
        <NavtexPanel visible={navtexVisible} onHide={() => setNavtexVisible(false)} />
        <section
          ref={weatherPanelRef}
          id="weather-window"
          aria-label="Current marine weather"
          aria-hidden={!weatherPanelVisible}
          className={`absolute z-[1100] ${weatherPanelVisible ? "flex" : "hidden"} h-[min(37rem,calc(100%-8rem))] min-h-40 w-[min(28rem,calc(100%-1.5rem))] min-w-64 resize flex-col overflow-auto rounded-xl border border-line bg-surface/95 shadow-xl backdrop-blur`}
          style={{ left: weatherPosition.x, top: weatherPosition.y }}
        >
          <div
            className="flex h-9 shrink-0 cursor-move touch-none select-none items-center gap-2 border-b border-line px-2"
            title="Drag to move this panel. Resize it from the lower-right corner."
            onPointerDown={(event) => {
              if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
              weatherDragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startLeft: weatherPosition.x,
                startTop: weatherPosition.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = weatherDragRef.current;
              const panel = weatherPanelRef.current;
              const bounds = panel?.parentElement;
              if (!drag || drag.pointerId !== event.pointerId || !panel || !bounds) return;
              const maxLeft = Math.max(0, bounds.clientWidth - panel.offsetWidth);
              const maxTop = Math.max(0, bounds.clientHeight - panel.offsetHeight);
              setWeatherPosition({
                x: Math.max(0, Math.min(maxLeft, drag.startLeft + event.clientX - drag.startX)),
                y: Math.max(0, Math.min(maxTop, drag.startTop + event.clientY - drag.startY)),
              });
            }}
            onPointerUp={() => { weatherDragRef.current = null; }}
            onPointerCancel={() => { weatherDragRef.current = null; }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold">
              <Cloud className="size-4 shrink-0 text-accent" aria-hidden="true" />
              <span className="truncate">Marine weather</span>
              {weatherLoading ? <span className="shrink-0 text-[10px] font-normal text-muted">Updating…</span> : null}
            </span>
            <button
              type="button"
              onClick={() => setWeatherRefreshKey((value) => value + 1)}
              disabled={weatherLoading || (weatherLocationMode === "ship" && !hit)}
              aria-label="Refresh marine weather"
              title="Refresh weather"
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
            >
              <RefreshCw className={`size-3.5 ${weatherLoading ? "animate-spin" : ""}`} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setWeatherPanelVisible(false)}
              aria-label="Hide marine weather window"
              title="Hide window"
              className="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2 text-xs">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5">
              <span className="text-[10px] text-muted">Weather location</span>
              <div role="group" aria-label="Weather location" className="flex rounded-md border border-line bg-surface-2 p-0.5">
                <button type="button" aria-pressed={weatherLocationMode === "port"} onClick={() => { if (weatherLocationMode !== "port") { setWeather(null); setWeatherError(null); setWeatherLocationMode("port"); } }} className={`rounded px-2 py-1 text-[10px] ${weatherLocationMode === "port" ? "bg-accent text-bg" : "text-muted"}`}>Umm Qasr Port</button>
                <button type="button" aria-pressed={weatherLocationMode === "ship"} onClick={() => { if (weatherLocationMode !== "ship") { setWeather(null); setWeatherError(null); setWeatherLocationMode("ship"); } }} className={`rounded px-2 py-1 text-[10px] ${weatherLocationMode === "ship" ? "bg-accent text-bg" : "text-muted"}`}>Ship position</button>
              </div>
            </div>

            {weatherPoint ? (
              <p className="mb-2 flex items-center gap-1.5 text-[10px] text-muted" dir="ltr">
                <LocateFixed className="size-3 shrink-0" aria-hidden="true" />
                {weatherLocationMode === "port" ? "Umm Qasr Port · approx. terminal point" : "Ship location · GPS / chart position"} · {weatherPoint.lat.toFixed(4)}° {weatherPoint.lat >= 0 ? "N" : "S"}, {Math.abs(weatherPoint.lng).toFixed(4)}° {weatherPoint.lng >= 0 ? "E" : "W"}
              </p>
            ) : null}

            {weatherLocationMode === "ship" && !hit ? (
              <div className="rounded-lg border border-line bg-surface-2 p-3 text-muted">
                Set the ship position on the chart or connect GPS to load local weather.
              </div>
            ) : null}

            {weatherError ? (
              <div role="alert" className="mb-2 rounded-lg border border-alert-border bg-alert-bg p-2 text-alert-fg">
                <p className="font-medium">Weather data could not be loaded.</p>
                <p className="mt-0.5 break-words text-[10px]">{weatherError}</p>
                <button type="button" onClick={() => setWeatherRefreshKey((value) => value + 1)} className="mt-1 underline">Try again</button>
              </div>
            ) : null}

            {weather ? (
              <>
                <section className="mb-2 rounded-lg border border-line bg-surface-2 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Cloud className="size-5 shrink-0 text-accent" aria-hidden="true" />
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{describeWeatherCode(weather.current.weather_code)}</p>
                        <p className="truncate text-[10px] text-muted">{weatherLocalTime(weather.currentTime)} · {weather.timezone}</p>
                      </div>
                    </div>
                    <p className="shrink-0 text-xl font-semibold">{weatherValue(weather.current.temperature_2m, "°C")}</p>
                  </div>
                </section>

                <section className="mb-2">
                  <h3 className="mb-1 flex items-center gap-1.5 font-semibold"><Cloud className="size-3.5" aria-hidden="true" /> Atmospheric conditions</h3>
                  <dl className="grid grid-cols-2 gap-1.5">
                    <WeatherMetric label="Feels like" value={weatherValue(weather.current.apparent_temperature, "°C")} />
                    <WeatherMetric label="Dew point" value={weatherValue(weather.current.dew_point_2m, "°C")} />
                    <WeatherMetric label="Humidity" value={weatherValue(weather.current.relative_humidity_2m, "%", 0)} />
                    <WeatherMetric label="Cloud cover" value={weatherValue(weather.current.cloud_cover, "%", 0)} detail={`Low ${weatherValue(weather.current.cloud_cover_low, "%", 0)} · mid ${weatherValue(weather.current.cloud_cover_mid, "%", 0)} · high ${weatherValue(weather.current.cloud_cover_high, "%", 0)}`} />
                    <WeatherMetric label="Wind speed" value={weatherValue(weather.current.wind_speed_10m, "kn")} />
                    <WeatherMetric label="Wind direction" value={weather.current.wind_direction_10m == null ? "—" : `From ${compassDirection(weather.current.wind_direction_10m)}`} detail="From weather data · 10 m" />
                    <WeatherMetric label="Wind gusts" value={weatherValue(weather.current.wind_gusts_10m, "kn")} />
                    <WeatherMetric label="Visibility" value={weather.current.visibility == null ? "—" : weatherValue(weather.current.visibility / 1852, "NM")} />
                    <WeatherMetric label="Sea-level pressure" value={weatherValue(weather.current.pressure_msl, "hPa")} />
                    <WeatherMetric label="Surface pressure" value={weatherValue(weather.current.surface_pressure, "hPa")} />
                    <WeatherMetric label="UV index" value={weatherValue(weather.current.uv_index, "", 1)} detail={weather.current.is_day === 1 ? "Daylight" : weather.current.is_day === 0 ? "Night" : undefined} />
                    <WeatherMetric label="Precipitation" value={weatherValue(weather.current.precipitation, "mm")} detail={`Rain ${weatherValue(weather.current.rain, "mm")} · showers ${weatherValue(weather.current.showers, "mm")}`} />
                    <WeatherMetric label="Precipitation chance" value={weather.hours[0]?.precipitationProbability == null ? "—" : weatherValue(weather.hours[0].precipitationProbability, "%", 0)} />
                    <WeatherMetric label="Snowfall" value={weatherValue(weather.current.snowfall, "cm")} />
                  </dl>
                </section>

                <section className="mb-2">
                  <h3 className="mb-1 flex items-center gap-1.5 font-semibold"><Waves className="size-3.5" aria-hidden="true" /> Marine conditions</h3>
                  {weather.marine ? (
                    <>
                      <dl className="grid grid-cols-2 gap-1.5">
                        <WeatherMetric label="Significant wave height" value={weatherValue(weather.marine.current.wave_height, "m")} />
                        <WeatherMetric label="Wave direction / period" value={`From ${compassDirection(weather.marine.current.wave_direction)}`} detail={`${weatherValue(weather.marine.current.wave_period, "s")} · peak ${weatherValue(weather.marine.current.wave_peak_period, "s")}`} />
                        <WeatherMetric label="Wind-wave height" value={weatherValue(weather.marine.current.wind_wave_height, "m")} detail={`From ${compassDirection(weather.marine.current.wind_wave_direction)} · ${weatherValue(weather.marine.current.wind_wave_period, "s")} · peak ${weatherValue(weather.marine.current.wind_wave_peak_period, "s")}`} />
                        <WeatherMetric label="Swell height" value={weatherValue(weather.marine.current.swell_wave_height, "m")} detail={`From ${compassDirection(weather.marine.current.swell_wave_direction)} · ${weatherValue(weather.marine.current.swell_wave_period, "s")} · peak ${weatherValue(weather.marine.current.swell_wave_peak_period, "s")}`} />
                        {weather.marine.current.secondary_swell_wave_height != null ? <WeatherMetric label="Secondary swell" value={weatherValue(weather.marine.current.secondary_swell_wave_height, "m")} detail={`From ${compassDirection(weather.marine.current.secondary_swell_wave_direction)} · ${weatherValue(weather.marine.current.secondary_swell_wave_period, "s")}`} /> : null}
                        {weather.marine.current.tertiary_swell_wave_height != null ? <WeatherMetric label="Tertiary swell" value={weatherValue(weather.marine.current.tertiary_swell_wave_height, "m")} detail={`From ${compassDirection(weather.marine.current.tertiary_swell_wave_direction)} · ${weatherValue(weather.marine.current.tertiary_swell_wave_period, "s")}`} /> : null}
                        <WeatherMetric label="Sea-surface temperature" value={weatherValue(weather.marine.current.sea_surface_temperature, "°C")} />
                        <WeatherMetric label="Ocean current" value={weather.marine.current.ocean_current_velocity == null ? "—" : weatherValue((weather.marine.currentUnits.ocean_current_velocity ?? "km/h").includes("km") ? weather.marine.current.ocean_current_velocity / 1.852 : weather.marine.current.ocean_current_velocity, "kn")} detail={`Towards ${compassDirection(weather.marine.current.ocean_current_direction)}`} />
                        <WeatherMetric label="Modeled sea level" value={weatherValue(weather.marine.current.sea_level_height_msl, "m")} detail="Relative to global mean sea level" />
                      </dl>
                      <p className="mt-1 text-[10px] text-muted">Marine model cell · {weather.marine.latitude.toFixed(3)}°, {weather.marine.longitude.toFixed(3)}°</p>
                    </>
                  ) : (
                    <p className="rounded-lg border border-line bg-surface-2 p-2 text-[10px] text-muted">Marine data is temporarily unavailable; atmospheric weather is shown above.</p>
                  )}
                </section>

                {weather.hours.length ? (
                  <section className="mb-2">
                    <h3 className="mb-1 flex items-center gap-1.5 font-semibold"><Wind className="size-3.5" aria-hidden="true" /> Next hours</h3>
                    <div className="flex gap-1.5 overflow-x-auto pb-1">
                      {weather.hours.slice(0, 6).map((hour) => (
                        <div key={hour.time} className="min-w-[4.6rem] rounded-lg border border-line bg-surface-2 px-2 py-1.5 text-center">
                          <p className="text-[10px] text-muted">{hour.time.slice(-5)}</p>
                          <p className="font-semibold">{weatherValue(hour.temperature, "°")}</p>
                          <p className="truncate text-[10px] text-muted" title={describeWeatherCode(hour.weatherCode)}>{describeWeatherCode(hour.weatherCode)}</p>
                          <p className="mt-1 text-[10px]">{weatherValue(hour.windSpeed, "kn")}</p>
                          <p className="text-[10px] text-muted">{weatherValue(hour.precipitationProbability, "%", 0)} rain</p>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}

                <p className="border-t border-line pt-1.5 text-[10px] leading-relaxed text-muted">
                  Model estimates · Updated {new Date(weather.fetchedAt).toLocaleTimeString()} · Sources: <a href="https://open-meteo.com/" target="_blank" rel="noreferrer" className="underline">Open-Meteo</a> with <a href="https://www.dwd.de/" target="_blank" rel="noreferrer" className="underline">DWD</a> attribution. Tides and currents use roughly 4 NM model grids and have limited coastal accuracy; these data are not for navigation safety and do not replace a nautical almanac.
                </p>
              </>
            ) : weatherLoading ? (
              <div role="status" className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-3 text-muted">
                <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" /> Loading weather for {weatherLocationMode === "port" ? "Umm Qasr Port" : "the ship position"}…
              </div>
            ) : weatherPoint && !weatherError ? (
              <div className="rounded-lg border border-line bg-surface-2 p-3 text-muted">Weather will appear here once the forecast service responds.</div>
            ) : null}
            <p className="mt-2 flex items-center gap-1 text-[10px] text-muted"><Wind className="size-3" aria-hidden="true" /> Wind speeds in knots · wave heights in metres · temperatures in °C</p>
          </div>
        </section>
        <GyroCompass
          visible={compassVisible}
          heading={headingDeg ?? cogDeg}
          windDirection={weather?.current.wind_direction_10m ?? null}
          windSpeed={weather?.current.wind_speed_10m ?? null}
          windLocation={weatherLocationMode === "port" ? "Umm Qasr Port" : "Ship location"}
          weatherLoading={weatherLoading}
          onHide={() => setCompassVisible(false)}
        />
        <MarineClock visible={clockVisible} onHide={() => setClockVisible(false)} />
      </div>

      <footer className={`relative z-20 flex ${pane === "model" ? "max-h-[24dvh]" : "max-h-[16dvh]"} shrink-0 flex-col gap-1 overflow-y-auto border-t border-line bg-surface px-3 py-1.5`}>
        {dest && hit ? <EtaCard ship={hit} dest={dest} sogKn={sogKn} /> : null}
        <div className="flex flex-col gap-1">
          <form
            className="flex flex-wrap items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              jumpToDraft();
            }}
          >
            <label className="flex h-8 items-center overflow-hidden rounded-lg border border-line bg-bg">
              <span className="px-1.5 text-[10px] text-muted">LAT</span>
              <input
                name="latitude"
                autoComplete="off"
                spellCheck={false}
                inputMode="decimal"
                value={latDraft}
                onChange={(event) => setLatDraft(event.target.value)}
                placeholder="30 02 46.05"
                aria-label="Latitude"
                title="درجات دقائق ثواني، مثل 30 02 46.05"
                className="h-8 w-40 bg-transparent px-1 text-sm"
                dir="ltr"
                suppressHydrationWarning
              />
              <button
                type="button"
                onClick={() => setLatHemi("N")}
                className={`h-8 w-7 text-xs font-semibold ${latHemi === "N" ? "bg-accent text-bg" : "text-muted"}`}
              >
                N
              </button>
              <button
                type="button"
                onClick={() => setLatHemi("S")}
                className={`h-8 w-7 text-xs font-semibold ${latHemi === "S" ? "bg-accent text-bg" : "text-muted"}`}
              >
                S
              </button>
            </label>
            <label className="flex h-8 items-center overflow-hidden rounded-lg border border-line bg-bg">
              <span className="px-1.5 text-[10px] text-muted">LON</span>
              <input
                name="longitude"
                autoComplete="off"
                spellCheck={false}
                inputMode="decimal"
                value={lngDraft}
                onChange={(event) => setLngDraft(event.target.value)}
                placeholder="047 57 10.66"
                aria-label="Longitude"
                title="درجات دقائق ثواني، مثل 047 57 10.66"
                className="h-8 w-40 bg-transparent px-1 text-sm"
                dir="ltr"
                suppressHydrationWarning
              />
              <button
                type="button"
                onClick={() => setLngHemi("E")}
                className={`h-8 w-7 text-xs font-semibold ${lngHemi === "E" ? "bg-accent text-bg" : "text-muted"}`}
              >
                E
              </button>
              <button
                type="button"
                onClick={() => setLngHemi("W")}
                className={`h-8 w-7 text-xs font-semibold ${lngHemi === "W" ? "bg-accent text-bg" : "text-muted"}`}
              >
                W
              </button>
            </label>
            <button type="submit" className="h-8 rounded-lg bg-surface-2 px-3 text-sm">
              Go
            </button>
          </form>
          {pane === "model" ? (
            <div className="grid gap-1 pe-16">
              <label className="flex items-center gap-2 text-xs text-muted">
                <span className="shrink-0">Exag ×{exag}</span>
                <input
                  type="range"
                  min={1}
                  max={12}
                  aria-label="Vertical exaggeration"
                  value={exag}
                  onChange={(event) => setExag(Number(event.target.value))}
                  className="min-w-0 flex-1 accent-accent"
                  suppressHydrationWarning
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <span className="shrink-0" dir="rtl">حجم السفينة <bdi>×{shipSize.toFixed(2)}</bdi></span>
                <input
                  type="range"
                  min={0.25}
                  max={4}
                  step={0.05}
                  value={shipSize}
                  aria-label="حجم السفينة"
                  aria-valuetext={`${shipSize.toFixed(2)}×`}
                  onChange={(event) => setShipSize(Number(event.target.value))}
                  className="min-w-0 flex-1 accent-accent"
                  dir="ltr"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-muted" title="رفع أو خفض قاع المودل للعرض فقط؛ سطح البحر والسفينة ثابتان">
                <span className="shrink-0" dir="rtl">مستوى الأعماق <bdi>{depthOffset > 0 ? "+" : ""}{depthOffset.toFixed(1)} m</bdi></span>
                <input
                  type="range"
                  min={-50}
                  max={50}
                  step={0.5}
                  value={depthOffset}
                  aria-label="مستوى الأعماق بالنسبة لسطح البحر"
                  aria-valuetext={`${depthOffset.toFixed(1)} متر؛ الموجب يرفع القاع والسالب يخفضه`}
                  onChange={(event) => setDepthOffset(Number(event.target.value))}
                  className="min-w-0 flex-1 accent-accent"
                  dir="ltr"
                />
              </label>
            </div>
          ) : null}
          {gpsNote ? <p className="text-xs text-sand" role="status">{gpsNote}</p> : null}
          {sounderNote ? <p className="text-xs text-sand" role="status">{sounderNote}</p> : null}
          {error ? <p className="text-xs text-sand" role="alert">{error}</p> : null}
        </div>
      </footer>
      <div className="absolute right-2 bottom-2 z-[1200] flex flex-col items-end gap-1">
        {alarmOpen ? (
          <div className="mb-1 max-h-[min(24rem,55dvh)] w-72 overflow-auto rounded-lg border border-alert-border bg-alert-bg/95 p-2 text-xs shadow-lg">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="font-semibold text-alert-fg">Alarm history</p>
              <button
                type="button"
                onClick={() => setAlarms([])}
                className="h-7 rounded-md border border-alert-border px-2 font-medium text-alert-fg"
              >
                Clear
              </button>
            </div>
            {alarms.length === 0 ? (
              <p className="text-muted">No alarms yet.</p>
            ) : (
              <ul>
                {alarms.map((item) => (
                  <li key={item.id} className="border-b border-line/70 py-1">
                    <p className="text-[10px] text-muted" dir="ltr">
                      {item.at}
                    </p>
                    <p>{item.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => setAlarmOpen((open) => !open)}
          aria-expanded={alarmOpen}
          aria-label="Alarm history"
          className={`grid h-14 w-14 place-items-center rounded-md border-2 border-alert-border text-[11px] font-bold tracking-wide ${anchorOut && !anchorAck ? "alarm-live bg-alert-strong text-alert-strong-fg" : "bg-alert-bg text-alert-fg"}`}
        >
          ALARM
        </button>
      </div>
      {booting ? <StartupSplash onDone={dismissSplash} /> : null}
    </div>
  );
}

function GyroCompass({
  visible,
  heading,
  windDirection,
  windSpeed,
  windLocation,
  weatherLoading,
  onHide,
}: {
  visible: boolean;
  heading: number | null;
  windDirection: number | null;
  windSpeed: number | null;
  windLocation: string;
  weatherLoading: boolean;
  onHide: () => void;
}) {
  const [position, setPosition] = useState({ x: 300, y: 12 });
  const panelRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startLeft: number;
    startTop: number;
  } | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    const bounds = panel?.parentElement;
    if (!panel || !bounds) return;
    const constrain = () => {
      const maxLeft = Math.max(0, bounds.clientWidth - panel.offsetWidth);
      const maxTop = Math.max(0, bounds.clientHeight - panel.offsetHeight);
      setPosition((current) => ({ x: Math.min(current.x, maxLeft), y: Math.min(current.y, maxTop) }));
    };
    const observer = new ResizeObserver(constrain);
    observer.observe(bounds);
    observer.observe(panel);
    window.addEventListener("resize", constrain);
    constrain();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", constrain);
    };
  }, []);

  return (
    <section
      ref={panelRef}
      id="gyro-compass-window"
      aria-label="Gyro compass and wind direction"
      aria-hidden={!visible}
      className={`absolute z-[1100] ${visible ? "flex" : "hidden"} w-56 flex-col rounded-xl border border-line bg-surface/95 shadow-xl backdrop-blur`}
      style={{ left: position.x, top: position.y }}
    >
      <div
        className="flex h-8 touch-none cursor-move select-none items-center gap-1.5 rounded-t-xl border-b border-line px-2"
        title="Drag to move the compass"
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: position.x,
            startTop: position.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          const panel = panelRef.current;
          const bounds = panel?.parentElement;
          if (!drag || drag.pointerId !== event.pointerId || !panel || !bounds) return;
          const maxLeft = Math.max(0, bounds.clientWidth - panel.offsetWidth);
          const maxTop = Math.max(0, bounds.clientHeight - panel.offsetHeight);
          setPosition({
            x: Math.max(0, Math.min(maxLeft, drag.startLeft + event.clientX - drag.startX)),
            y: Math.max(0, Math.min(maxTop, drag.startTop + event.clientY - drag.startY)),
          });
        }}
        onPointerUp={() => { dragRef.current = null; }}
        onPointerCancel={() => { dragRef.current = null; }}
      >
        <Move className="size-3 text-muted" aria-hidden="true" />
        <span className="flex-1 text-[11px] font-semibold">Gyro & wind</span>
        <button type="button" onClick={onHide} aria-label="Hide gyro compass" className="grid size-6 place-items-center rounded text-muted hover:bg-surface-2 hover:text-fg">
          <X className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="p-2">
        <div className="relative mx-auto size-44 rounded-full border border-line bg-bg shadow-inner" aria-label="Compass rose, north up">
          <svg viewBox="0 0 200 200" className="absolute inset-0 size-full" role="img" aria-label={`Compass north up${windDirection == null ? "" : `; wind from ${compassDirection(windDirection)}`}`}>
            <circle cx="100" cy="100" r="94" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1" />
            {Array.from({ length: 72 }, (_, index) => {
              const major = index % 3 === 0;
              return <line key={index} x1="100" y1="6" x2="100" y2={major ? "18" : "11"} transform={`rotate(${index * 5} 100 100)`} stroke={major ? "currentColor" : "currentColor"} strokeOpacity={major ? "0.65" : "0.3"} strokeWidth={major ? "1.5" : "1"} />;
            })}
            <text x="100" y="31" textAnchor="middle" className="fill-accent text-[14px] font-bold">N</text>
            <text x="169" y="104" textAnchor="middle" className="fill-muted text-[12px] font-semibold">E</text>
            <text x="100" y="178" textAnchor="middle" className="fill-muted text-[12px] font-semibold">S</text>
            <text x="31" y="104" textAnchor="middle" className="fill-muted text-[12px] font-semibold">W</text>
            {windDirection != null ? (
              <g transform={`rotate(${windDirection} 100 100)`}>
                <defs>
                  <marker id="gyro-wind-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                    <path d="M0 0 L8 4 L0 8 Z" fill="#f0b64f" />
                  </marker>
                </defs>
                <line x1="100" y1="25" x2="100" y2="71" stroke="#f0b64f" strokeWidth="3" markerEnd="url(#gyro-wind-arrow)" />
                <circle cx="100" cy="23" r="3.5" fill="#f0b64f" stroke="#07141c" strokeWidth="1.5" />
              </g>
            ) : null}
          </svg>
          <svg viewBox="0 0 200 200" className="absolute inset-0 size-full" aria-hidden="true">
            <g transform={`rotate(${heading ?? 0} 100 100)`} opacity={heading == null ? 0.5 : 1}>
              <path d="M100 69 L111 96 L108 125 Q100 133 92 125 L89 96 Z" fill="#f0b64f" stroke="#173746" strokeWidth="3" strokeLinejoin="round" />
              <path d="M100 78 V101" stroke="#173746" strokeWidth="2.5" strokeLinecap="round" />
              <rect x="95" y="103" width="10" height="12" rx="1" fill="#087f83" />
            </g>
            <circle cx="100" cy="100" r="3" fill="#087f83" stroke="#eaf2f5" strokeWidth="1.5" />
          </svg>
        </div>
        <p className="mt-1 text-center text-[10px] font-semibold" dir="ltr">{heading == null ? "HDG / COG · —" : `HDG / COG · ${formatCourse(heading)}°`}</p>
        <p className="mt-0.5 truncate text-center text-[10px] text-muted" title="Wind direction from the selected weather location." dir="ltr">
          {windDirection == null
            ? weatherLoading ? "Wind · loading…" : "Wind direction unavailable"
            : `Weather · from ${compassDirection(windDirection)} · ${weatherValue(windSpeed, "kn")}`}
        </p>
        <p className="truncate text-center text-[9px] text-muted" dir="ltr">{windLocation}</p>
      </div>
    </section>
  );
}

function weatherValue(value: number | null, unit = "", digits = 1): string {
  if (value == null) return "—";
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ""}`;
}

function weatherLocalTime(value: string): string {
  return value ? value.replace("T", " ") : "—";
}

function WeatherMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2 px-2 py-1.5">
      <dt className="truncate text-[10px] text-muted">{label}</dt>
      <dd className="truncate text-xs font-semibold text-fg" title={value}>{value}</dd>
      {detail ? <dd className="truncate text-[10px] text-muted" title={detail}>{detail}</dd> : null}
    </div>
  );
}

function EtaCard({
  ship,
  dest,
  sogKn,
}: {
  ship: Hit;
  dest: { lat: number; lng: number };
  sogKn: number | null;
}) {
  const eta = etaQuote(ship.lat, ship.lng, dest.lat, dest.lng, sogKn);
  const course = formatCourse(eta.bearing);
  return (
    <div className="rounded-xl border border-line bg-bg px-3 py-2">
      <p className="text-xs text-muted">ETA — rhumb-line distance at the set SOG</p>
      <p className="text-sm" dir="ltr">
        {eta.nm.toFixed(2)} NM · {course}°
      </p>
      {eta.reason === "there" ? (
        <p className="text-sm text-sand">Own ship is already at the point.</p>
      ) : eta.reason === "ok" && eta.minutes != null ? (
        <p className="text-sm text-sand">
          {formatMinutes(eta.minutes)}
          {eta.arrival ? ` — about ${eta.arrival}` : ""}
          {sogKn != null ? ` · ${sogKn.toFixed(1)} kn` : ""}
        </p>
      ) : eta.reason === "stopped" ? (
        <p className="text-sm text-sand">Set SOG is nearly zero and the ship is stopped. No ETA.</p>
      ) : (
        <p className="text-sm text-sand">No SOG from the set. Connect the JRC to compute the time.</p>
      )}
    </div>
  );
}

function Instrument({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="min-w-0 bg-surface px-2 py-1">
      <p className="text-[10px] leading-none text-muted">{label}</p>
      <p className="truncate text-lg font-semibold leading-tight tracking-tight text-sand" dir="ltr">
        {value}
        {unit ? <span className="ms-1 text-xs font-medium text-fg">{unit}</span> : null}
      </p>
    </div>
  );
}

function daymarkTitle(mark: ChannelMark): string {
  const side = mark.kind === "port" ? "حمراء" : "خضراء";
  const ns = mark.lat < 0 ? "S" : "N";
  const ew = mark.lng < 0 ? "W" : "E";
  return `${mark.name} — عوامة ${side}<br>${Math.abs(mark.lat).toFixed(5)} ${ns}, ${Math.abs(mark.lng).toFixed(5)} ${ew}`;
}

function daymarkHtml(kind: ChannelMark["kind"], label: string): string {
  const shape =
    kind === "port"
      ? '<svg viewBox="0 0 20 26" width="20" height="26" aria-hidden="true"><line x1="10" y1="16" x2="10" y2="25" stroke="#e8eef2" stroke-width="1.4"/><rect x="4" y="5" width="12" height="11" rx="2" fill="#d23b35" stroke="#fff" stroke-width="1"/><circle cx="10" cy="5" r="3" fill="#d23b35" stroke="#fff" stroke-width="1"/></svg>'
      : '<svg viewBox="0 0 20 26" width="20" height="26" aria-hidden="true"><line x1="10" y1="16" x2="10" y2="25" stroke="#e8eef2" stroke-width="1.4"/><path d="M10 2 L17 15 H3 Z" fill="#1f9d4a" stroke="#fff" stroke-width="1" stroke-linejoin="round"/></svg>';
  return `<span class="daymark">${shape}<span class="daymark__tag">${esc(label)}</span></span>`;
}

function buildDaymark(THREE: typeof import("three"), kind: ChannelMark["kind"]) {
  const group = new THREE.Group();
  if (kind === "port") {
    const red = new THREE.MeshStandardMaterial({ color: 0xd23b35, roughness: 0.42 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 11, 12), red);
    body.position.y = 7;
    const top = new THREE.Mesh(new THREE.SphereGeometry(5.4, 14, 12), red);
    top.position.y = 14;
    group.add(body, top);
    return group;
  }
  if (kind === "starboard") {
    const green = new THREE.MeshStandardMaterial({ color: 0x1f9d4a, roughness: 0.42 });
    const cone = new THREE.Mesh(new THREE.ConeGeometry(6.5, 18, 12), green);
    cone.position.y = 10;
    group.add(cone);
    return group;
  }
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.6 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe2b340, roughness: 0.48 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.6, 32, 8), black);
  pole.position.y = 16;
  const board = new THREE.Mesh(new THREE.BoxGeometry(12, 9, 1.4), yellow);
  board.position.y = 34;
  const band = new THREE.Mesh(new THREE.BoxGeometry(12.4, 2.4, 1.6), black);
  band.position.y = 34;
  group.add(pole, board, band);
  return group;
}

function paintOverlay(survey: Survey): HTMLCanvasElement {
  const scale = 3;
  const canvas = document.createElement("canvas");
  canvas.width = survey.nx * scale;
  canvas.height = survey.ny * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let j = 0; j < survey.ny; j++) {
    for (let i = 0; i < survey.nx; i++) {
      const depth = survey.depths[j * survey.nx + i];
      if (depth == null) continue;
      const [r, g, b] = depthRgb(depth);
      const row = survey.ny - 1 - j;
      for (let py = 0; py < scale; py++) {
        for (let px = 0; px < scale; px++) {
          const p = ((row * scale + py) * canvas.width + i * scale + px) * 4;
          image.data[p] = r;
          image.data[p + 1] = g;
          image.data[p + 2] = b;
          image.data[p + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function buildDredger(THREE: typeof import("three")) {
  const ship = new THREE.Group();
  const grey = new THREE.MeshStandardMaterial({ color: 0x8a939c, roughness: 0.55, metalness: 0.18 });
  const white = new THREE.MeshStandardMaterial({ color: 0xf3f6f7, roughness: 0.42, metalness: 0.08 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xd2e04a, roughness: 0.4, metalness: 0.08 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5, metalness: 0.2 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xe36a1c, roughness: 0.45, metalness: 0.15 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x8eb4c4, roughness: 0.2, metalness: 0.3 });
  const deck = new THREE.MeshStandardMaterial({ color: 0xb7c0c4, roughness: 0.7, metalness: 0.05 });

  const hull = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.42, 5.5), grey);
  hull.position.set(0, 0.08, 0.2);
  const bow = new THREE.Mesh(new THREE.ConeGeometry(0.78, 1.35, 4), grey);
  bow.rotation.x = -Math.PI / 2;
  bow.rotation.y = Math.PI / 4;
  bow.position.set(0, 0.1, -2.85);
  const deckPlate = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.05, 4.3), deck);
  deckPlate.position.set(0, 0.31, 0.45);
  ship.add(hull, bow, deckPlate);

  const hopper = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 2.2), new THREE.MeshStandardMaterial({ color: 0x6d767e, roughness: 0.8 }));
  hopper.position.set(0, 0.36, -0.35);
  ship.add(hopper);

  for (const side of [-0.78, 0.78]) {
    const davit = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.08), orange);
    davit.position.set(side, 0.55, -0.2);
    davit.rotation.z = side > 0 ? -0.5 : 0.5;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.8, 8), black);
    pipe.rotation.x = Math.PI / 2;
    pipe.rotation.z = side > 0 ? 0.35 : -0.35;
    pipe.position.set(side * 0.95, 0.05, 0.15);
    ship.add(davit, pipe);
  }

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.55, 1.25), white);
  cabin.position.set(0, 0.62, 1.85);
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(1.28, 0.38, 0.85), white);
  bridge.position.set(0, 1.05, 1.7);
  const windows = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.12, 0.04), glass);
  windows.position.set(0, 1.08, 1.26);
  const stack = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.85, 0.42), yellow);
  stack.position.set(0, 1.15, 2.25);
  const vent = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.55, 0.06), black);
  vent.position.set(0, 1.22, 2.04);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), white);
  mast.position.set(0, 1.85, 1.7);
  ship.add(cabin, bridge, windows, stack, vent, mast);
  return ship;
}

function buildBed(THREE: typeof import("three"), survey: Survey, scene: THREE.Scene) {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const indexOf: number[] = new Array(survey.nx * survey.ny).fill(-1);

  for (let j = 0; j < survey.ny; j++) {
    for (let i = 0; i < survey.nx; i++) {
      const depth = survey.depths[j * survey.nx + i];
      if (depth == null) continue;
      const id = positions.length / 3;
      indexOf[j * survey.nx + i] = id;
      const x = survey.x0 + i * survey.dx;
      const y = survey.y0 + j * survey.dy;
      positions.push(x, depth, -y);
      const [r, g, b] = depthRgb(depth);
      colors.push(r / 255, g / 255, b / 255);
    }
  }

  for (let j = 0; j < survey.ny - 1; j++) {
    for (let i = 0; i < survey.nx - 1; i++) {
      const a = indexOf[j * survey.nx + i];
      const b = indexOf[j * survey.nx + i + 1];
      const c = indexOf[(j + 1) * survey.nx + i];
      const d = indexOf[(j + 1) * survey.nx + i + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const bed = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
  );
  scene.add(bed);
  return bed;
}
