import { cached } from "../cache";
import {
  DAY_COLORS,
  PACES,
  STYLE_LABELS,
} from "../constants";
import { addDaysISO, formatDateRange, placeDistance } from "../geo";
import { crowdFactor, getHoliday } from "../holidays";
import { getProvider } from "../providers";
import type { DiscoverOptions, DiscoverResult } from "../providers/types";
import { cityShortName } from "../providers/normalize";
import {
  fetchTripWeather,
  pickDayWeather,
  summarizeRainWindows,
  weatherTip,
  type WeatherCore,
} from "../weather";
import type {
  DayPlan,
  PlanMeta,
  PlanResult,
  Place,
  TripInput,
} from "../types";
import { selectTips } from "../tips/engine";
import { buildBudget } from "./budget";
import { scheduleDay } from "./schedule";
import { selectDays } from "./select";

export function discoverRadius(input: TripInput): number {
  let radius = 8 + input.days * 3;
  const styles = new Set(input.styles);
  if (input.transport === "drive") radius += 5;
  if (input.pace === "packed") radius += 2;
  if (styles.has("citywalk")) radius -= 3;
  if (styles.has("coastal")) radius += 3;
  if (styles.has("family")) radius -= 1;
  return Math.max(6, Math.min(30, radius));
}

export function discoverReach(input: TripInput): number {
  const near = discoverRadius(input);
  if (input.farDays === 0) return near;
  return Math.min(50, Math.max(near, near + 18));
}

export async function discoverForTrip(input: TripInput): Promise<DiscoverResult> {
  const provider = getProvider();
  const center: [number, number] =
    input.center ?? [input.hotel.lng, input.hotel.lat];
  const radiusKm = discoverReach(input);
  const options: DiscoverOptions = {
    city: input.city,
    center,
    hotel: input.hotel,
    radiusKm,
    days: input.days,
    styles: input.styles,
  };
  const key = [
    "discover",
    provider.source,
    input.city,
    center[0].toFixed(3),
    center[1].toFixed(3),
    input.hotel.lng.toFixed(3),
    input.hotel.lat.toFixed(3),
    radiusKm,
    input.days,
    input.styles.join(","),
    input.farDays ?? "auto",
  ].join(":");
  return cached(key, 10 * 60 * 1000, () => provider.discover(options));
}

function buildMeta(
  input: TripInput,
  discovered: DiscoverResult,
  days: DayPlan[],
  farDays: number,
  weatherKind?: "forecast" | "climate" | "mixed",
): PlanMeta {
  const holiday = getHoliday(input.date);
  const isFixed = Boolean(input.fixedPlaces?.length);
  const travelers = Math.max(1, input.adults + input.children);
  const styleTitle = isFixed
    ? "攻略复刻"
    : input.styles
        .slice(0, 2)
        .map((style) => STYLE_LABELS[style])
        .join(" × ");
  const city = cityShortName(input.city);
  const dataNotes = [...discovered.notes];
  if (discovered.source === "open") {
    dataNotes.push("步行与驾车为真实路径，公交耗时为估算；配置高德 Key 后可精确到线路与班次。");
  }
  if (discovered.source === "demo") {
    dataNotes.push("步行与驾车为真实路径，公交耗时为估算；配置高德 Key 后可精确到线路与班次。");
  }
  if (isFixed) {
    dataNotes.push("导入攻略的日期按攻略站点顺序规划，其余日期由漫城自动排线。");
  }
  if (farDays > 0) {
    dataNotes.push(
      farDays === 1
        ? "其中 1 天安排给较远但出名的景点，集中走一个方向，其余天在酒店附近慢逛。"
        : `其中 ${farDays} 天留给较远但出名的景点，集中在同一方向，减少来回折腾。`,
    );
  }
  if (weatherKind) {
    dataNotes.push(
      weatherKind === "forecast"
        ? "天气与日照来自 Open-Meteo 预报，出发前再核对一次。"
        : weatherKind === "climate"
          ? "行程日期超出天气预报范围，天气按去年同期气候估算，出发前一周再看预报。"
          : "部分日期超出天气预报范围，已用去年同期气候补全，出发前一周再看预报。",
    );
  }
  dataNotes.push("预算为带区间的估算，房价与门票以预订页和现场为准。");

  return {
    city,
    title: `${city} · ${input.days} 日${styleTitle}`,
    subtitle: `${formatDateRange(input.date, input.days)} · ${travelers} 人 · ${PACES[input.pace].label}节奏`,
    startDate: input.date,
    endDate: addDaysISO(input.date, Math.max(0, input.days - 1)),
    days: input.days,
    travelers,
    source: discovered.source,
    sourceNote: discovered.sourceNote,
    dataNotes: Array.from(new Set(dataNotes)),
    holiday: holiday ?? undefined,
    isFixed,
    generatedAt: new Date().toISOString(),
  };
}

function pickRainBackup(
  sights: Place[],
  planned: Set<string>,
  anchor: Place,
): Place | null {
  let best: Place | null = null;
  let bestScore = -Infinity;
  for (const place of sights) {
    if (place.category !== "museum" || planned.has(place.id)) continue;
    const km = placeDistance(anchor, place);
    if (km > 6) continue;
    const score = (place.popularity ?? place.rating ?? 3) - km * 0.2;
    if (score > bestScore) {
      best = place;
      bestScore = score;
    }
  }
  return best;
}

export async function planTrip(input: TripInput): Promise<PlanResult> {
  const provider = getProvider();
  const discovered = await discoverForTrip(input);
  const radiusKm = discoverRadius(input);
  const holiday = getHoliday(input.date);
  const crowd = crowdFactor(input.date);

  const selection = selectDays({
    sights: discovered.sights,
    hotel: input.hotel,
    days: input.days,
    pace: input.pace,
    styles: input.styles,
    seed: input.seed,
    radiusKm,
    transport: input.transport,
    city: input.city,
    fixedPlaces: input.fixedPlaces,
    farDays: input.farDays,
  });

  const warnings: string[] = [];
  const usedMealIds = new Set<string>();
  const days: DayPlan[] = [];
  const usedPlaceIds = new Set(
    selection.days.flatMap((seedDay) =>
      seedDay.places.map((place) => place.id),
    ),
  );

  const weather = await fetchTripWeather(
    selection.days.map((seedDay) => {
      const anchor =
        seedDay.places.find((place) => place.category !== "hotel") ?? input.hotel;
      return { lat: anchor.lat, lng: anchor.lng };
    }),
    input.date,
    input.days,
  );
  const weatherByDay = new Map<number, WeatherCore | null>();

  for (const seedDay of selection.days) {
    const date = addDaysISO(input.date, seedDay.index - 1);
    const anchor =
      seedDay.places.find((place) => place.category !== "hotel") ?? input.hotel;
    const core = weather
      ? pickDayWeather(weather, anchor.lat, anchor.lng, date)
      : null;
    weatherByDay.set(seedDay.index, core);
    const result = await scheduleDay({
      seedDay,
      hotel: input.hotel,
      meals: discovered.meals,
      city: input.city,
      date,
      pace: input.pace,
      styles: input.styles,
      transport: input.transport,
      crowd,
      color: DAY_COLORS[(seedDay.index - 1) % DAY_COLORS.length],
      seed: input.seed,
      dayIndex: seedDay.index,
      provider,
      usedMealIds,
      weather: core,
      spares: discovered.sights.filter(
        (place) => !usedPlaceIds.has(place.id),
      ),
    });
    days.push(result.plan);
    for (const stop of result.plan.stops) {
      usedPlaceIds.add(stop.place.id);
    }
    warnings.push(
      ...result.warnings.map((warning) =>
        /^第\s*\d+\s*天/.test(warning)
          ? warning
          : `第 ${seedDay.index} 天：${warning}`,
      ),
    );
  }

  warnings.push(...selection.warnings);

  if (weather) {
    const planned = new Set(
      days.flatMap((day) => day.stops.map((stop) => stop.place.id)),
    );
    for (const day of days) {
      const core = weatherByDay.get(day.index);
      if (!core) continue;
      const anchor =
        day.stops.find((stop) => stop.kind === "sight")?.place ?? input.hotel;
      const windows = summarizeRainWindows(core);
      const wet =
        (core.precipProb ?? 0) >= 50 ||
        (core.precipMm ?? 0) >= 2 ||
        windows.some((window) => window.mm >= 1);
      const backup = wet
        ? pickRainBackup(discovered.sights, planned, anchor)
        : null;
      const lastSightEndMin = [...day.stops]
        .reverse()
        .find((stop) => stop.kind === "sight")?.endMin;
      day.weather = {
        code: core.code,
        label: core.label,
        icon: core.icon,
        tMax: core.tMax,
        tMin: core.tMin,
        precipProb: core.precipProb,
        precipMm: core.precipMm,
        windKmh: core.windKmh,
        sunrise: core.sunrise,
        sunset: core.sunset,
        estimated: core.estimated,
        source: core.source,
        tip: weatherTip(core, lastSightEndMin),
        backup: backup ? { placeId: backup.id, name: backup.name } : undefined,
        hourly: core.hourly,
        rainWindows: windows.length ? windows : undefined,
      };
      const severe =
        !core.estimated &&
        (core.code >= 95 ||
          core.code === 65 ||
          core.code === 82 ||
          (core.precipProb ?? 0) >= 85 ||
          core.tMax >= 37 ||
          core.tMin <= -10);
      if (severe) {
        const reason =
          core.code >= 95
            ? "有雷雨"
            : core.code === 65 || core.code === 82
              ? "有大雨"
              : (core.precipProb ?? 0) >= 85
                ? "降雨概率很高"
                : core.tMax >= 37
                  ? "高温"
                  : "严寒";
        warnings.push(
          `第 ${day.index} 天${day.far ? "是远足日，" : ""}${reason}，出发前确认天气，必要时换室内点位。`,
        );
      }
    }
  }

  if (holiday) warnings.unshift(holiday.tip);
  if (discovered.isDemo) {
    warnings.push("当前为免 Key 演示模式：厦门点位真实，公交耗时为估算。");
  }

  const tips = selectTips(input, days);
  for (const day of days) {
    const dayTips = tips.dayTips.get(day.index);
    if (dayTips?.length) day.tips = dayTips;
  }

  const budget = buildBudget(days, input, holiday?.hotelFactor ?? 1);
  const meta = buildMeta(input, discovered, days, selection.farDays, weather?.kind);
  const seen = new Set<string>();

  return {
    meta,
    days,
    budget,
    warnings: warnings.filter((warning) => {
      if (!warning || seen.has(warning)) return false;
      seen.add(warning);
      return true;
    }).slice(0, 10),
    tips: tips.tripTips.length ? tips.tripTips : undefined,
  };
}
