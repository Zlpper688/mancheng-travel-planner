import { cached, fetchJson, mapLimit } from "./cache";
import { addDaysISO, todayISOLocal } from "./geo";
import type { HourlyPoint, RainWindow, WeatherIcon } from "./types";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST_FIELDS =
  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset";
const ARCHIVE_FIELDS =
  "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,sunrise,sunset";
const FORECAST_HOURLY = "precipitation,precipitation_probability,temperature_2m";
const ARCHIVE_HOURLY = "precipitation,temperature_2m";
const TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_POINTS = 6;
const CHUNK_SIZE = 3;
const FORECAST_HORIZON_DAYS = 15;
const RAIN_MM = 0.2;
const RAIN_PROB = 50;

export interface WeatherPoint {
  lat: number;
  lng: number;
}

export interface WeatherCore {
  date: string;
  code: number;
  label: string;
  icon: WeatherIcon;
  tMax: number;
  tMin: number;
  precipProb?: number;
  precipMm?: number;
  windKmh?: number;
  sunrise?: string;
  sunset?: string;
  estimated: boolean;
  source: "open-meteo" | "open-meteo-archive";
  hourly?: HourlyPoint[];
}

export interface WeatherBundle {
  kind: "forecast" | "climate" | "mixed";
  points: WeatherPoint[];
  days: Map<string, WeatherCore>;
}

interface OpenMeteoDaily {
  time: string[];
  weather_code?: (number | null)[];
  temperature_2m_max?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  precipitation_probability_max?: (number | null)[];
  precipitation_sum?: (number | null)[];
  wind_speed_10m_max?: (number | null)[];
  sunrise?: (string | null)[];
  sunset?: (string | null)[];
}

interface OpenMeteoHourly {
  time: string[];
  precipitation?: (number | null)[];
  precipitation_probability?: (number | null)[];
  temperature_2m?: (number | null)[];
}

interface OpenMeteoResult {
  location_id?: number;
  daily?: OpenMeteoDaily;
  hourly?: OpenMeteoHourly;
}

interface WeatherMeta {
  label: string;
  icon: WeatherIcon;
}

const WEATHER_CODES: Record<number, WeatherMeta> = {
  0: { label: "晴", icon: "sun" },
  1: { label: "晴间多云", icon: "cloud-sun" },
  2: { label: "多云", icon: "cloud-sun" },
  3: { label: "阴", icon: "cloud" },
  45: { label: "有雾", icon: "fog" },
  48: { label: "雾凇", icon: "fog" },
  51: { label: "毛毛雨", icon: "rain" },
  53: { label: "毛毛雨", icon: "rain" },
  55: { label: "细雨", icon: "rain" },
  56: { label: "冻雨", icon: "rain" },
  57: { label: "冻雨", icon: "rain" },
  61: { label: "小雨", icon: "rain" },
  63: { label: "中雨", icon: "rain" },
  65: { label: "大雨", icon: "rain" },
  66: { label: "冻雨", icon: "rain" },
  67: { label: "冻雨", icon: "rain" },
  71: { label: "小雪", icon: "snow" },
  73: { label: "中雪", icon: "snow" },
  75: { label: "大雪", icon: "snow" },
  77: { label: "雪粒", icon: "snow" },
  80: { label: "阵雨", icon: "rain" },
  81: { label: "阵雨", icon: "rain" },
  82: { label: "强阵雨", icon: "rain" },
  85: { label: "阵雪", icon: "snow" },
  86: { label: "阵雪", icon: "snow" },
  95: { label: "雷阵雨", icon: "storm" },
  96: { label: "雷暴冰雹", icon: "storm" },
  99: { label: "雷暴冰雹", icon: "storm" },
};

export function describeWeather(code: number): WeatherMeta {
  return WEATHER_CODES[code] ?? { label: "多云", icon: "cloud" };
}

function pointKey(lat: number, lng: number): string {
  return `${lat.toFixed(2)}:${lng.toFixed(2)}`;
}

function dayKey(point: WeatherPoint, date: string): string {
  return `${pointKey(point.lat, point.lng)}:${date}`;
}

function shiftYear(date: string, delta: number): string {
  const year = Number(date.slice(0, 4));
  if (!Number.isFinite(year)) return date;
  return `${year + delta}${date.slice(4)}`;
}

function readNumber(
  values: (number | null)[] | undefined,
  index: number,
): number | undefined {
  const value = values?.[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readClock(values: (string | null)[] | undefined, index: number): string | undefined {
  const value = values?.[index];
  if (typeof value !== "string") return undefined;
  const match = value.match(/T(\d{2}:\d{2})/);
  return match?.[1];
}

function buildCore(
  daily: OpenMeteoDaily,
  index: number,
  date: string,
  estimated: boolean,
  hourly?: HourlyPoint[],
): WeatherCore | null {
  const code = readNumber(daily.weather_code, index);
  const tMax = readNumber(daily.temperature_2m_max, index);
  const tMin = readNumber(daily.temperature_2m_min, index);
  if (code === undefined || tMax === undefined || tMin === undefined) return null;
  const meta = describeWeather(code);
  return {
    date,
    code,
    label: meta.label,
    icon: meta.icon,
    tMax: Math.round(tMax * 10) / 10,
    tMin: Math.round(tMin * 10) / 10,
    precipProb: readNumber(daily.precipitation_probability_max, index),
    precipMm: readNumber(daily.precipitation_sum, index),
    windKmh: readNumber(daily.wind_speed_10m_max, index),
    sunrise: readClock(daily.sunrise, index),
    sunset: readClock(daily.sunset, index),
    estimated,
    source: estimated ? "open-meteo-archive" : "open-meteo",
    hourly: hourly?.length ? hourly : undefined,
  };
}

function buildHourlyProfile(
  hourly: OpenMeteoHourly | undefined,
): Map<string, HourlyPoint[]> {
  const profile = new Map<string, HourlyPoint[]>();
  if (!hourly?.time?.length) return profile;
  hourly.time.forEach((stamp, index) => {
    const date = stamp.slice(0, 10);
    const hour = Number(stamp.slice(11, 13));
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
    const mm = readNumber(hourly.precipitation, index);
    const prob = readNumber(hourly.precipitation_probability, index);
    const temp = readNumber(hourly.temperature_2m, index);
    if (mm === undefined && prob === undefined && temp === undefined) return;
    const list = profile.get(date) ?? [];
    list.push({
      hour,
      mm: Math.round((mm ?? 0) * 10) / 10,
      prob: prob === undefined ? undefined : Math.round(prob),
      temp: temp === undefined ? undefined : Math.round(temp * 10) / 10,
    });
    profile.set(date, list);
  });
  profile.forEach((list) => list.sort((a, b) => a.hour - b.hour));
  return profile;
}

function roughDistanceKm(a: WeatherPoint, b: WeatherPoint): number {
  const dLat = a.lat - b.lat;
  const dLng = (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng) * 111;
}

function dedupePoints(points: WeatherPoint[]): WeatherPoint[] {
  const unique: WeatherPoint[] = [];
  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
    if (unique.some((item) => roughDistanceKm(item, point) <= 4)) continue;
    unique.push(point);
    if (unique.length >= MAX_POINTS) break;
  }
  return unique;
}

async function queryOpenMeteo(
  base: string,
  fields: string,
  hourlyFields: string,
  points: WeatherPoint[],
  startDate: string,
  endDate: string,
): Promise<OpenMeteoResult[]> {
  const params = new URLSearchParams({
    latitude: points.map((point) => point.lat.toFixed(3)).join(","),
    longitude: points.map((point) => point.lng.toFixed(3)).join(","),
    daily: fields,
    timezone: "auto",
    start_date: startDate,
    end_date: endDate,
  });
  if (hourlyFields) params.set("hourly", hourlyFields);
  const data = await fetchJson<OpenMeteoResult | OpenMeteoResult[]>(
    `${base}?${params.toString()}`,
    {},
    TIMEOUT_MS,
  );
  const list = Array.isArray(data) ? data : [data];
  return list.filter((result) => (result.daily?.time?.length ?? 0) > 0);
}

function ingest(
  results: OpenMeteoResult[],
  points: WeatherPoint[],
  acceptedDates: Set<string>,
  target: Map<string, WeatherCore>,
  estimated: boolean,
): void {
  results.forEach((result, fallbackIndex) => {
    const point = points[result.location_id ?? fallbackIndex] ?? points[fallbackIndex];
    if (!point || !result.daily) return;
    const profile = buildHourlyProfile(result.hourly);
    result.daily.time.forEach((rawDate, index) => {
      const date = estimated ? shiftYear(rawDate, 1) : rawDate;
      if (!acceptedDates.has(date)) return;
      const key = dayKey(point, date);
      if (target.has(key)) return;
      const core = buildCore(
        result.daily as OpenMeteoDaily,
        index,
        date,
        estimated,
        profile.get(rawDate),
      );
      if (core) target.set(key, core);
    });
  });
}

async function queryChunks(
  base: string,
  fields: string,
  hourlyFields: string,
  points: WeatherPoint[],
  startDate: string,
  endDate: string,
  acceptedDates: Set<string>,
  target: Map<string, WeatherCore>,
  estimated: boolean,
): Promise<void> {
  const chunks: WeatherPoint[][] = [];
  for (let index = 0; index < points.length; index += CHUNK_SIZE) {
    chunks.push(points.slice(index, index + CHUNK_SIZE));
  }
  await mapLimit(chunks, 2, async (chunk) => {
    try {
      const results = await queryOpenMeteo(
        base,
        fields,
        hourlyFields,
        chunk,
        startDate,
        endDate,
      );
      ingest(results, chunk, acceptedDates, target, estimated);
    } catch {
      // 单个分片失败不影响其他分片
    }
  });
}

async function loadWeather(
  points: WeatherPoint[],
  startDate: string,
  days: number,
): Promise<WeatherBundle> {
  const dates = Array.from({ length: days }, (_, index) => addDaysISO(startDate, index));
  const acceptedDates = new Set(dates);
  const endDate = dates[dates.length - 1];
  const collected = new Map<string, WeatherCore>();

  const today = todayISOLocal();
  const horizon = addDaysISO(today, FORECAST_HORIZON_DAYS);
  const forecastStart = startDate < today ? today : startDate;
  const forecastEnd = endDate > horizon ? horizon : endDate;

  if (forecastStart <= forecastEnd) {
    await queryChunks(
      FORECAST_URL,
      FORECAST_FIELDS,
      FORECAST_HOURLY,
      points,
      forecastStart,
      forecastEnd,
      acceptedDates,
      collected,
      false,
    );
  }

  const missing = points.some((point) =>
    dates.some((date) => !collected.has(dayKey(point, date))),
  );

  if (missing) {
    await queryChunks(
      ARCHIVE_URL,
      ARCHIVE_FIELDS,
      ARCHIVE_HOURLY,
      points,
      shiftYear(startDate, -1),
      shiftYear(endDate, -1),
      acceptedDates,
      collected,
      true,
    );
  }

  if (!collected.size) throw new Error("天气数据暂不可用");

  const forecastCount = Array.from(collected.values()).filter(
    (core) => !core.estimated,
  ).length;
  const climateCount = collected.size - forecastCount;
  const kind: WeatherBundle["kind"] =
    forecastCount && climateCount ? "mixed" : climateCount ? "climate" : "forecast";
  return { kind, points, days: collected };
}

export async function fetchTripWeather(
  points: WeatherPoint[],
  startDate: string,
  days: number,
): Promise<WeatherBundle | null> {
  const unique = dedupePoints(points);
  if (!unique.length || days < 1) return null;
  const key = [
    "weather-v4",
    startDate,
    days,
    unique.map((point) => pointKey(point.lat, point.lng)).join("|"),
  ].join(":");
  try {
    return await cached(key, CACHE_TTL_MS, () => loadWeather(unique, startDate, days));
  } catch {
    return null;
  }
}

export function pickDayWeather(
  bundle: WeatherBundle,
  lat: number,
  lng: number,
  date: string,
): WeatherCore | null {
  let nearest: WeatherPoint | null = null;
  let nearestKm = Infinity;
  for (const point of bundle.points) {
    const km = roughDistanceKm(point, { lat, lng });
    if (km < nearestKm) {
      nearest = point;
      nearestKm = km;
    }
  }
  if (!nearest) return null;
  return bundle.days.get(dayKey(nearest, date)) ?? null;
}

export interface RainLoad {
  mm: number;
  peakProb: number;
  wetHours: number;
}

export function rainLoad(
  weather: { hourly?: HourlyPoint[] } | null | undefined,
  startMin: number,
  endMin: number,
): RainLoad {
  if (!weather?.hourly?.length || endMin <= startMin) {
    return { mm: 0, peakProb: 0, wetHours: 0 };
  }
  let mm = 0;
  let peakProb = 0;
  let wetHours = 0;
  const first = Math.max(0, Math.floor(startMin / 60));
  const last = Math.min(23, Math.ceil(endMin / 60) - 1);
  for (let hour = first; hour <= last; hour++) {
    const entry = weather.hourly.find((item) => item.hour === hour);
    if (!entry) continue;
    const overlap =
      Math.min(endMin, (hour + 1) * 60) - Math.max(startMin, hour * 60);
    const share = Math.min(1, Math.max(0, overlap / 60));
    mm += entry.mm * share;
    peakProb = Math.max(peakProb, entry.prob ?? 0);
    if (share >= 0.5 && (entry.mm >= RAIN_MM || (entry.prob ?? 0) >= RAIN_PROB)) {
      wetHours++;
    }
  }
  return { mm: Math.round(mm * 10) / 10, peakProb, wetHours };
}

export interface TemperatureRange {
  peak: number;
  low: number;
}

export function temperatureRange(
  weather: { hourly?: HourlyPoint[] } | null | undefined,
  startMin: number,
  endMin: number,
): TemperatureRange | null {
  if (!weather?.hourly?.length || endMin <= startMin) return null;
  const samples: number[] = [];
  const first = Math.max(0, Math.floor(startMin / 60));
  const last = Math.min(23, Math.ceil(endMin / 60) - 1);
  for (let hour = first; hour <= last; hour++) {
    const entry = weather.hourly.find((item) => item.hour === hour);
    if (entry?.temp !== undefined) samples.push(entry.temp);
  }
  if (!samples.length) return null;
  return {
    peak: Math.round(Math.max(...samples) * 10) / 10,
    low: Math.round(Math.min(...samples) * 10) / 10,
  };
}

export function summarizeRainWindows(
  weather: { hourly?: HourlyPoint[] } | null | undefined,
): RainWindow[] {
  if (!weather?.hourly?.length) return [];
  const windows: RainWindow[] = [];
  for (const entry of [...weather.hourly].sort((a, b) => a.hour - b.hour)) {
    if (entry.mm < RAIN_MM) continue;
    const last = windows[windows.length - 1];
    if (last && last.endMin >= entry.hour * 60) {
      last.endMin = (entry.hour + 1) * 60;
      last.mm = Math.round((last.mm + entry.mm) * 10) / 10;
      last.peakProb = Math.max(last.peakProb, entry.prob ?? 0);
    } else {
      windows.push({
        startMin: entry.hour * 60,
        endMin: (entry.hour + 1) * 60,
        mm: entry.mm,
        peakProb: entry.prob ?? 0,
      });
    }
  }
  return windows;
}

function parseClock(value: string | undefined): number | null {
  if (!value) return null;
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

export function weatherTip(
  core: WeatherCore,
  lastSightEndMin?: number,
): string | undefined {
  const weatherTips: string[] = [];
  const storm = core.code >= 95;
  const snow = (core.code >= 71 && core.code <= 77) || (core.code >= 85 && core.code <= 86);
  const prob = core.precipProb ?? 0;
  const rainMm = core.precipMm ?? 0;

  if (storm) {
    weatherTips.push("有雷雨，尽量避开高处和空旷地，行程可以顺延。");
  } else if (snow) {
    weatherTips.push("有雪，鞋底注意防滑，路上多留时间。");
  } else if (prob >= 70 || rainMm >= 8) {
    weatherTips.push(
      core.estimated
        ? "雨量不小，带把伞更稳妥。"
        : `降水概率 ${Math.round(prob)}%，带伞，户外点位尽量避开雨段。`,
    );
  } else if (prob >= 40 || rainMm >= 2) {
    weatherTips.push(
      core.estimated
        ? "有零星降雨，包里放把折叠伞。"
        : `可能有阵雨（${Math.round(prob)}%），包里放把折叠伞。`,
    );
  }

  if (core.tMax >= 34) {
    weatherTips.push(
      `最高 ${Math.round(core.tMax)}°，午后最晒，户外点位尽量放上午和傍晚。`,
    );
  } else if (core.tMax <= 4) {
    weatherTips.push(`最高只有 ${Math.round(core.tMax)}°，穿厚外套，注意保暖。`);
  }
  if (core.tMin <= 0) {
    weatherTips.push(`最低 ${Math.round(core.tMin)}°，保暖同时留意路面结冰。`);
  }
  if ((core.windKmh ?? 0) >= 40) {
    weatherTips.push(`阵风约 ${Math.round(core.windKmh ?? 0)} km/h，帽子围巾固定好。`);
  }

  const parts: string[] = [];
  if (weatherTips.length) {
    parts.push(`${core.estimated ? "按去年同期气候，" : ""}${weatherTips.slice(0, 2).join("")}`);
  }
  const sunset = parseClock(core.sunset);
  if (
    sunset !== null &&
    lastSightEndMin !== undefined &&
    lastSightEndMin > sunset
  ) {
    parts.push(`日落 ${core.sunset}，最后一个户外点位结束时已天黑，返程注意安全。`);
  }
  return parts.length ? parts.join(" ") : undefined;
}