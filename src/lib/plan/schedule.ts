import { CATEGORY_DWELL, PACES, getTaxiRate } from "../constants";
import { mapLimit } from "../cache";
import {
  estimateModeMinutes,
  estimateRouteDistanceKm,
  estimateTaxiFare,
  estimateTransitFare,
  minutesToTime,
  placeDistance,
  roundToFive,
  seededJitter,
  straightLine,
} from "../geo";
import type { PlaceProvider, RawRoute } from "../providers/types";
import { metroLabel, usableMetroTrip } from "../transit/metro";
import type { MetroTrip } from "../transit/types";
import { LATEST_START } from "./limits";
import { lateReturnLimits, PAID_SIGHT_WARNING_LIMIT } from "./policy";
import type {
  Category,
  DayPlan,
  DayStats,
  PaceId,
  Place,
  RouteAlternative,
  RouteLeg,
  StopKind,
  StopPlan,
  StyleId,
  TransportMode,
  TransportPref,
} from "../types";
import { rainLoad, temperatureRange, type WeatherCore } from "../weather";
import { crowdDwellFactor, crowdNote, crowdOf } from "./crowd";
import {
  applyEnergy,
  energyDwellScale,
  energyNote,
  initialEnergy,
  summarizeEnergy,
  timeDrain,
} from "./energy";
import {
  describeDay,
  rhythmDwell,
  rhythmOf,
  type DayNarrative,
} from "./rhythm";
import { restBufferOf, type TripVector } from "./prefs";
import type { DaySeed } from "./select";

type MealSlot = "lunch" | "dinner" | "cafe";

interface StopSeed {
  place: Place;
  kind: StopKind;
  fixed: boolean;
  slot?: MealSlot;
  flexible?: boolean;
}

interface BuildContext {
  hotel: Place;
  city: string;
  date: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  crowd: number;
  color: string;
  seed: number;
  dayIndex: number;
  provider: PlaceProvider;
  meals: Place[];
  far: boolean;
  family: boolean;
  heroId?: string;
  startMin: number;
  weather: WeatherCore | null;
  rainDelayNote?: string;
  /**
   * 出门时的体力（0–100）。由 energy.ts 按出发时刻/第几天/同行人算，
   * 排线时用它决定「这一站还能不能按原时长走完」。
   */
  energyStart: number;
  /**
   * 连续偏好向量（可选）。目前只用来把 restFreq 换算成「每站之后多留几分钟」：
   * 说了「走一会要歇」，站间缓冲就该宽一点。其余维度在选点层已经消化。
   */
  prefs?: TripVector;
}

export interface ScheduleInput
  extends Omit<
    BuildContext,
    "far" | "startMin" | "weather" | "rainDelayNote" | "energyStart"
  > {
  seedDay: DaySeed;
  usedMealIds: Set<string>;
  weather?: WeatherCore | null;
  spares?: Place[];
}

export interface ScheduleResult {
  plan: DayPlan;
  warnings: string[];
}

interface BuiltDay {
  stops: StopPlan[];
  legs: RouteLeg[];
  startMin: number;
  endMin: number;
  stats: DayStats;
  warnings: string[];
  tip: string;
  narrative: DayNarrative;
  energy: { start: number; end: number; low: number; lowPlaceId?: string };
}

const MODES: TransportMode[] = ["walk", "transit", "taxi"];
const LUNCH_START = 11 * 60;
const DINNER_START = 17 * 60;
const HEAT_NOTE_C = 33;
const HEAT_TRIM_C = 35;
const CHILL_NOTE_C = 5;
const OUTDOOR_CATEGORIES = new Set<Category>([
  "attraction",
  "park",
  "viewpoint",
  "beach",
  "street",
  "temple",
  "market",
  "nature",
]);

function kindOf(place: Place): StopKind {
  if (place.category === "food") return "meal";
  if (place.category === "cafe") return "cafe";
  return "sight";
}

export function metroFare(rideKm: number): number {
  return Math.min(7, 2 + Math.ceil(Math.max(0, rideKm - 4) / 4));
}

export function metroSummary(trip: MetroTrip): string {
  const transfer =
    trip.transfers > 0 ? ` · 换乘 ${trip.transfers} 次` : "";
  return `${metroLabel(trip.lines)}${transfer} · ${trip.fromStation} → ${trip.toStation} · 两头步行约 ${trip.walkMin} 分`;
}

function affordableMetro(
  from: Place,
  to: Place,
  pref: TransportPref,
  city: string,
  styles: StyleId[],
): MetroTrip | null {
  if (pref === "drive") return null;
  const trip = usableMetroTrip(from, to, city);
  if (!trip) return null;
  const km = placeDistance(from, to);
  const taxiMin = estimateModeMinutes(from, to, "taxi") + 2;
  const family = styles.includes("family");
  const tolerance = km >= 8 ? 12 : family ? 6 : 5;
  return trip.minutes <= taxiMin + tolerance ? trip : null;
}

export function pickTransportMode(
  from: Place,
  to: Place,
  pref: TransportPref,
  styles: StyleId[],
  city = "",
): TransportMode {
  const crossing =
    Boolean(from.island || to.island) && from.island !== to.island;
  if (crossing) return "transit";
  const km = placeDistance(from, to);
  const citywalk = styles.includes("citywalk");
  const family = styles.includes("family");
  const metro = city ? affordableMetro(from, to, pref, city, styles) : null;
  if (pref === "walk") {
    if (km <= 2.4 || (citywalk && km <= 3.2)) return "walk";
    if (metro && km > 8) return "transit";
    if (km <= 12) return "transit";
    return "taxi";
  }
  if (pref === "transit") {
    if (km <= 0.9) return "walk";
    if (km <= 18) return "transit";
    return metro ? "transit" : "taxi";
  }
  if (pref === "drive") {
    if (km <= 0.9) return "walk";
    return "taxi";
  }
  if (km <= 1.2) return "walk";
  if (km <= 2.2 && (citywalk || family)) return "walk";
  if (metro) return "transit";
  if (km <= 8 || (family && km <= 12)) return "transit";
  return "taxi";
}

function adjustDuration(
  durationMin: number,
  mode: TransportMode,
  crowd: number,
): number {
  const factor =
    mode === "walk" ? 1 + (crowd - 1) * 0.12 : 1 + (crowd - 1) * 0.5;
  return Math.max(1, Math.round(durationMin * factor));
}

function dwellFor(
  place: Place,
  kind: StopKind,
  pace: PaceId,
  styles: StyleId[],
  crowd: number,
  city: string,
): number {
  if (kind === "meal") return roundToFive(Math.max(55, 60 * PACES[pace].dwellScale));
  if (kind === "cafe") return roundToFive(35 * PACES[pace].dwellScale);
  return rhythmDwell(place, city, pace, styles, crowd);
}

function parseOpenWindows(value?: string): { start: number; end: number }[] {
  if (!value) return [];
  const windows: { start: number; end: number }[] = [];
  const regex = /(\d{1,2})[:：](\d{2})\s*[-–—~至]\s*(\d{1,2})[:：](\d{2})/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value))) {
    const start = Number(match[1]) * 60 + Number(match[2]);
    let end = Number(match[3]) * 60 + Number(match[4]);
    if (end <= start) end += 24 * 60;
    windows.push({ start, end });
  }
  return windows;
}

function planRainStart(
  weather: WeatherCore | null,
  baseStart: number,
  fixed: boolean,
): { startMin: number; note?: string } {
  if (!weather?.hourly?.length || fixed || weather.estimated) {
    return { startMin: baseStart };
  }
  const morning = rainLoad(weather, baseStart, baseStart + 120);
  // 1mm 是毛毛雨，不值得把出发推到 11 点——原来只要 0.8mm 就触发，
  // 一版「充实」行程会因为一场小雨直接从上午十一点开始。
  const wetMorning =
    morning.mm >= 2.5 || (morning.peakProb >= 70 && morning.mm >= 1.2);
  if (!wetMorning) return { startMin: baseStart };

  for (let minute = baseStart + 30; minute <= 13 * 60; minute += 15) {
    if (minute - baseStart > 60) break;
    const load = rainLoad(weather, minute, minute + 120);
    const drier =
      load.mm <= 0.2 && load.peakProb <= Math.max(35, morning.peakProb - 20);
    if (drier) {
      return {
        startMin: minute,
        note: `早上下雨，等雨小一点再出门，出发推迟到 ${minutesToTime(minute)}。`,
      };
    }
  }
  return { startMin: baseStart };
}

interface WeatherAdvice {
  dwell: number;
  notes: string[];
  heavy: boolean;
  mm: number;
  peakProb: number;
  fixed: boolean;
  heatPeak?: number;
}

function weatherAdviceFor(
  stop: StopSeed,
  weather: WeatherCore | null,
  startMin: number,
  dwell: number,
): WeatherAdvice {
  const base: WeatherAdvice = {
    dwell,
    notes: [],
    heavy: false,
    mm: 0,
    peakProb: 0,
    fixed: stop.fixed,
  };
  if (!weather?.hourly?.length) return base;

  const load = rainLoad(weather, startMin, startMin + dwell);
  const uncertain = weather.estimated;
  if (stop.kind !== "sight") {
    return {
      ...base,
      notes:
        load.mm >= 0.2 || load.peakProb >= 50
          ? [
              uncertain
                ? "按去年同期气候，这段可能下雨，正好在室内歇一会儿"
                : "正赶上下雨，可以在这里多避一会儿",
            ]
          : [],
      mm: load.mm,
      peakProb: load.peakProb,
    };
  }
  if (!OUTDOOR_CATEGORIES.has(stop.place.category)) {
    return { ...base, mm: load.mm, peakProb: load.peakProb };
  }

  const heavy = load.mm >= 2 || (load.peakProb >= 80 && load.mm >= 0.5);
  const wet = load.mm >= 0.7 || (load.peakProb >= 65 && load.mm >= 0.2);
  let nextDwell = dwell;
  if (wet && !uncertain && !stop.fixed && dwell > 40) {
    nextDwell = Math.max(30, roundToFive(dwell - (heavy ? 20 : 10)));
  }

  const wetHours = weather.hourly
    .filter((entry) => {
      const overlap =
        Math.min(startMin + nextDwell, entry.hour * 60 + 60) -
        Math.max(startMin, entry.hour * 60);
      return (
        overlap >= 20 && (entry.mm >= 0.2 || (entry.prob ?? 0) >= 55)
      );
    })
    .map((entry) => entry.hour)
    .sort((a, b) => a - b);

  const notes: string[] = [];
  if (wetHours.length) {
    const contiguous =
      wetHours[wetHours.length - 1] - wetHours[0] === wetHours.length - 1;
    if (contiguous) {
      const label = `${minutesToTime(wetHours[0] * 60)}–${minutesToTime(
        (wetHours[wetHours.length - 1] + 1) * 60,
      )}`;
      notes.push(
        uncertain
          ? `按去年同期气候，雨段 ${label}，带把折叠伞`
          : load.mm >= 0.5
            ? `雨段 ${label}，带伞`
            : `雨段 ${label}，可能有雨，带把折叠伞`,
      );
    } else {
      notes.push(
        uncertain
          ? "按去年同期气候，途中可能有雨，带把折叠伞"
          : load.mm >= 0.5
            ? "途中有雨，带伞"
            : "途中可能有雨，带把折叠伞",
      );
    }
  }

  const temperature = temperatureRange(weather, startMin, startMin + nextDwell);
  let heatPeak: number | undefined;
  if (temperature) {
    heatPeak = temperature.peak;
    const hot = Math.round(temperature.peak);
    const cold = Math.round(temperature.low);
    if (temperature.peak >= HEAT_TRIM_C) {
      if (!uncertain && !stop.fixed && nextDwell === dwell && dwell > 40) {
        nextDwell = Math.max(30, roundToFive(dwell - 10));
        notes.push(`约 ${hot}°C 高温，已缩短户外停留，注意补水`);
      } else {
        notes.push(
          uncertain
            ? `按去年同期气候，约 ${hot}°C，注意防晒补水`
            : `约 ${hot}°C 高温，注意防晒补水`,
        );
      }
    } else if (temperature.peak >= HEAT_NOTE_C) {
      notes.push(
        uncertain
          ? `按去年同期气候，约 ${hot}°C，走树荫、勤补水`
          : `约 ${hot}°C，走树荫、勤补水`,
      );
    } else if (temperature.low <= CHILL_NOTE_C) {
      notes.push(
        uncertain
          ? `按去年同期气候，约 ${cold}°C，注意保暖`
          : `约 ${cold}°C，注意保暖`,
      );
    }
  }

  return {
    dwell: nextDwell,
    notes,
    heavy,
    mm: load.mm,
    peakProb: load.peakProb,
    fixed: stop.fixed,
    heatPeak,
  };
}

// 日落、亮灯和下午才开门的点位不硬塞到上午：宁可先在附近吃饭、喝咖啡，
// 到合适的时间再开始，行程才像人写的攻略。
function rhythmWaitFor(
  place: Place,
  kind: StopKind,
  arriveMin: number,
  city: string,
  weather: WeatherCore | null | undefined,
): { wait: number; note?: string } {
  if (kind !== "sight") return { wait: 0 };
  const profile = rhythmOf(city, place);
  if (!profile.windows.length) return { wait: 0 };
  let target: number | null = null;
  if (profile.nightStreet) {
    target = 17 * 60 + 30;
  } else if (profile.sunset) {
    const sunsetMin = clockMinute(weather?.sunset);
    target = sunsetMin !== null
      ? Math.max(16 * 60, sunsetMin - 30)
      : 16 * 60 + 20;
  } else if (profile.windows.every(([start]) => start >= 14 * 60)) {
    target = Math.min(...profile.windows.map(([start]) => start));
  }
  if (target === null || arriveMin >= target - 10) return { wait: 0 };
  const gap = target - arriveMin;
  // “15 点后更热闹”只是建议，不是闸门；空等超过两小时不如先逛起来。
  const cap = profile.nightStreet || profile.sunset ? 7 * 60 + 30 : 2 * 60;
  if (gap > cap) return { wait: 0 };
  const wait = roundToFive(gap);
  const at = minutesToTime(target);
  const longRest = wait >= 180;
  const note = profile.nightStreet
    ? longRest
      ? `亮灯还早，建议先回住处歇一会儿，${at} 再出来逛`
      : `亮灯还早，先在附近把晚饭吃了，${at} 再逛`
    : profile.sunset
      ? longRest
        ? `离日落还早，建议先回住处休息或找家店坐一会儿，${at} 去机位`
        : `离日落还早，先在附近慢慢逛或坐一会儿，${at} 去机位`
      : target >= 17 * 60
              ? `这个点晚些才热闹，先在附近逛逛、吃个晚饭，${at} 再过来`
              : target >= 16 * 60
                ? `还没到最舒服的时候，先在附近喝杯咖啡、坐一会儿，${at} 再逛`
                : arriveMin < 13 * 60 + 30
                  ? `还没到最舒服的时候，先在附近吃午饭、歇一会儿，${at} 再逛`
                  : `还没到最舒服的时候，先在附近喝杯咖啡、逛逛小店，${at} 再逛`;
  return { wait, note };
}

function roughTimeline(
  places: Place[],
  hotel: Place,
  startMin: number,
  pace: PaceId,
  transport: TransportPref,
  styles: StyleId[],
  crowd: number,
  city: string,
  weather?: WeatherCore | null,
): { arrive: number; rawArrive: number; end: number }[] {
  let clock = startMin;
  let previous = hotel;
  const result: { arrive: number; rawArrive: number; end: number }[] = [];
  for (const place of places) {
    const mode = pickTransportMode(previous, place, transport, styles, city);
    const travel = adjustDuration(
      estimateModeMinutes(previous, place, mode),
      mode,
      crowd,
    );
    const roughArrive = clock + travel;
    const wait = rhythmWaitFor(place, "sight", roughArrive, city, weather).wait;
    const arrive = roughArrive + wait;
    const dwell = dwellFor(place, "sight", pace, styles, crowd, city);
    result.push({ arrive, rawArrive: roughArrive, end: arrive + dwell });
    clock = arrive + dwell + PACES[pace].bufferMin;
    previous = place;
  }
  return result;
}

function midpointTarget(
  sights: StopSeed[],
  index: number,
  hotel: Place,
): Place {
  const previous = index > 0 ? sights[index - 1]?.place : hotel;
  const next = sights[index]?.place ?? previous;
  if (!previous || !next) return hotel;
  const sameIsland = previous.island && previous.island === next.island;
  return {
    ...previous,
    id: `target-${index}`,
    name: `${previous.name}附近`,
    lat: (previous.lat + next.lat) / 2,
    lng: (previous.lng + next.lng) / 2,
    island: sameIsland ? previous.island : undefined,
  };
}

function mealScore(
  place: Place,
  target: Place,
  styles: StyleId[],
  kind: StopKind,
  slot?: "lunch" | "dinner",
): number {
  const distance = placeDistance(place, target);
  let score = (place.popularity ?? 3.4) * 1.2 - distance * 1.7;
  const tags = `${(place.tags ?? []).join(" ")} ${place.name}`;
  if (/cluster|小吃|排档|老字号/.test(tags)) score += 0.45;
  if (/local|本地/.test(tags)) score += 0.3;
  // 花生汤配油条是早饭，别把它排成晚饭。
  if (kind === "meal" && /breakfast|早餐|早点/.test(tags)) {
    if (slot === "dinner") score -= 2.4;
    if (slot === "lunch") score -= 0.6;
  }
  if (styles.includes("foodie")) score += 0.8;
  if (kind === "cafe" && place.category !== "cafe") score -= 4;
  if (kind !== "cafe" && place.category === "cafe") score -= 3;
  if (place.island && target.island !== place.island) score -= 3;
  if (!place.island && target.island) score -= 3;
  return score;
}

function sameSide(a: Place, b: Place): boolean {
  if (!a.island && !b.island) return true;
  return Boolean(a.island && b.island && a.island === b.island);
}

function chooseMeal(
  candidates: Place[],
  used: Set<string>,
  target: Place,
  kind: StopKind,
  styles: StyleId[],
  maxKm: number,
  slot?: "lunch" | "dinner",
): Place | null {
  const pool = candidates.filter(
    (place) =>
      !used.has(place.id) &&
      sameSide(place, target) &&
      (kind === "cafe" ? place.category === "cafe" : place.category === "food"),
  );
  const pick = (limit: number) => {
    let best: Place | null = null;
    let bestScore = -Infinity;
    for (const place of pool) {
      const distance = placeDistance(place, target);
      if (distance > limit) continue;
      const score = mealScore(place, target, styles, kind, slot);
      if (score > bestScore) {
        best = place;
        bestScore = score;
      }
    }
    return best;
  };
  return pick(maxKm) ?? pick(maxKm * 1.8);
}

// 吃饭先占时间，不把行程绑在某一家的排队上；找到靠谱餐馆也只作同片区的首选参考。
function flexibleMealPlace(
  slot: "lunch" | "dinner",
  anchor: Place,
  suggestion: Place | null,
  night: boolean,
  context: BuildContext,
): Place {
  const spot = suggestion?.name ?? anchor.name;
  const atHotel = anchor.id === context.hotel.id;
  const note =
    slot === "lunch"
      ? atHotel
        ? suggestion
          ? `这一段留给午饭：出发前可以看「${spot}」，吃完再走，不必按攻略打卡。`
          : "这一段留给午饭：出发前在酒店附近吃，吃完再走，不必按攻略打卡。"
        : suggestion
          ? `这一段留给午饭：可以先看「${spot}」，不合口味就在同片区另挑，不必按攻略打卡。`
          : `这一段留给午饭：在「${spot}」附近现场挑，先看人气和口味，不必按攻略打卡。`
      : night
        ? suggestion
          ? `这一段留给晚饭：先在「${spot}」一带吃，再逛夜市，别空着肚子排长队。`
          : `这一段留给晚饭：先在「${spot}」附近吃，再逛夜市，别空着肚子排长队。`
        : atHotel
          ? suggestion
            ? `这一段留给晚饭：回住处附近可以看「${spot}」，吃完直接休息，不必再折返。`
            : "这一段留给晚饭：回住处附近挑一家，吃完直接休息，不必再折返。"
          : suggestion
            ? `这一段留给晚饭：可以先看「${spot}」，吃完再回住处，不必为某家店绕路。`
            : `这一段留给晚饭：在「${spot}」附近挑一家，吃完再回住处，不必为某家店绕路。`;
  // 标题要说清「这顿在哪吃」，否则四个餐点都叫「午餐」，用户会以为没数据。
  // 仍然保留「不绑定某一家」的语义：店名只作首选参考，备注里写了可以同片区另挑。
  const slotLabel = slot === "lunch" ? "午饭" : "晚饭";
  const where = suggestion?.name ?? (atHotel ? "住处附近" : `${anchor.name}一带`);
  return {
    ...(suggestion ?? anchor),
    id: `flex-${slot}-${context.dayIndex}`,
    name: `${slotLabel} · ${where}`,
    // 占位用餐点跟着锚点坐标走，但类别必须是餐饮，不能继承酒店/景点类别。
    category: "food",
    note,
    cost: undefined,
    costNote: undefined,
    rating: undefined,
    openHours: undefined,
    tags: undefined,
  };
}

function insertMeals(
  sights: StopSeed[],
  options: { lunch: boolean; dinner: boolean; cafe: boolean },
  context: BuildContext,
  used: Set<string>,
): StopSeed[] {
  if (!sights.length) return sights;
  const rough = roughTimeline(
    sights.map((stop) => stop.place),
    context.hotel,
    context.startMin,
    context.pace,
    context.transport,
    context.styles,
    context.crowd,
    context.city,
    context.weather,
  );

  let lunchIndex = sights.length;
  if (options.lunch) {
    const found = rough.findIndex((item) => item.arrive >= LUNCH_START + 15);
    if (found >= 0) lunchIndex = found;
  }
  let cafeIndex = -1;
  if (options.cafe) {
    // 用“等到日落/亮灯之前”的到达时间选茶歇位置：
    // 下午本来就要等，正好把这段空档换成一次咖啡。
    const found = rough.findIndex(
      (item) => item.rawArrive >= 14 * 60 && item.rawArrive < 17 * 60 + 30,
    );
    if (found >= 0) {
      cafeIndex =
        lunchIndex < sights.length ? Math.max(found, lunchIndex + 1) : found;
      if (cafeIndex >= sights.length) cafeIndex = found;
    } else if (sights.length) {
      // 收尾是日落/夜市、而中间一路顺下来还不到下午茶时间：
      // 在收尾点前留一次茶歇，别把一下午都空着。
      const closing = rhythmOf(
        context.city,
        sights[sights.length - 1].place,
      );
      if (closing.nightStreet || closing.sunset) {
        cafeIndex = sights.length - 1;
      }
    }
  }

  const insertions: { index: number; order: number; seed: StopSeed }[] = [];
  const foodPlaces = context.meals.filter((place) => place.category === "food");
  const cafePlaces = context.meals.filter((place) => place.category === "cafe");
  const lastPlace = sights[sights.length - 1]?.place ?? context.hotel;
  const lastProfile = rhythmOf(context.city, lastPlace);
  const beforeNight = Boolean(lastProfile.nightStreet);

  // 夜市当天先定晚饭：晚饭就该落在夜市那片，
  // 不能因为午饭先挑走了附近的小吃街，晚上再折返几公里去吃饭。
  // 普通晚饭等真实排完景点再定（见 endOfDayDinner）：粗排会低估等待时间。
  if (beforeNight && options.dinner) {
    const suggestion = chooseMeal(
      foodPlaces,
      used,
      lastPlace,
      "meal",
      context.styles,
      5.2,
      "dinner",
    );
    if (suggestion) used.add(suggestion.id);
    insertions.push({
      index: Math.max(0, sights.length - 1),
      order: 2,
      seed: {
        place: flexibleMealPlace("dinner", lastPlace, suggestion, true, context),
        kind: "meal",
        fixed: false,
        slot: "dinner",
        flexible: true,
      },
    });
  }

  if (options.lunch) {
    const target = midpointTarget(sights, lunchIndex, context.hotel);
    // 夜市那片的小吃街留给晚饭，午饭选别的，避免晚上再跑一趟。
    const lunchPool = beforeNight
      ? foodPlaces.filter((place) => placeDistance(place, lastPlace) > 0.6)
      : foodPlaces;
    const suggestion = chooseMeal(
      lunchPool,
      used,
      target,
      "meal",
      context.styles,
      4.2,
      "lunch",
    );
    if (suggestion) used.add(suggestion.id);
    const anchor =
      lunchIndex > 0
        ? sights[lunchIndex - 1]?.place ?? context.hotel
        : context.hotel;
    insertions.push({
      index: lunchIndex,
      order: 0,
      seed: {
        place: flexibleMealPlace("lunch", anchor, suggestion, false, context),
        kind: "meal",
        fixed: false,
        slot: "lunch",
        flexible: true,
      },
    });
  }

  if (options.cafe && cafeIndex >= 0) {
    const target = midpointTarget(sights, cafeIndex, context.hotel);
    const cafe = chooseMeal(cafePlaces, used, target, "cafe", context.styles, 3.2);
    if (cafe) {
      used.add(cafe.id);
      insertions.push({
        index: cafeIndex,
        order: 1,
        seed: { place: cafe, kind: "cafe", fixed: false, slot: "cafe" },
      });
    }
  }

  const result: StopSeed[] = [];
  for (let index = 0; index <= sights.length; index++) {
    insertions
      .filter((item) => item.index === index)
      .sort((a, b) => a.order - b.order)
      .forEach((item) => result.push(item.seed));
    if (index < sights.length) result.push(sights[index]);
  }
  return result;
}

// 晚饭排完真实景点再定：白天拖到几点，粗排常常算不准。
function endOfDayDinner(
  stops: StopPlan[],
  ordered: StopSeed[],
  context: BuildContext,
  used: Set<string>,
): { seed: StopSeed; atHotel: boolean } | null {
  if (
    ordered.some(
      (stop) =>
        stop.kind === "meal" && (!stop.flexible || stop.slot === "dinner"),
    )
  ) {
    return null;
  }
  if (!stops.length) return null;
  const lastEnd = stops[stops.length - 1].endMin;
  if (lastEnd < 15 * 60 + 30) return null;
  // 收得早就在酒店附近吃；还早就先回住处，晚点再出门。
  const atHotel = lastEnd < 16 * 60;
  const anchor = atHotel ? context.hotel : stops[stops.length - 1].place;
  const foodPlaces = context.meals.filter((place) => place.category === "food");
  const suggestion = chooseMeal(
    foodPlaces,
    used,
    anchor,
    "meal",
    context.styles,
    5.2,
    "dinner",
  );
  if (suggestion) used.add(suggestion.id);
  return {
    seed: {
      place: flexibleMealPlace("dinner", anchor, suggestion, false, context),
      kind: "meal",
      fixed: false,
      slot: "dinner",
      flexible: true,
    },
    atHotel,
  };
}

function scheduleAppendedDinner(
  seed: StopSeed,
  arriveMin: number,
  order: number,
  atHotel: boolean,
  context: BuildContext,
): StopPlan {
  const wait = arriveMin < DINNER_START ? DINNER_START - arriveMin : 0;
  const startMin = Math.ceil((arriveMin + wait) / 5) * 5;
  const dwellMin = roundToFive(
    Math.max(55, 60 * PACES[context.pace].dwellScale),
  );
  const early =
    wait > 0
      ? atHotel
        ? "还没到饭点，先回住处歇一会儿"
        : "还没到饭点，先在附近逛逛"
      : undefined;
  return {
    id: `${context.dayIndex}-${order}-${seed.place.id}`,
    place: seed.place,
    kind: "meal",
    order,
    startMin,
    endMin: startMin + dwellMin,
    dwellMin,
    note: [seed.place.note, early].filter(Boolean).join(" · ") || undefined,
    slot: "dinner",
    flexible: true,
  };
}

function fallbackRoute(
  from: Place,
  to: Place,
  mode: TransportMode,
  city: string,
): RawRoute {
  const distanceKm = Math.max(
    0.05,
    estimateRouteDistanceKm([from.lng, from.lat], [to.lng, to.lat]),
  );
  return {
    mode,
    durationMin: estimateModeMinutes(from, to, mode) + (mode === "taxi" ? 2 : 0),
    distanceKm,
    cost:
      mode === "walk"
        ? 0
        : mode === "transit"
          ? estimateTransitFare(distanceKm)
          : estimateTaxiFare(distanceKm, getTaxiRate(city)),
    costUnit: mode === "taxi" ? "vehicle" : "person",
    estimated: true,
    geometry: straightLine([from.lng, from.lat], [to.lng, to.lat]),
    note: mode === "transit" ? "公交路线为估算" : "路线为估算",
  };
}

function metroRawRoute(
  from: Place,
  to: Place,
  city: string,
): RawRoute | null {
  const trip = usableMetroTrip(from, to, city);
  if (!trip) return null;
  const geometry: [number, number][] = [
    [from.lng, from.lat],
    ...trip.stations.map((station) => [station.lng, station.lat] as [number, number]),
    [to.lng, to.lat],
  ];
  return {
    mode: "transit",
    durationMin: trip.minutes,
    distanceKm: trip.rideKm + trip.walkKm,
    cost: metroFare(trip.rideKm),
    costUnit: "person",
    estimated: true,
    geometry,
    note: metroSummary(trip),
  };
}

async function safeRoute(
  provider: PlaceProvider,
  from: Place,
  to: Place,
  mode: TransportMode,
  city: string,
): Promise<RawRoute> {
  try {
    return await provider.route(from, to, mode, city);
  } catch {
    return fallbackRoute(from, to, mode, city);
  }
}

function makeLeg(
  index: number,
  from: Place,
  to: Place,
  mode: TransportMode,
  route: RawRoute,
  departMin: number,
  crowd: number,
  city: string,
): RouteLeg {
  const durationMin = adjustDuration(route.durationMin, mode, crowd);
  const crossing =
    Boolean(from.island || to.island) && from.island !== to.island;
  const alternatives: RouteAlternative[] = MODES.filter(
    (candidate) => candidate !== mode,
  ).map((candidate) => {
    const metro =
      candidate === "transit" ? usableMetroTrip(from, to, city) : null;
    const straightKm = Math.max(
      0.05,
      estimateRouteDistanceKm([from.lng, from.lat], [to.lng, to.lat]),
    );
    const distanceKm = metro ? metro.rideKm + metro.walkKm : straightKm;
    const estimatedMinutes = metro
      ? metro.minutes
      : estimateModeMinutes(from, to, candidate) + (candidate === "taxi" ? 2 : 0);
    return {
      mode: candidate,
      durationMin: adjustDuration(estimatedMinutes, candidate, crowd),
      distanceKm,
      cost:
        candidate === "walk"
          ? 0
          : metro
            ? metroFare(metro.rideKm)
            : candidate === "transit"
              ? estimateTransitFare(distanceKm)
              : estimateTaxiFare(distanceKm, getTaxiRate(city)),
      costUnit: candidate === "taxi" ? "vehicle" : "person",
      estimated: true,
      note: metro
        ? metroSummary(metro)
        : crossing
          ? candidate === "taxi"
            ? "跨海段需坐轮渡"
            : "含候船时间"
          : undefined,
    };
  });
  return {
    index,
    fromName: from.name,
    toName: to.name,
    from: [from.lng, from.lat],
    to: [to.lng, to.lat],
    mode,
    durationMin,
    distanceKm: Math.max(0.01, route.distanceKm),
    cost: route.cost,
    costUnit: route.costUnit,
    estimated: route.estimated,
    departMin,
    arriveMin: departMin + durationMin,
    geometry: route.geometry.length >= 2 ? route.geometry : straightLine([from.lng, from.lat], [to.lng, to.lat]),
    alternatives,
    note: route.note,
  };
}

async function buildOnce(
  sightStops: StopSeed[],
  context: BuildContext,
  used: Set<string>,
  opts?: { cafe?: boolean },
): Promise<BuiltDay> {
  const warnings: string[] = [];
  if (!sightStops.length) {
    return {
      stops: [],
      legs: [],
      startMin: context.startMin,
      endMin: context.startMin,
      stats: { stopCount: 0, sightCount: 0, distanceKm: 0, travelMin: 0, walkKm: 0, ticket: 0 },
      warnings: ["今天没有排到合适的点位，留作自由活动。"],
      tip: "今天是留白的一天，睡到自然醒，在酒店附近随意走走也很好。",
      narrative: {
        strategy: "今天留白，睡到自然醒，在酒店附近随意走走。",
        rhythm: {},
      },
      energy: {
        start: context.energyStart,
        end: context.energyStart,
        low: context.energyStart,
      },
    };
  }

  const hasMeal = sightStops.some((stop) => stop.kind === "meal");
  const hasCafe = sightStops.some((stop) => stop.kind === "cafe");
  const ordered = insertMeals(
    sightStops,
    {
      lunch: !hasMeal && context.startMin < 13 * 60,
      dinner: !hasMeal,
      cafe:
        !hasCafe &&
        opts?.cafe !== false &&
        context.pace !== "packed" &&
        sightStops.length >= 2 &&
        context.startMin < 14 * 60,
    },
    context,
    used,
  );

  const nodes = [context.hotel, ...ordered.map((stop) => stop.place), context.hotel];
  const modes: TransportMode[] = [];
  for (let index = 1; index < nodes.length; index++) {
    modes.push(
      pickTransportMode(
        nodes[index - 1],
        nodes[index],
        context.transport,
        context.styles,
        context.city,
      ),
    );
  }

  const routes = await mapLimit(modes, 4, (mode, index) => {
    if (mode === "transit") {
      const metro = metroRawRoute(nodes[index], nodes[index + 1], context.city);
      if (metro) return Promise.resolve(metro);
    }
    return safeRoute(context.provider, nodes[index], nodes[index + 1], mode, context.city);
  });

  let clock = context.startMin;
  let previous = context.hotel;
  const stops: StopPlan[] = [];
  const legs: RouteLeg[] = [];
  let rainiest: {
    place: Place;
    startMin: number;
    endMin: number;
    mm: number;
    fixed: boolean;
  } | null = null;
  let hottest: {
    place: Place;
    startMin: number;
    endMin: number;
    peak: number;
  } | null = null;
  /**
   * 体力曲线。出门时的能量由 scheduleDay 算好（首日晚到、后几天累积疲劳、
   * 老人小孩都在里面），这里只负责按点位扣减，并在体力见底时给出人话解释。
   */
  let energy = context.energyStart;
  /** 人流提示每天只给一条：满屏「建议早点来」等于没有建议。 */
  let crowdNoted = false;

  for (let index = 0; index < ordered.length; index++) {
    const stop = ordered[index];
    const mode = modes[index];
    const route = routes[index];
    const departMin = Math.ceil(clock / 5) * 5;
    const leg = makeLeg(index, previous, stop.place, mode, route, departMin, context.crowd, context.city);
    let arriveMin = leg.arriveMin;
    const rawDwell = dwellFor(
      stop.place,
      stop.kind,
      context.pace,
      context.styles,
      context.crowd,
      context.city,
    );
    let dwell = roundToFive(rawDwell);
    let wait = 0;
    let openNote: string | undefined;

    if (stop.kind === "sight") {
      const windows = parseOpenWindows(stop.place.openHours);
      if (windows.length) {
        const matching = windows.find(
          (window) => arriveMin >= window.start - 20 && arriveMin <= window.end - 20,
        );
        if (matching) {
          if (arriveMin < matching.start) {
            wait = roundToFive(matching.start - arriveMin);
            openNote = `${minutesToTime(matching.start)} 开门，先在附近转转`;
          }
          if (arriveMin + wait + dwell > matching.end) {
            dwell = Math.max(15, roundToFive(matching.end - arriveMin - wait));
            openNote = `${minutesToTime(matching.end)} 闭馆，参观时间收紧`;
          }
        } else {
          const latest = Math.max(...windows.map((window) => window.end));
          const earliest = Math.min(...windows.map((window) => window.start));
          if (arriveMin > latest - 20) {
            openNote = "到达时可能已闭馆，出发前再确认";
            warnings.push(`「${stop.place.name}」到达时可能已闭馆，建议出发前确认开放时间。`);
          } else if (arriveMin < earliest) {
            wait = roundToFive(earliest - arriveMin);
            openNote = `${minutesToTime(earliest)} 开门，先歇一会儿`;
          }
        }
      }
    } else if (stop.slot === "lunch" && arriveMin < LUNCH_START) {
      wait = LUNCH_START - arriveMin;
      openNote = "到得早，先喝口水歇一会儿";
    } else if (stop.slot === "dinner" && arriveMin < DINNER_START) {
      wait = DINNER_START - arriveMin;
      openNote = "到得早，先在附近逛逛";
    } else if (stop.slot === "cafe" && arriveMin < 15 * 60) {
      // 后面就是日落/夜市的话，茶歇放在三点，比吃完午饭立刻喝咖啡自然。
      const closesLate = ordered.slice(index + 1).some((next) => {
        if (next.kind !== "sight") return false;
        const profile = rhythmOf(context.city, next.place);
        return profile.nightStreet || profile.sunset;
      });
      if (closesLate && arriveMin >= 14 * 60) {
        wait = roundToFive(15 * 60 - arriveMin);
        openNote = "下午茶时间，慢慢坐一会儿";
      }
    }
    const rhythmShift = rhythmWaitFor(
      stop.place,
      stop.kind,
      arriveMin,
      context.city,
      context.weather,
    );
    if (rhythmShift.wait > wait) {
      wait = rhythmShift.wait;
      openNote = rhythmShift.note;
    }

    const startMin = Math.ceil((arriveMin + wait) / 5) * 5;
    // 在路上也在耗：上一站结束到这一站开始，按小时扣基础消耗。
    // 口径与 summarizeEnergy 一致（都不含站后缓冲），不然标签和解释会对不上。
    const lastEnd = stops.length
      ? stops[stops.length - 1].endMin
      : context.startMin;
    energy = Math.max(0, energy - timeDrain(lastEnd, startMin));
    const advice = weatherAdviceFor(stop, context.weather, startMin, dwell);
    dwell = advice.dwell;
    // 拥挤拉长停留：只认人工核实的时段数据，推断规则不参与（见 crowd.ts）。
    const crowdScale = crowdDwellFactor(crowdOf(stop.place), startMin, dwell);
    if (crowdScale > 1) {
      dwell = roundToFive(dwell * crowdScale);
    }
    // 体力见底时，重体力点位的停留收 15%。
    // 不是为了让指标好看，是承认「走不动了」本身就要花时间：找座、歇脚、上厕所。
    const energyScale = energyDwellScale(energy, stop.place, context.city);
    if (energyScale < 1) {
      dwell = Math.max(15, roundToFive(dwell * energyScale));
    }
    const endMin = startMin + dwell;
    if (advice.heavy && (!rainiest || advice.mm > rainiest.mm)) {
      rainiest = {
        place: stop.place,
        startMin,
        endMin,
        mm: advice.mm,
        fixed: advice.fixed,
      };
    }
    if (
      advice.heatPeak !== undefined &&
      advice.heatPeak >= HEAT_NOTE_C &&
      (!hottest || advice.heatPeak > hottest.peak)
    ) {
      hottest = {
        place: stop.place,
        startMin,
        endMin,
        peak: advice.heatPeak,
      };
    }
    const notes = [stop.place.note, openNote, ...advice.notes].filter(
      Boolean,
    ) as string[];
    // 人流：只在「排得正好」或「撞上高峰」时说话，每天最多一条。
    // 夜市和日落点的「高峰」就是它存在的理由，劝人避开等于劝人别去。
    if (stop.kind === "sight" && !crowdNoted) {
      const rhythm = rhythmOf(context.city, stop.place);
      if (!rhythm.nightStreet && !rhythm.sunset) {
        const stageNote = crowdNote(crowdOf(stop.place), startMin, dwell);
        if (stageNote) {
          notes.push(stageNote);
          crowdNoted = true;
        }
      }
    }
    // 体力：只剩半格电还排了爬山，就把话说明白，而不是假装排得动。
    const tiredNote = energyNote(energy, stop.place, context.city);
    if (tiredNote) notes.push(tiredNote);
    if (stop.kind === "sight" && stop.place.costNote && stop.place.cost) {
      notes.push(`参考费用：${stop.place.costNote}`);
    }
    legs.push(leg);
    stops.push({
      id: `${context.dayIndex}-${index + 1}-${stop.place.id}`,
      place: stop.place,
      kind: stop.kind,
      order: index + 1,
      startMin,
      endMin,
      dwellMin: endMin - startMin,
      note: notes.length ? notes.join(" · ") : undefined,
      slot: stop.slot,
      flexible: stop.flexible,
      ticket:
        stop.kind === "sight" && stop.place.cost !== undefined
          ? stop.place.cost
          : undefined,
      estimatedTicket:
        stop.kind === "sight" && stop.place.cost !== undefined
          ? Boolean(stop.place.costNote) || stop.place.source !== "amap"
          : undefined,
    });
    clock = endMin;
    // 待在里面同样在耗体力：停留这两小时不是「静止」，是站着、走着、排队。
    energy = Math.max(0, energy - timeDrain(startMin, endMin));
    energy = applyEnergy(
      energy,
      stop.place,
      context.city,
      endMin - startMin,
      null,
      stop.slot,
    );
    if (stop.kind === "sight") {
      const buffer = roundToFive(
        PACES[context.pace].bufferMin *
          (stop.fixed ? 0.55 : 1) *
          (1 + (context.crowd - 1) * 0.4) +
          // 「走一会要歇」的人，站间余量放宽一点。中性偏好的贡献恒为 0，
          // 所以不传 prefs 时与旧行为逐字节一致。
          restBufferOf(context.prefs),
      );
      clock += Math.max(0, buffer);
    }
    previous = stop.place;
  }

  const finalIndex = ordered.length;
  const finalDepart = Math.ceil(clock / 5) * 5;
  const dinner = endOfDayDinner(stops, ordered, context, used);
  let endMin: number;
  if (dinner && !dinner.atHotel) {
    const mode = pickTransportMode(
      previous,
      dinner.seed.place,
      context.transport,
      context.styles,
      context.city,
    );
    const route = await safeRoute(
      context.provider,
      previous,
      dinner.seed.place,
      mode,
      context.city,
    );
    const leg = makeLeg(
      finalIndex,
      previous,
      dinner.seed.place,
      mode,
      route,
      finalDepart,
      context.crowd,
      context.city,
    );
    legs.push(leg);
    const dinnerStop = scheduleAppendedDinner(
      dinner.seed,
      leg.arriveMin,
      finalIndex + 1,
      false,
      context,
    );
    stops.push(dinnerStop);
    const homeMode = pickTransportMode(
      dinner.seed.place,
      context.hotel,
      context.transport,
      context.styles,
      context.city,
    );
    const homeRoute = await safeRoute(
      context.provider,
      dinner.seed.place,
      context.hotel,
      homeMode,
      context.city,
    );
    const homeLeg = makeLeg(
      finalIndex + 1,
      dinner.seed.place,
      context.hotel,
      homeMode,
      homeRoute,
      Math.ceil(dinnerStop.endMin / 5) * 5,
      context.crowd,
      context.city,
    );
    legs.push(homeLeg);
    endMin = homeLeg.arriveMin;
  } else {
    const returnLeg = makeLeg(
      finalIndex,
      previous,
      context.hotel,
      modes[finalIndex],
      routes[finalIndex],
      finalDepart,
      context.crowd,
      context.city,
    );
    legs.push(returnLeg);
    endMin = returnLeg.arriveMin;
    if (dinner) {
      const dinnerStop = scheduleAppendedDinner(
        dinner.seed,
        returnLeg.arriveMin,
        finalIndex + 1,
        true,
        context,
      );
      stops.push(dinnerStop);
      endMin = dinnerStop.endMin;
    }
  }
  const ticket = stops.reduce(
    (sum, stop) => sum + (stop.kind === "sight" && stop.ticket ? stop.ticket : 0),
    0,
  );
  const stats: DayStats = {
    stopCount: stops.length,
    sightCount: stops.filter((stop) => stop.kind === "sight").length,
    distanceKm: legs.reduce((sum, leg) => sum + leg.distanceKm, 0),
    travelMin: legs.reduce((sum, leg) => sum + leg.durationMin, 0),
    walkKm: legs.reduce(
      (sum, leg) => sum + (leg.mode === "walk" ? leg.distanceKm : 0),
      0,
    ),
    ticket,
  };

  const severeRainDay =
    Boolean(context.weather) &&
    !context.weather?.estimated &&
    ((context.weather?.code ?? 0) >= 95 ||
      context.weather?.code === 65 ||
      context.weather?.code === 82 ||
      (context.weather?.precipProb ?? 0) >= 85);
  if (rainiest && !severeRainDay) {
    const range = `${minutesToTime(rainiest.startMin)}–${minutesToTime(rainiest.endMin)}`;
    warnings.push(
      context.weather?.estimated
        ? `「${rainiest.place.name}」这段（${range}）按去年同期气候通常有雨，带好雨具，出发前一周再看预报。`
        : `「${rainiest.place.name}」这段（${range}）雨势较明显，${
            rainiest.fixed ? "带好雨具" : "已适当收紧户外停留"
          }，必要时换成室内点位。`,
    );
  }

  if (
    hottest &&
    context.weather &&
    !context.weather.estimated &&
    hottest.peak >= HEAT_TRIM_C &&
    context.weather.tMax < 37
  ) {
    const range = `${minutesToTime(hottest.startMin)}–${minutesToTime(hottest.endMin)}`;
    warnings.push(
      `「${hottest.place.name}」这段（${range}）约 ${Math.round(hottest.peak)}°C，为当天最热时段，走树荫、勤补水。`,
    );
  }

  const narrative = describeDay(
    stops,
    context.city,
    context.pace,
    context.heroId,
  );
  const sightPlans = stops.filter((stop) => stop.kind === "sight");
  const paidSights = sightPlans.filter((stop) => {
    if ((stop.place.cost ?? 0) <= 0) return false;
    // 上岛轮渡是交通费，不是又一张门票；岛内买联票逛几个园子是正常玩法。
    return !(stop.place.island && stop.place.name.includes(stop.place.island));
  });
  if (paidSights.length >= PAID_SIGHT_WARNING_LIMIT) {
    warnings.push(
      `今天有 ${paidSights.length} 个付费点，容易变成赶场，建议留一个主景，其余换成免费街区或公园。`,
    );
  }
  const quickStops = sightPlans.filter(
    (stop) => rhythmOf(context.city, stop.place).quickStop,
  );
  if (quickStops.length >= 2) {
    warnings.push(
      `「${quickStops[0].place.name}」和「${quickStops[1].place.name}」都偏短停，选一个顺路看看就好。`,
    );
  }
  if (stats.walkKm >= 8) {
    warnings.push(
      `今天步行约 ${stats.walkKm.toFixed(1)} km，比一般 citywalk 长，带老人小孩量力。`,
    );
  }

  const names = stops.map((stop) => stop.place.name).join(" ");
  const tips: string[] = [];
  if (context.rainDelayNote) tips.push(context.rainDelayNote);
  if (context.far) {
    tips.push(
      context.startMin < PACES[context.pace].startMin
        ? "今天是远足日，路上时间较长，早点出发，回程留点余量。"
        : "今天是远足日，景点集中在另一片城区，按这条线走不用来回折返。",
    );
  }
  if (narrative.rhythm.sunrise) {
    tips.push("看日出提前 20 分钟到位，清晨风凉，带件外套。");
  } else if (narrative.rhythm.sunset) {
    tips.push("日落前 40 分钟到，看完天就黑了，回程留意末班车。");
  }
  if (
    sightPlans.some(
      (stop) => rhythmOf(context.city, stop.place).marketMorning,
    )
  ) {
    tips.push("市场早饭 9 点后选择变少，先去吃再慢慢逛。");
  }
  if (names.includes("厦门大学")) {
    tips.push("厦门大学需要提前预约，进校记得带身份证。");
  }
  if (legs.some((leg) => /轮渡|候船|跨海/.test(`${leg.note ?? ""}`))) {
    tips.push("今天要坐轮渡，末班船时间出发前再确认一下。");
  }
  const metroLines = Array.from(
    new Set(
      legs.flatMap((leg) => {
        const match = /地铁 ([\d/]+) 号线/.exec(leg.note ?? "");
        return match ? [match[1]] : [];
      }),
    ),
  );
  if (metroLines.length) {
    tips.push(
      `今天会坐地铁 ${metroLines.join("/")} 号线，进出站和换乘按 5–10 分钟留余量，扫码进站更方便。`,
    );
  }
  if (stats.walkKm >= 5) {
    tips.push("今天步行不少，穿一双好走的鞋。");
  }
  if (endMin > (context.family ? 20 * 60 : 21 * 60)) {
    tips.push("回到住处会比较晚，晚饭别拖太晚。");
  }
  if (context.crowd > 1.25) {
    tips.push("假期人多，热门点位尽量赶在开门前后到。");
  }
  if (!tips.length) {
    const fallbacks = [
      "路线已经按顺路排好，留白的地方就用来发呆。",
      "午饭和茶歇都在路线上，走累了就坐下。",
      "不必赶点，沿路的小巷也值得拐进去。",
    ];
    const jitter = seededJitter(context.seed, `tip-${context.dayIndex}`, 1);
    tips.push(fallbacks[Math.floor((jitter + 1) * 0.5 * fallbacks.length) % fallbacks.length]);
  }

  // 全天体力曲线：出门多少、最低掉到哪、回来还剩多少。
  // 算在最后的 stops 上（含临时追加的晚饭），所以和用户看到的顺序一致。
  const energyFlow = summarizeEnergy(
    stops.map((stop) => ({
      place: stop.place,
      dwellMin: stop.dwellMin,
      slot: stop.slot,
      startMin: stop.startMin,
      endMin: stop.endMin,
    })),
    context.energyStart,
    context.city,
    context.startMin,
  );

  return {
    stops,
    legs,
    startMin: legs[0]?.departMin ?? PACES[context.pace].startMin,
    endMin,
    stats,
    warnings,
    tip: tips.slice(0, 2).join(" "),
    narrative,
    energy: {
      start: energyFlow.start,
      end: energyFlow.end,
      low: energyFlow.low,
      lowPlaceId: energyFlow.lowPlaceId,
    },
  };
}

function clockMinute(value?: string): number | null {
  if (!value) return null;
  const [hour, minute] = value.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

// 一天里中午到傍晚空出两小时以上，多半是因为下一个点是日落或夜市。
// 从发现池里顺路补一个白天点位，比让行程干等更像真人写的攻略。
//
// 空洞有两种，原来只认前一种：
//   · between —— 两个停留点之间空着（等日落/夜市）；
//   · tail    —— 当天最后一段之后什么都没有，也不吃晚饭就回酒店。
// 后者就是「砍点砍过头」的样子：厦大 15:34 出馆、午饭吃完，剩下一整个下午消失。
// 用户看到的不是「松弛」，是「半天没了」。
export interface AfternoonHole {
  prev: StopPlan;
  /** null = 尾段空洞，后面没有点可以接，只能往当天末尾补。 */
  next: StopPlan | null;
  startMin: number;
  endMin: number;
}

/** 尾段空洞的目标收尾时刻：补到能自然接上晚饭，而不是硬拖到很晚。 */
const TAIL_FILL_END = 18 * 60 + 30;
/** 尾段从这个时刻之前散场才算空洞；17 点后收工属于正常下午结束。 */
const TAIL_HOLE_BEFORE = 17 * 60;

/** 导出给回归检查用（scripts/check-tail-hole.ts）。 */
export function afternoonHole(
  stops: StopPlan[],
  endLimit = 19 * 60,
): AfternoonHole | null {
  let best: AfternoonHole | null = null;
  for (let index = 0; index < stops.length - 1; index++) {
    const prev = stops[index];
    const next = stops[index + 1];
    const startMin = prev.endMin;
    const endMin = next.startMin;
    if (endMin - startMin < 120) continue;
    // 从 12:00 起算：午饭常常在 12:05 结束，卡 12:30 会把「吃完午饭一直空到日落」
    // 这种最典型的空洞漏掉（实测厦门第 3 天就漏了 285 分钟）。
    if (startMin < 12 * 60 || endMin > 18 * 60) continue;
    if (!best || endMin - startMin > best.endMin - best.startMin) {
      best = { prev, next, startMin, endMin };
    }
  }
  if (best) return best;

  const last = stops[stops.length - 1];
  if (!last) return null;
  // 晚饭已经在里面，说明这一天是有收尾的，不补。
  if (stops.some((stop) => stop.slot === "dinner")) return null;
  // 时间型点位（日出/早市/夜市）不当尾段填补的对象，那是另一套节奏。
  if (last.kind !== "sight" && last.kind !== "meal") return null;
  if (last.endMin >= TAIL_HOLE_BEFORE) return null;
  // 目标收尾既不能早于午饭结束 + 一段停留，也不该越过当天的回家上限。
  const endMin = Math.min(Math.max(TAIL_FILL_END, last.endMin + 90), endLimit);
  if (endMin - last.endMin < 90) return null;
  return { prev: last, next: null, startMin: last.endMin, endMin };
}

function supportFits(
  candidate: Place,
  prev: Place,
  next: Place | null,
  hole: { startMin: number; endMin: number },
  city: string,
  hasSunset: boolean,
): boolean {
  const profile = rhythmOf(city, candidate);
  if (profile.sunrise || profile.marketMorning || profile.nightStreet) {
    return false;
  }
  if (profile.sunset && hasSunset) return false;
  if (
    !["attraction", "park", "viewpoint", "beach", "street", "temple", "market"].includes(
      candidate.category,
    )
  ) {
    return false;
  }
  if (placeDistance(prev, candidate) > 3.2) return false;
  if (next && placeDistance(candidate, next) > 3.6) return false;
  if (Boolean(prev.island) !== Boolean(candidate.island)) return false;
  if (prev.island && candidate.island && prev.island !== candidate.island) {
    return false;
  }
  // 尾段空洞没有「下一个点」可以挤，直接补到目标收尾；
  // 中间空洞才能把下一个点整体后移 45 分钟（等日落/夜市本身就有余量）。
  const slotStart = hole.startMin + estimateModeMinutes(prev, candidate, "taxi");
  const slotEnd = next
    ? hole.endMin + 45 - estimateModeMinutes(candidate, next, "taxi")
    : hole.endMin;
  if (slotEnd - slotStart < 45) return false;
  return profile.windows.some(
    ([start, end]) => Math.min(end, slotEnd) - Math.max(start, slotStart) >= 40,
  );
}

async function fillAfternoonHole(
  attempt: StopSeed[],
  built: BuiltDay,
  context: BuildContext,
  baseUsed: Set<string>,
  includeCafe: boolean,
  spares: Place[],
  endLimit: number,
  overrunLimit: number,
): Promise<{
  attempt: StopSeed[];
  used: Set<string>;
  built: BuiltDay;
} | null> {
  if (!spares.length) return null;
  const hole = afternoonHole(built.stops, endLimit);
  if (!hole) return null;
  // 尾段空洞往末尾追加；中间空洞插在下一个点之前。
  const nextIndex = hole.next
    ? attempt.findIndex((stop) => stop.place.id === hole.next?.place.id)
    : attempt.length;
  if (nextIndex < 0) return null;
  const usedIds = new Set(attempt.map((stop) => stop.place.id));
  const hasSunset = attempt.some(
    (stop) => rhythmOf(context.city, stop.place).sunset,
  );
  // 补点是为了让下午有事做，不是为了凑数：如果前两个点已经是同一类
  // （连着两座馆、两条老街），再补一个同类就成了「三个一样的」，
  // 体检会记 SAME_CATEGORY_RUN，人也会觉得白来一趟。宁可不补。
  const prevIndex = built.stops.findIndex((stop) => stop.id === hole.prev.id);
  const beforeCat =
    prevIndex > 0 ? built.stops[prevIndex - 1].place.category : undefined;
  const prevCat = hole.prev.place.category;
  const nextCat = hole.next?.place.category;
  /** 前后已经有两个同类点，再补一个同类的就是三个连排。 */
  const makesTriple = (category: string) =>
    (beforeCat === category && prevCat === category) ||
    (prevCat === category && nextCat === category);
  const candidates = spares
    .filter((place) => !usedIds.has(place.id))
    .filter((place) => !makesTriple(place.category))
    .filter((place) =>
      supportFits(
        place,
        hole.prev.place,
        hole.next?.place ?? null,
        hole,
        context.city,
        hasSunset,
      ),
    )
    .sort(
      (a, b) =>
        (b.popularity ?? 3.4) -
        placeDistance(hole.prev.place, b) * 0.3 -
        ((a.popularity ?? 3.4) - placeDistance(hole.prev.place, a) * 0.3),
    )
    .slice(0, 2);
  const cap = Math.max(built.endMin + 90, endLimit + overrunLimit);
  for (const candidate of candidates) {
    const nextAttempt = [...attempt];
    nextAttempt.splice(nextIndex, 0, {
      place: candidate,
      kind: "sight",
      fixed: false,
    });
    const trialUsed = new Set(baseUsed);
    const trial = await buildOnce(nextAttempt, context, trialUsed, {
      cafe: includeCafe,
    });
    if (!trial.stops.some((stop) => stop.place.id === candidate.id)) continue;
    if (trial.endMin > cap || trial.endMin > 23 * 60 + 30) continue;
    return { attempt: nextAttempt, used: trialUsed, built: trial };
  }
  return null;
}

export async function scheduleDay(input: ScheduleInput): Promise<ScheduleResult> {
  const warnings: string[] = [];
  const far = Boolean(input.seedDay.far);
  const firstSight = input.seedDay.places.find(
    (place) => place.category !== "hotel",
  );
  const farLong =
    far && firstSight
      ? estimateModeMinutes(input.hotel, firstSight, "taxi") >= 60
      : false;
  const weather = input.weather ?? null;
  const firstRhythm = firstSight ? rhythmOf(input.city, firstSight) : null;
  const paceStart = firstRhythm?.marketMorning
    ? Math.min(
        PACES[input.pace].startMin,
        input.pace === "chill" ? 8 * 60 : 7 * 60 + 30,
      )
    : PACES[input.pace].startMin;
  const rawStart =
    input.seedDay.startMinHint ?? paceStart - (farLong ? 30 : 0);
  // 出发时间不能晚过节奏允许的上限。
  // compose 有时为了等日落把整天往后挪，结果 11:00 才出门 ——
  // 审计认为午餐前的上午白扔了，用户看到的也是「出门就快中午」。
  // 例外是整天只有日落/夜市型点位：那种日子下午出门本来就是对的。
  const afternoonOnly = input.seedDay.places.every((place) => {
    const profile = rhythmOf(input.city, place);
    if (profile.sunset || profile.nightStreet) return true;
    return (
      profile.windows.length > 0 &&
      Math.min(...profile.windows.map(([start]) => start)) >= 13 * 60 + 30
    );
  });
  const baseStart = afternoonOnly
    ? rawStart
    : Math.min(rawStart, LATEST_START[input.pace]);
  const sunrisePlace = input.seedDay.places.some(
    (place) => rhythmOf(input.city, place).sunrise,
  );
  const sunriseMin = clockMinute(weather?.sunrise);
  const rhythmStart =
    sunrisePlace && sunriseMin !== null
      ? Math.max(4 * 60 + 30, Math.min(baseStart, sunriseMin - 35))
      : baseStart;
  const rainStart = planRainStart(
    weather,
    rhythmStart,
    Boolean(input.seedDay.fixed),
  );
  const context: BuildContext = {
    hotel: input.hotel,
    city: input.city,
    date: input.date,
    pace: input.pace,
    styles: input.styles,
    transport: input.transport,
    crowd: input.crowd,
    color: input.color,
    seed: input.seed,
    dayIndex: input.seedDay.index,
    provider: input.provider,
    meals: input.meals,
    far,
    family: input.family,
    heroId: input.seedDay.anchorIds?.[0],
    startMin: rainStart.startMin,
    weather,
    rainDelayNote: rainStart.note,
    // 首日晚到、第二天起累积疲劳、带小孩都要在起点扣掉；
    // 这条曲线只影响「还能不能按原时长走完」，不影响去哪。
    energyStart: initialEnergy({
      startMin: rainStart.startMin,
      dayIndex: input.seedDay.index,
      pace: input.pace,
      children: input.family ? 1 : 0,
    }),
    prefs: input.prefs,
  };

  let sightStops: StopSeed[] = input.seedDay.places
    .filter((place) => place.category !== "hotel")
    .map((place) => ({
      place,
      kind: kindOf(place),
      fixed: input.seedDay.fixed,
    }));

  if (!input.seedDay.fixed) {
    const rough = roughTimeline(
      sightStops.map((stop) => stop.place),
      input.hotel,
      context.startMin,
      input.pace,
      input.transport,
      input.styles,
      input.crowd,
      input.city,
      context.weather,
    );
    sightStops = sightStops.filter((stop, index) => {
      const windows = parseOpenWindows(stop.place.openHours);
      if (!windows.length) return true;
      const arrive = rough[index]?.arrive ?? context.startMin;
      const latest = Math.max(...windows.map((window) => window.end));
      if (arrive > latest - 20) {
        warnings.push(`「${stop.place.name}」到达时已接近闭馆，已从当天行程里拿掉。`);
        return false;
      }
      return true;
    });
  }

  let attempt = sightStops;
  const anchorIds = new Set(input.seedDay.anchorIds ?? []);
  const maxDrops = input.seedDay.fixed ? 0 : 2;
  /** 没有任何一天该在午夜后才回到酒店，哪怕为此再少看一个点。 */
  const HARD_CEIL = 23 * 60 + 15;
  const closesLate = input.seedDay.places.some((place) => {
    const profile = rhythmOf(input.city, place);
    return profile.nightStreet || profile.sunset;
  });
  const { overrunLimit, endLimit } = lateReturnLimits({
    paceEndMin: PACES[input.pace].endMin,
    family: input.family,
    closesLate,
    farLong,
  });
  let includeCafe = true;
  let drops = 0;
  let localUsed = new Set(input.usedMealIds);
  let last = await buildOnce(attempt, context, localUsed, { cafe: includeCafe });

  while (true) {
    // 日落点排到天黑以后就没有意义了。先撤掉挤占午后的支撑点把日落拉回来，
    // 实在拉不回来才放弃日落，别让用户摸黑去海边。
    if (!input.seedDay.fixed) {
      const sunsetMin = clockMinute(context.weather?.sunset) ?? 17 * 60 + 30;
      const cutoff = sunsetMin + 20;
      const lateSunset = last.stops.find((stop) => {
        if (stop.kind !== "sight") return false;
        const profile = rhythmOf(input.city, stop.place);
        return profile.sunset && stop.startMin > cutoff;
      });
      if (lateSunset) {
        const spare = attempt.filter((stop) => {
          if (stop.kind !== "sight" || stop.fixed) return false;
          if (anchorIds.has(stop.place.id)) return false;
          const profile = rhythmOf(input.city, stop.place);
          return !profile.sunset && !profile.nightStreet;
        });
        // 名气一般的日落点不值得挤掉白天的主景；只有真正值得追的日落才保。
        const chaseSunset = (lateSunset.place.popularity ?? 0) >= 4.1;
        if (chaseSunset && spare.length) {
          const lateOnly = (place: Place) => {
            const windows = rhythmOf(input.city, place).windows;
            return windows.length > 0 &&
              Math.min(...windows.map(([start]) => start)) >= 14 * 60
              ? 1
              : 0;
          };
          const victim = [...spare].sort(
            (a, b) => lateOnly(b.place) - lateOnly(a.place),
          )[0];
          attempt = attempt.filter((stop) => stop !== victim);
          warnings.push(
            `为了赶上日落，「${victim.place.name}」不再单独占一段，吃饭或喝咖啡时顺路逛就好。`,
          );
          localUsed = new Set(input.usedMealIds);
          last = await buildOnce(attempt, context, localUsed, {
            cafe: includeCafe,
          });
          continue;
        }
        attempt = attempt.filter(
          (stop) => stop.place.id !== lateSunset.place.id,
        );
        warnings.push(
          `今天到「${lateSunset.place.name}」时已经过了日落，先把这站留到下次。`,
        );
        localUsed = new Set(input.usedMealIds);
        last = await buildOnce(attempt, context, localUsed, {
          cafe: includeCafe,
        });
        continue;
      }
    }
    const overrun = last.endMin - endLimit;
    // 远足日原来给到 endMin + 75 + 90 的余量，等于默许过午夜才回酒店。
    if (overrun <= overrunLimit && last.endMin <= HARD_CEIL) break;
    // 咖啡馆是加分项，不能因为它砍掉景点或拖到很晚，先把它收回来再看。
    if (includeCafe && last.stops.some((stop) => stop.kind === "cafe")) {
      includeCafe = false;
      localUsed = new Set(input.usedMealIds);
      last = await buildOnce(attempt, context, localUsed, { cafe: false });
      continue;
    }
    if (drops >= maxDrops && last.endMin <= HARD_CEIL) {
      warnings.push(`今日行程比较满，回到住处约 ${minutesToTime(last.endMin)}。`);
      break;
    }
    // 主景、日落和夜市锚点是一天的骨架，宁可晚一点回住处也不能砍掉。
    const droppable = attempt.filter(
      (stop) =>
        stop.kind === "sight" &&
        !stop.fixed &&
        !anchorIds.has(stop.place.id),
    );
    if (!droppable.length) {
      warnings.push(`今日行程比较满，回到住处约 ${minutesToTime(last.endMin)}。`);
      break;
    }
    const victim = droppable[droppable.length - 1];
    attempt = attempt.filter((stop) => stop !== victim);
    drops += 1;
    const covered = last.stops.some(
      (stop) =>
        stop.place.id !== victim.place.id &&
        (stop.place.name.includes(victim.place.name) ||
          victim.place.name.includes(stop.place.name)),
    );
    warnings.push(
      covered
        ? `「${victim.place.name}」和当天其他点位在同一片，吃完顺路逛即可，不再单独留一整段。`
        : `为了不赶路，今天略过了「${victim.place.name}」（原计划回到住处约 ${minutesToTime(last.endMin)}）。`,
    );
    localUsed = new Set(input.usedMealIds);
    last = await buildOnce(attempt, context, localUsed, { cafe: includeCafe });
  }

  const filled = await fillAfternoonHole(
    attempt,
    last,
    context,
    input.usedMealIds,
    includeCafe,
    // 攻略日（fixed）的点位是用户点名的，不往里塞我们自己挑的点。
    input.seedDay.fixed ? [] : input.spares ?? [],
    endLimit,
    overrunLimit,
  );
  if (filled) {
    attempt = filled.attempt;
    last = filled.built;
    localUsed = filled.used;
  }

  localUsed.forEach((id) => input.usedMealIds.add(id));
  const built = last;

  const plan: DayPlan = {
    index: input.seedDay.index,
    date: input.date,
    theme: input.seedDay.theme,
    area: input.seedDay.area,
    color: input.color,
    stops: built.stops,
    legs: built.legs,
    stats: built.stats,
    startMin: built.startMin,
    endMin: built.endMin,
    tip: built.tip,
    strategy: built.narrative.strategy,
    heroName: built.narrative.heroName,
    heroPlaceId: built.narrative.heroId,
    rhythm: built.narrative.rhythm,
    far,
    energy: built.energy,
  };

  return {
    plan,
    warnings: Array.from(new Set([...warnings, ...built.warnings])),
  };
}
