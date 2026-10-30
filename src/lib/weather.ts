const WEATHER_CURRENT = [
  "temperature_2m",
  "relative_humidity_2m",
  "dew_point_2m",
  "apparent_temperature",
  "is_day",
  "precipitation",
  "rain",
  "showers",
  "snowfall",
  "weather_code",
  "cloud_cover",
  "cloud_cover_low",
  "cloud_cover_mid",
  "cloud_cover_high",
  "pressure_msl",
  "surface_pressure",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "visibility",
  "uv_index",
] as const;

const MARINE_CURRENT = [
  "wave_height",
  "wave_direction",
  "wave_period",
  "wave_peak_period",
  "wind_wave_height",
  "wind_wave_direction",
  "wind_wave_period",
  "wind_wave_peak_period",
  "swell_wave_height",
  "swell_wave_direction",
  "swell_wave_period",
  "swell_wave_peak_period",
  "secondary_swell_wave_height",
  "secondary_swell_wave_direction",
  "secondary_swell_wave_period",
  "tertiary_swell_wave_height",
  "tertiary_swell_wave_direction",
  "tertiary_swell_wave_period",
  "sea_surface_temperature",
  "ocean_current_velocity",
  "ocean_current_direction",
  "sea_level_height_msl",
] as const;

export type WeatherHour = {
  time: string;
  temperature: number | null;
  apparentTemperature: number | null;
  precipitationProbability: number | null;
  precipitation: number | null;
  weatherCode: number | null;
  windSpeed: number | null;
  windGusts: number | null;
};

export type WeatherSnapshot = {
  latitude: number;
  longitude: number;
  timezone: string;
  currentTime: string;
  current: Record<string, number | null>;
  currentUnits: Record<string, string>;
  hours: WeatherHour[];
  marine: {
    latitude: number;
    longitude: number;
    timezone: string;
    currentTime: string;
    current: Record<string, number | null>;
    currentUnits: Record<string, string>;
  } | null;
  marineUnavailable: boolean;
  fetchedAt: string;
};

type ApiResponse = {
  error?: boolean | string;
  reason?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;
  current?: Record<string, unknown>;
  current_units?: Record<string, string>;
  hourly?: Record<string, unknown>;
  hourly_units?: Record<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberRecord(record: Record<string, unknown>): Record<string, number | null> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, asNumber(value)]));
}

function arrayAt(record: Record<string, unknown>, key: string, index: number): unknown {
  const values = record[key];
  return Array.isArray(values) ? values[index] : null;
}

function coordinates(data: ApiResponse, fallback: { lat: number; lng: number }) {
  return {
    latitude: asNumber(data.latitude) ?? fallback.lat,
    longitude: asNumber(data.longitude) ?? fallback.lng,
    timezone: typeof data.timezone === "string" ? data.timezone : "auto",
    currentTime: typeof data.current?.time === "string" ? data.current.time : "",
    current: numberRecord(asRecord(data.current)),
    currentUnits: data.current_units ?? {},
  };
}

function failureMessage(data: ApiResponse, status: number): string {
  if (typeof data.reason === "string" && data.reason.trim()) return data.reason.trim();
  if (typeof data.error === "string" && data.error.trim() && data.error !== "true") return data.error.trim();
  return `Weather service error (${status}).`;
}

async function fetchApi(url: URL, signal: AbortSignal): Promise<ApiResponse> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  let data: ApiResponse;
  try {
    data = (await response.json()) as ApiResponse;
  } catch {
    throw new Error("The weather service returned an unreadable response.");
  }
  if (!response.ok || data.error) {
    throw new Error(failureMessage(data, response.status));
  }
  return data;
}

export async function getCurrentWeather(
  lat: number,
  lng: number,
  signal: AbortSignal,
): Promise<WeatherSnapshot> {
  const forecast = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lng),
    timezone: "auto",
  });
  const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
  const weatherParams = new URLSearchParams(forecast);
  weatherParams.set("current", WEATHER_CURRENT.join(","));
  weatherParams.set("hourly", "temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m");
  weatherParams.set("forecast_hours", "7");
  weatherParams.set("wind_speed_unit", "kn");
  weatherUrl.search = weatherParams.toString();

  const marineUrl = new URL("https://marine-api.open-meteo.com/v1/marine");
  const marineParams = new URLSearchParams(forecast);
  marineParams.set("cell_selection", "sea");
  marineParams.set("current", MARINE_CURRENT.join(","));
  marineUrl.search = marineParams.toString();

  const [weather, marineResult] = await Promise.allSettled([
    fetchApi(weatherUrl, signal),
    fetchApi(marineUrl, signal),
  ]);
  if (weather.status === "rejected") throw weather.reason;

  const weatherData = weather.value;
  const current = coordinates(weatherData, { lat, lng });
  const hourly = asRecord(weatherData.hourly);
  const times = Array.isArray(hourly.time) ? hourly.time : [];
  const hours: WeatherHour[] = times.slice(0, 7).flatMap((time, index) => {
    if (typeof time !== "string") return [];
    return [{
      time,
      temperature: asNumber(arrayAt(hourly, "temperature_2m", index)),
      apparentTemperature: asNumber(arrayAt(hourly, "apparent_temperature", index)),
      precipitationProbability: asNumber(arrayAt(hourly, "precipitation_probability", index)),
      precipitation: asNumber(arrayAt(hourly, "precipitation", index)),
      weatherCode: asNumber(arrayAt(hourly, "weather_code", index)),
      windSpeed: asNumber(arrayAt(hourly, "wind_speed_10m", index)),
      windGusts: asNumber(arrayAt(hourly, "wind_gusts_10m", index)),
    }];
  });

  const marineData = marineResult.status === "fulfilled" ? marineResult.value : null;
  const marine = marineData ? coordinates(marineData, { lat, lng }) : null;

  return {
    latitude: current.latitude,
    longitude: current.longitude,
    timezone: current.timezone,
    currentTime: current.currentTime,
    current: current.current,
    currentUnits: current.currentUnits,
    hours,
    marine: marine
      ? {
          latitude: marine.latitude,
          longitude: marine.longitude,
          timezone: marine.timezone,
          currentTime: marine.currentTime,
          current: marine.current,
          currentUnits: marine.currentUnits,
        }
      : null,
    marineUnavailable: marineData === null,
    fetchedAt: new Date().toISOString(),
  };
}

export function describeWeatherCode(code: number | null): string {
  if (code == null) return "Condition unavailable";
  if (code === 0) return "Clear sky";
  if (code <= 3) return code === 1 ? "Mainly clear" : code === 2 ? "Partly cloudy" : "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snowfall";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code === 95) return "Thunderstorm";
  if (code === 96 || code === 99) return "Thunderstorm with hail";
  return "Condition unavailable";
}

export function compassDirection(degrees: number | null): string {
  if (degrees == null) return "—";
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return `${directions[Math.round(((degrees % 360) + 360) % 360 / 45) % 8]} ${Math.round(degrees)}°`;
}
