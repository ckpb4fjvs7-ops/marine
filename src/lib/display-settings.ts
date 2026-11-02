export const DISPLAY_SETTINGS_KEY = "marine360-display-settings-v1";

export type DisplaySettings = {
  shipSize: number;
  trackColor: string;
  trackWidth: number;
  trackOpacity: number;
  trackPoints: number;
  trackVisible: boolean;
  courseVisible: boolean;
  speedVectorVisible: boolean;
  courseMinutes: number;
  depthOpacity: number;
};

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
  shipSize: 1,
  trackColor: "#bd641d",
  trackWidth: 3,
  trackOpacity: 0.92,
  trackPoints: 8000,
  trackVisible: true,
  courseVisible: true,
  speedVectorVisible: true,
  courseMinutes: 6,
  depthOpacity: 1,
};

/** Validate saved preferences before they reach Leaflet, CSS or the 3D renderer. */
export function normalizeDisplaySettings(value: unknown): DisplaySettings {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const number = (key: keyof DisplaySettings, min: number, max: number) => {
    const candidate = saved[key];
    return typeof candidate === "number" && Number.isFinite(candidate)
      ? Math.min(max, Math.max(min, candidate)) : DEFAULT_DISPLAY_SETTINGS[key] as number;
  };
  const boolean = (key: "trackVisible" | "courseVisible" | "speedVectorVisible") => typeof saved[key] === "boolean" ? saved[key] : DEFAULT_DISPLAY_SETTINGS[key];
  return {
    shipSize: number("shipSize", 0.25, 4),
    trackColor: typeof saved.trackColor === "string" && /^#[0-9a-f]{6}$/i.test(saved.trackColor) ? saved.trackColor.toLowerCase() : DEFAULT_DISPLAY_SETTINGS.trackColor,
    trackWidth: number("trackWidth", 1, 8),
    trackOpacity: number("trackOpacity", 0.2, 1),
    trackPoints: typeof saved.trackPoints === "number" && [500, 2000, 4000, 8000].includes(saved.trackPoints) ? saved.trackPoints : DEFAULT_DISPLAY_SETTINGS.trackPoints,
    trackVisible: boolean("trackVisible"),
    courseVisible: boolean("courseVisible"),
    speedVectorVisible: boolean("speedVectorVisible"),
    courseMinutes: typeof saved.courseMinutes === "number" && [1, 3, 6, 12].includes(saved.courseMinutes) ? saved.courseMinutes : DEFAULT_DISPLAY_SETTINGS.courseMinutes,
    depthOpacity: number("depthOpacity", 0.2, 1),
  };
}

export function parseDisplaySettings(source: string | null): DisplaySettings {
  try { return normalizeDisplaySettings(source ? JSON.parse(source) : null); }
  catch { return { ...DEFAULT_DISPLAY_SETTINGS }; }
}
