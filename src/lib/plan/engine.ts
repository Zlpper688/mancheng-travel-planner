import { cached } from "../cache";
import {
  DAY_COLORS,
  PACES,
  STYLE_LABELS,
} from "../constants";
import { addDaysISO, formatDateRange } from "../geo";
import { crowdFactor, getHoliday } from "../holidays";
import { getProvider } from "../providers";
import type { DiscoverOptions, DiscoverResult } from "../providers/types";
import { cityShortName } from "../providers/normalize";
import type {
  DayPlan,
  PlanMeta,
  PlanResult,
  TripInput,
} from "../types";
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
    fixedPlaces: input.fixedPlaces,
    farDays: input.farDays,
  });

  const warnings: string[] = [];
  const usedMealIds = new Set<string>();
  const days: DayPlan[] = [];

  for (const seedDay of selection.days) {
    const result = await scheduleDay({
      seedDay,
      hotel: input.hotel,
      meals: discovered.meals,
      city: input.city,
      date: addDaysISO(input.date, seedDay.index - 1),
      pace: input.pace,
      styles: input.styles,
      transport: input.transport,
      crowd,
      color: DAY_COLORS[(seedDay.index - 1) % DAY_COLORS.length],
      seed: input.seed,
      dayIndex: seedDay.index,
      provider,
      usedMealIds,
    });
    days.push(result.plan);
    warnings.push(...result.warnings);
  }

  warnings.push(...selection.warnings);
  if (holiday) warnings.unshift(holiday.tip);
  if (discovered.isDemo) {
    warnings.push("当前为免 Key 演示模式：厦门点位真实，公交耗时为估算。");
  }

  const budget = buildBudget(days, input, holiday?.hotelFactor ?? 1);
  const meta = buildMeta(input, discovered, days, selection.farDays);
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
  };
}
