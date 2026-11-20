import { CATEGORY_DWELL, PACES } from "../constants";
import {
  estimateModeMinutes,
  placeDistance,
  roundToFive,
} from "../geo";
import { findPlaceProfile } from "../tips/places";
import { usableMetroTrip } from "../transit/metro";
import { LATEST_START } from "./limits";
import type {
  Category,
  DayRhythm,
  PaceId,
  Place,
  StopPlan,
  StyleId,
  TransportPref,
} from "../types";

export type TimeBand =
  | "dawn"
  | "morning"
  | "midday"
  | "afternoon"
  | "golden"
  | "evening"
  | "night";

export const BAND_WINDOWS: Record<TimeBand, [number, number]> = {
  dawn: [5 * 60, 7 * 60 + 30],
  morning: [7 * 60 + 30, 11 * 60],
  midday: [11 * 60, 13 * 60 + 30],
  afternoon: [13 * 60 + 30, 16 * 60 + 30],
  golden: [16 * 60 + 30, 18 * 60 + 30],
  evening: [18 * 60 + 30, 21 * 60],
  night: [21 * 60, 24 * 60],
};

export const BAND_LABELS: Record<TimeBand, string> = {
  dawn: "日出前后",
  morning: "上午",
  midday: "中午",
  afternoon: "午后",
  golden: "傍晚",
  evening: "晚上",
  night: "夜里",
};

export interface RhythmProfile {
  bands: TimeBand[];
  avoid: TimeBand[];
  windows: Array<[number, number]>;
  sunrise: boolean;
  sunset: boolean;
  quickStop: boolean;
  heroEligible: boolean;
  indoor: boolean;
  marketMorning: boolean;
  morningOnly: boolean;
  nightStreet: boolean;
  earlyBoat: boolean;
  booking: boolean;
  gateway: boolean;
  closingScore: number;
  durationMin: number;
  longStay: boolean;
}

const DEFAULT_BANDS: Record<Category, TimeBand[]> = {
  attraction: ["morning", "afternoon"],
  museum: ["midday", "afternoon"],
  park: ["morning", "golden"],
  viewpoint: ["golden", "morning"],
  beach: ["golden", "morning"],
  street: ["afternoon", "evening"],
  temple: ["morning"],
  market: ["morning"],
  nature: ["morning"],
  food: ["midday", "evening"],
  cafe: ["afternoon"],
  hotel: [],
  other: ["morning", "afternoon"],
};

const DEFAULT_AVOID: Partial<Record<Category, TimeBand[]>> = {
  attraction: ["night"],
  museum: ["dawn", "night"],
  park: ["midday"],
  viewpoint: ["midday"],
  beach: ["midday"],
  street: ["dawn"],
  temple: ["night"],
  market: ["night"],
  nature: ["midday"],
};

const rhythmCache = new Map<string, RhythmProfile>();

export function bandOfMinute(minute: number): TimeBand {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  if (wrapped < BAND_WINDOWS.dawn[1]) return "dawn";
  if (wrapped < BAND_WINDOWS.morning[1]) return "morning";
  if (wrapped < BAND_WINDOWS.midday[1]) return "midday";
  if (wrapped < BAND_WINDOWS.afternoon[1]) return "afternoon";
  if (wrapped < BAND_WINDOWS.golden[1]) return "golden";
  if (wrapped < BAND_WINDOWS.evening[1]) return "evening";
  return "night";
}

export function parseDurationMinutes(value?: string): number {
  if (!value) return 0;
  if (/半天\s*[-–—~至]\s*1\s*天/.test(value)) return 300;
  if (/1\s*天/.test(value)) return 360;
  if (/半天/.test(value)) return 180;
  if (/全天/.test(value)) return 360;
  const hourRange = value.match(
    /(\d+(?:\.\d+)?)\s*[-–—~至]\s*(\d+(?:\.\d+)?)\s*(?:h|小时)/i,
  );
  if (hourRange) {
    return Math.round(
      ((Number(hourRange[1]) + Number(hourRange[2])) / 2) * 60,
    );
  }
  const minuteRange = value.match(
    /(\d+)\s*[-–—~至]\s*(\d+)\s*分钟/,
  );
  if (minuteRange) {
    return Math.round(
      (Number(minuteRange[1]) + Number(minuteRange[2])) / 2,
    );
  }
  const hours = value.match(/(\d+(?:\.\d+)?)\s*(?:h|小时)/i);
  if (hours) return Math.round(Number(hours[1]) * 60);
  const minutes = value.match(/(\d+)\s*分钟/);
  if (minutes) return Number(minutes[1]);
  return 0;
}

function addBand(bands: Set<TimeBand>, band: TimeBand) {
  bands.add(band);
}

function addMoment(bands: Set<TimeBand>, minute: number) {
  addBand(bands, bandOfMinute(minute));
}

function addBefore(bands: Set<TimeBand>, minute: number) {
  addMoment(bands, minute - 45);
  if (minute <= 10 * 60) addBand(bands, "morning");
  if (minute >= 10 * 60 && minute <= 13 * 60) addBand(bands, "midday");
}

function addAfter(bands: Set<TimeBand>, minute: number) {
  addMoment(bands, minute + 45);
  if (minute >= 14 * 60) addBand(bands, "golden");
  if (minute >= 16 * 60) addBand(bands, "evening");
  if (minute >= 18 * 60) addBand(bands, "night");
}

function parseBestTime(value: string): {
  bands: Set<TimeBand>;
  windows: Array<[number, number]>;
  sunrise: boolean;
  sunset: boolean;
} {
  const bands = new Set<TimeBand>();
  const windows: Array<[number, number]> = [];
  const text = value;
  const sunrise = /日出/.test(text);
  const sunset = /日落/.test(text);
  if (sunrise) {
    addBand(bands, "dawn");
    windows.push([5 * 60, 7 * 60 + 30]);
  }
  if (sunset) {
    addBand(bands, "golden");
    windows.push([16 * 60 + 30, 19 * 60]);
  }

  const range =
    /(\d{1,2})(?:[:：](\d{2}))?\s*点?\s*[-–—~至]\s*(\d{1,2})(?:[:：](\d{2}))?\s*点?/g;
  let match: RegExpExecArray | null;
  while ((match = range.exec(text))) {
    const start = Number(match[1]) * 60 + Number(match[2] ?? 0);
    let end = Number(match[3]) * 60 + Number(match[4] ?? 0);
    if (end <= start) end += 24 * 60;
    addMoment(bands, start + 5);
    addMoment(bands, (start + end) / 2);
    addMoment(bands, end - 5);
    windows.push([start, end]);
  }

  const before = /(\d{1,2})(?:[:：](\d{2}))?\s*点?\s*前/g;
  while ((match = before.exec(text))) {
    const minute = Number(match[1]) * 60 + Number(match[2] ?? 0);
    addBefore(bands, minute);
    windows.push([5 * 60, minute]);
  }

  const after = /(\d{1,2})(?:[:：](\d{2}))?\s*点?\s*后/g;
  while ((match = after.exec(text))) {
    const minute = Number(match[1]) * 60 + Number(match[2] ?? 0);
    addAfter(bands, minute);
    windows.push([minute, 24 * 60]);
  }

  if (/清晨|一早|早晨/.test(text)) {
    addBand(bands, "dawn");
    windows.push([5 * 60, 7 * 60 + 30]);
  }
  if (/早上|上午/.test(text)) {
    addBand(bands, "morning");
    windows.push([7 * 60 + 30, 11 * 60]);
  }
  if (/中午|正午/.test(text)) {
    addBand(bands, "midday");
    windows.push([11 * 60 + 30, 13 * 60 + 30]);
  }
  if (/下午/.test(text)) {
    addBand(bands, "afternoon");
    windows.push([13 * 60 + 30, 17 * 60]);
  }
  if (/傍晚|黄昏/.test(text)) {
    addBand(bands, "golden");
    addBand(bands, "evening");
    windows.push([16 * 60 + 30, 18 * 60 + 30]);
  }
  if (/晚上|夜晚|夜里|亮灯|夜市/.test(text)) {
    addBand(bands, "evening");
    addBand(bands, "night");
    windows.push([18 * 60, 24 * 60]);
  }
  if (/全天/.test(text)) {
    addBand(bands, "morning");
    addBand(bands, "afternoon");
    addBand(bands, "golden");
    windows.push([8 * 60, 19 * 60]);
  }

  return { bands, windows, sunrise, sunset };
}

function mergeWindows(
  windows: Array<[number, number]>,
): Array<[number, number]> {
  const sorted = [...windows].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window[0] <= last[1] + 20) {
      last[1] = Math.max(last[1], window[1]);
    } else {
      merged.push([window[0], window[1]]);
    }
  }
  return merged;
}

export function rhythmOf(city: string, place: Place): RhythmProfile {
  const key = `${city}|${place.id}`;
  const hit = rhythmCache.get(key);
  if (hit) return hit;

  const profile = findPlaceProfile(city, place.name);
  const parsed = profile?.bestTime
    ? parseBestTime(profile.bestTime)
    : {
        bands: new Set<TimeBand>(),
        windows: [] as Array<[number, number]>,
        sunrise: false,
        sunset: false,
      };
  const text = `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")}`;
  const fallback = DEFAULT_BANDS[place.category] ?? DEFAULT_BANDS.other;
  const bands = parsed.bands.size
    ? Array.from(parsed.bands)
    : [...fallback];
  const avoid = [...(DEFAULT_AVOID[place.category] ?? [])];
  const popularity = place.popularity ?? 3.4;
  const rawDuration = parseDurationMinutes(profile?.duration);
  const gateway = Boolean(
    place.island && place.name.includes(place.island),
  );
  const durationMin = gateway ? 45 : rawDuration;
  const marketMorning =
    place.category === "market" ||
    /菜市场|早市|八市/.test(place.name) ||
    /早餐|早饭/.test(text);
  const nightStreet =
    /晚上|夜晚|亮灯|夜市/.test(profile?.bestTime ?? "") &&
      (place.category === "street" || place.category === "market") ||
    /中山路|曾厝垵|步行街|夜市/.test(place.name);
  const quickByProfile =
    rawDuration > 0 && rawDuration <= 60 && popularity < 4.55;
  const quickStop =
    /曾厝垵|网红商业街|商业小吃街/.test(place.name) ||
    (/网红/.test(text) && popularity < 4.6) ||
    quickByProfile;
  const indoor = place.category === "museum";
  const explicitHero =
    /classic|必去|地标/.test(text) ||
    popularity >= 4.35 ||
    Boolean(place.island);
  const earliestWindow = parsed.windows.length
    ? Math.min(...parsed.windows.map(([start]) => start))
    : Infinity;
  // 下午才开门的街区只适合当顺路点，不该撑起一整天的主锚点。
  const lateOnly =
    earliestWindow >= 14 * 60 && !parsed.sunset && !nightStreet;
  const heroEligible =
    !quickStop &&
    !lateOnly &&
    !["hotel", "food", "cafe", "other"].includes(place.category) &&
    explicitHero &&
    (rawDuration === 0 || rawDuration >= 60);
  const earlyBoat =
    /鼓浪屿/.test(place.name) || /上岛|船票/.test(profile?.bestTime ?? "");
  const booking = Boolean(profile?.booking) || /预约|限流/.test(text);

  let closingScore = 0;
  if (parsed.sunset) closingScore = 90;
  if (nightStreet) closingScore = 100;
  if (!parsed.sunset && !nightStreet) {
    if (bands.includes("night")) closingScore = 70;
    else if (bands.includes("evening")) closingScore = 60;
    else if (bands.includes("golden")) closingScore = 45;
  }
  if (durationMin >= 150) closingScore -= 45;

  const fallbackWindows = bands.map((band) => {
    const [start, end] = BAND_WINDOWS[band];
    return [start, end] as [number, number];
  });
  const windows = mergeWindows(
    parsed.windows.length ? parsed.windows : fallbackWindows,
  );
  // 寺庙/后山这类只适合上午的点，不能拿来做日落或夜市日的顺路点。
  const morningOnly =
    !nightStreet &&
    !parsed.sunset &&
    windows.length > 0 &&
    windows.every(([, end]) => end <= 12 * 60);

  const result: RhythmProfile = {
    bands,
    avoid,
    windows,
    sunrise: parsed.sunrise,
    sunset: parsed.sunset,
    quickStop,
    heroEligible,
    indoor,
    marketMorning,
    morningOnly,
    nightStreet,
    earlyBoat,
    booking,
    gateway,
    closingScore,
    durationMin,
    longStay: durationMin >= 150,
  };
  rhythmCache.set(key, result);
  return result;
}

export function rhythmDwell(
  place: Place,
  city: string,
  pace: PaceId,
  styles: StyleId[],
  crowd = 1,
): number {
  const profile = rhythmOf(city, place);
  const base =
    profile.durationMin ||
    CATEGORY_DWELL[place.category] ||
    50;
  let minutes = Math.min(240, Math.max(20, base)) * PACES[pace].dwellScale;
  if (!profile.durationMin) {
    if (
      styles.includes("culture") &&
      ["museum", "temple", "attraction"].includes(place.category)
    ) {
      minutes *= 1.15;
    }
    if (
      styles.includes("coastal") &&
      ["beach", "viewpoint", "park"].includes(place.category)
    ) {
      minutes *= 1.1;
    }
    if (
      styles.includes("family") &&
      ["museum", "attraction", "park"].includes(place.category)
    ) {
      minutes *= 1.1;
    }
  } else {
    if (styles.includes("culture") && profile.indoor) minutes *= 1.05;
    if (
      styles.includes("family") &&
      ["museum", "attraction", "park"].includes(place.category)
    ) {
      minutes *= 1.03;
    }
  }
  if (styles.includes("foodie") && ["market", "street"].includes(place.category)) {
    minutes *= 1.05;
  }
  minutes *= 1 + (crowd - 1) * 0.35;
  return Math.max(20, Math.min(240, roundToFive(minutes)));
}

export function rhythmBudgetMinutes(city: string, place: Place): number {
  const profile = rhythmOf(city, place);
  const base = profile.durationMin || CATEGORY_DWELL[place.category] || 50;
  return Math.min(240, Math.max(20, base));
}

export function rhythmTravelMinutes(
  from: Place,
  to: Place,
  input: Pick<ComposeInput, "city" | "styles" | "transport">,
): number {
  const km = placeDistance(from, to);
  const crossing =
    Boolean(from.island || to.island) && from.island !== to.island;
  if (crossing) return Math.min(75, 28 + km * 0.4);
  const walkLimit = input.styles.includes("citywalk") ? 3.2 : 2.4;
  const walk = km <= walkLimit ? estimateModeMinutes(from, to, "walk") : Infinity;
  if (input.transport === "drive") {
    return Math.min(walk, estimateModeMinutes(from, to, "taxi") + 2);
  }
  const metro = usableMetroTrip(from, to, input.city);
  const transit = estimateModeMinutes(from, to, "transit");
  const taxi = estimateModeMinutes(from, to, "taxi") + 2;
  return Math.min(
    walk,
    taxi,
    transit,
    metro ? metro.minutes + 6 : Infinity,
  );
}

function startForFirst(
  profile: RhythmProfile,
  pace: PaceId,
  baseStart: number,
): number {
  if (profile.sunrise) {
    return Math.max(5 * 60, Math.min(baseStart, 6 * 60));
  }
  if (profile.marketMorning) {
    return Math.min(baseStart, pace === "chill" ? 8 * 60 : 7 * 60 + 30);
  }
  const best = profile.windows[0]?.[0];
  if (best !== undefined) {
    if (best >= 15 * 60) return Math.max(baseStart, 14 * 60);
    if (best >= 13 * 60) return Math.max(baseStart, 13 * 60);
    if (best >= 10 * 60 + 30) {
      // 开门偏晚可以等一等，但不能等到午后：等 40 分钟好过丢掉整个上午。
      return Math.min(
        Math.max(baseStart, 10 * 60 + 45),
        Math.max(baseStart, LATEST_START[pace]),
      );
    }
  }
  return baseStart;
}

function bandPenalty(profile: RhythmProfile, arrivalMin: number): number {
  let best = Infinity;
  for (const [start, end] of profile.windows) {
    best = Math.min(
      best,
      arrivalMin < start
        ? start - arrivalMin
        : arrivalMin > end
          ? arrivalMin - end
          : 0,
    );
  }
  let penalty = Number.isFinite(best) ? Math.min(240, best) / 60 : 0;
  for (const band of profile.avoid) {
    const [start, end] = BAND_WINDOWS[band];
    if (arrivalMin >= start - 15 && arrivalMin <= end + 15) penalty += 1.2;
  }
  if (profile.sunset) {
    if (arrivalMin < 16 * 60) {
      penalty += ((16 * 60 - arrivalMin) / 60) * 1.4;
    }
    if (arrivalMin > 18 * 60 + 45) penalty += 2;
  }
  if (profile.marketMorning && arrivalMin > 9 * 60 + 30) {
    penalty += ((arrivalMin - 9 * 60 - 30) / 60) * 1.6;
  }
  if (profile.sunrise && arrivalMin > 7 * 60 + 30) {
    penalty += ((arrivalMin - 7 * 60 - 30) / 60) * 1.8;
  }
  if (profile.indoor && arrivalMin >= 11 * 60 && arrivalMin <= 15 * 60) {
    penalty -= 0.5;
  }
  return Math.max(0, penalty);
}

function hardPenalty(order: Entry[]): number {
  let penalty = 0;
  const n = order.length;
  const sunsets = order.filter((entry) => entry.profile.sunset).length;
  const quicks = order.filter((entry) => entry.profile.quickStop).length;
  if (sunsets > 1) penalty += (sunsets - 1) * 2.6;
  if (quicks > 1) penalty += (quicks - 1) * 2.4;
  const hasNight = order.some((entry) => entry.profile.nightStreet);
  const sunsetLast = hasNight ? n - 2 : n - 1;
  order.forEach((entry, index) => {
    if (entry.profile.sunset && index < sunsetLast) {
      penalty += (sunsetLast - index) * 2.4;
    }
    if (entry.profile.sunrise && index > 0) penalty += 4 + index * 1.5;
    if (entry.profile.marketMorning && index > 1) {
      penalty += (index - 1) * 2.2;
    }
    if (entry.profile.nightStreet && index !== n - 1) {
      penalty += (n - 1 - index) * 3.5;
    }
    if (entry.profile.quickStop && index === 0 && n > 2) penalty += 0.8;
  });
  return penalty;
}

interface Entry {
  place: Place;
  profile: RhythmProfile;
}

interface ComposeState {
  order: Entry[];
  prev: Place;
  clock: number;
  score: number;
  used: Set<string>;
}

export interface ComposeInput {
  places: Place[];
  hotel: Place;
  city: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  dayIndex: number;
  anchorId?: string;
  fixed?: boolean;
  baseStart?: number;
  seed: number;
}

export interface ComposedDay {
  places: Place[];
  heroId?: string;
  protectedIds: string[];
  rhythm: DayRhythm;
  startMinHint?: number;
  warnings: string[];
}

function heroValue(entry: Entry): number {
  const popularity = entry.place.popularity ?? 3.4;
  return (
    popularity +
    (entry.profile.heroEligible ? 1.1 : 0) -
    (entry.profile.quickStop ? 2.2 : 0) +
    Math.min(1, entry.profile.durationMin / 150)
  );
}

function pickHero(entries: Entry[], anchorId?: string): Entry | undefined {
  const anchor = anchorId
    ? entries.find((entry) => entry.place.id === anchorId)
    : undefined;
  // 夜市和顺路短停是收尾/过渡角色，不该顶掉真正的白天主景。
  if (anchor && !anchor.profile.nightStreet && !anchor.profile.quickStop) {
    return anchor;
  }
  const eligible = entries.filter(
    (entry) => entry.profile.heroEligible && !entry.profile.nightStreet,
  );
  // 只有日落 + 夜市的日子，也别把夜市写成当天主景；白天的海和街区才是主体。
  const daySights = entries.filter(
    (entry) =>
      !entry.profile.nightStreet &&
      !entry.profile.quickStop &&
      entry.place.category !== "food" &&
      entry.place.category !== "cafe",
  );
  return (
    [...eligible].sort((a, b) => heroValue(b) - heroValue(a))[0] ??
    [...daySights].sort((a, b) => heroValue(b) - heroValue(a))[0] ??
    anchor ??
    [...entries].sort((a, b) => heroValue(b) - heroValue(a))[0]
  );
}

function summarizeOrder(
  order: Entry[],
  input: ComposeInput,
  startMin?: number,
): Omit<ComposedDay, "places"> {
  const warnings: string[] = [];
  const quicks = order.filter((entry) => entry.profile.quickStop);
  if (quicks.length > 1) {
    warnings.push(
      `今天有 ${quicks.length} 个商业街区，时间只够认真逛一个，另一个建议换成博物馆或公园。`,
    );
  }
  const sunsets = order.filter((entry) => entry.profile.sunset);
  if (sunsets.length > 1) {
    warnings.push("一天里有两个适合看日落的地方，选一个留到傍晚就好。");
  }
  const hero = pickHero(order, input.anchorId);
  const protectedIds = Array.from(
    new Set(
      [
        hero?.place.id,
        ...order
          .filter(
            (entry) =>
              entry.profile.sunset ||
              entry.profile.sunrise ||
              entry.profile.marketMorning ||
              entry.profile.nightStreet,
          )
          .map((entry) => entry.place.id),
      ].filter(Boolean) as string[],
    ),
  );

  let clock =
    startMin ??
    startForFirst(
      order[0].profile,
      input.pace,
      input.baseStart ?? PACES[input.pace].startMin,
    );
  let prev = input.hotel;
  let indoorMidday = false;
  let sunsetTimed = false;
  let sunriseTimed = false;
  let nightTimed = false;
  let nightArrival: number | null = null;
  let sunsetArrival: number | null = null;
  let lateMorningName: string | null = null;
  for (const entry of order) {
    clock += rhythmTravelMinutes(prev, entry.place, input);
    const arrival = clock;
    if (
      entry.profile.windows.length > 0 &&
      entry.profile.windows.every(([, end]) => end <= 11 * 60) &&
      arrival >= 13 * 60
    ) {
      lateMorningName = entry.place.name;
    }
    if (
      entry.profile.indoor &&
      arrival >= 11 * 60 &&
      arrival <= 15 * 60 + 30
    ) {
      indoorMidday = true;
    }
    if (entry.profile.sunset) {
      sunsetArrival = arrival;
      if (arrival >= 15 * 60 + 30) sunsetTimed = true;
    }
    if (entry.profile.nightStreet) {
      nightArrival = arrival;
      if (arrival >= 17 * 60) nightTimed = true;
    }
    if (entry.profile.sunrise && arrival < 8 * 60 + 30) sunriseTimed = true;
    clock =
      arrival +
      rhythmDwell(entry.place, input.city, input.pace, input.styles) +
      PACES[input.pace].bufferMin;
    prev = entry.place;
  }

  const opensEarly = order.some(
    (entry) => entry.profile.sunrise || entry.profile.marketMorning,
  );
  if (opensEarly && sunsetArrival !== null && sunsetArrival > 15 * 60) {
    warnings.push(
      "今天一早一晚两头都有安排，午后回酒店歇一会儿，或在附近找家店慢慢坐，别硬撑。",
    );
  }
  if (lateMorningName) {
    warnings.push(
      `「${lateMorningName}」本来更适合上午，排到了午后；如果带着老人孩子，注意放慢节奏、多补水。`,
    );
  }

  return {
    heroId: hero?.place.id,
    protectedIds,
    rhythm: {
      sunrise: sunriseTimed || undefined,
      sunset: sunsetTimed || undefined,
      early:
        Boolean(sunriseTimed) ||
        Boolean(order.some((entry) => entry.profile.marketMorning)) ||
        undefined,
      night: nightTimed || undefined,
      indoorMidday: indoorMidday || undefined,
    },
    startMinHint:
      startMin ??
      startForFirst(
        order[0].profile,
        input.pace,
        input.baseStart ?? PACES[input.pace].startMin,
      ),
    warnings,
  };
}

function plainSearch(
  entries: Entry[],
  input: ComposeInput,
  startMin: number,
): { order: Entry[]; total: number } {
  const n = entries.length;
  if (n <= 1) return { order: [...entries], total: 0 };
  const buffer = PACES[input.pace].bufferMin;

  const initial: ComposeState[] = entries.map((entry) => {
    const minutes = rhythmTravelMinutes(input.hotel, entry.place, input);
    const arrival = startMin + minutes;
    return {
      order: [entry],
      prev: entry.place,
      clock:
        arrival +
        rhythmDwell(entry.place, input.city, input.pace, input.styles) +
        buffer,
      score:
        placeDistance(input.hotel, entry.place) * 0.22 +
        minutes * 0.01 +
        bandPenalty(entry.profile, arrival),
      used: new Set([entry.place.id]),
    };
  });

  const beamLimit = n <= 7 ? Number.POSITIVE_INFINITY : 3200;
  let beams = initial;
  for (let depth = 1; depth < n; depth++) {
    const next: ComposeState[] = [];
    for (const state of beams) {
      for (const entry of entries) {
        if (state.used.has(entry.place.id)) continue;
        const minutes = rhythmTravelMinutes(state.prev, entry.place, input);
        const arrival = state.clock + minutes;
        next.push({
          order: [...state.order, entry],
          prev: entry.place,
          clock:
            arrival +
            rhythmDwell(entry.place, input.city, input.pace, input.styles) +
            buffer,
          score:
            state.score +
            placeDistance(state.prev, entry.place) * 0.22 +
            minutes * 0.01 +
            bandPenalty(entry.profile, arrival),
          used: new Set([...state.used, entry.place.id]),
        });
      }
    }
    next.sort((a, b) => a.score - b.score);
    beams = Number.isFinite(beamLimit) ? next.slice(0, beamLimit) : next;
  }

  let best: ComposeState | null = null;
  let bestTotal = Infinity;
  for (const state of beams) {
    if (state.order.length !== n) continue;
    const backMinutes = rhythmTravelMinutes(state.prev, input.hotel, input);
    const total =
      state.score +
      placeDistance(state.prev, input.hotel) * 0.22 +
      backMinutes * 0.01 +
      hardPenalty(state.order);
    if (total < bestTotal) {
      bestTotal = total;
      best = state;
    }
  }
  return { order: best?.order ?? [...entries], total: bestTotal };
}

interface DayFrame {
  opening: Entry[];
  middle: Entry[];
  closing: Entry[];
  startMin: number;
}

function takeBest(
  entries: Entry[],
  used: Set<string>,
  predicate: (entry: Entry) => boolean,
  score: (entry: Entry) => number = heroValue,
): Entry | undefined {
  let best: Entry | undefined;
  let bestScore = -Infinity;
  for (const entry of entries) {
    if (used.has(entry.place.id)) continue;
    if (!predicate(entry)) continue;
    const value = score(entry);
    if (value > bestScore) {
      bestScore = value;
      best = entry;
    }
  }
  if (best) used.add(best.place.id);
  return best;
}

function closingTarget(entry: Entry): number {
  if (entry.profile.nightStreet) return 18 * 60;
  if (entry.profile.sunset) return 16 * 60 + 40;
  return 17 * 60 + 15;
}

function advance(
  prev: Place,
  clock: number,
  score: number,
  entries: Entry[],
  input: ComposeInput,
): { prev: Place; clock: number; score: number } {
  const buffer = PACES[input.pace].bufferMin;
  let state = { prev, clock, score };
  for (const entry of entries) {
    const minutes = rhythmTravelMinutes(state.prev, entry.place, input);
    const arrival = state.clock + minutes;
    state = {
      prev: entry.place,
      clock:
        arrival +
        rhythmDwell(entry.place, input.city, input.pace, input.styles) +
        buffer,
      score:
        state.score +
        placeDistance(state.prev, entry.place) * 0.22 +
        minutes * 0.01 +
        bandPenalty(entry.profile, arrival),
    };
  }
  return state;
}

// 一天只有一条时间主轴：要么早起（日出/早市/上岛），要么傍晚收尾（日落/夜市）。
// 开场和收尾锚点先定死，中间的点只负责把一天顺路填满。
function buildFrame(entries: Entry[], input: ComposeInput): DayFrame {
  const used = new Set<string>();
  const gateway = takeBest(
    entries,
    used,
    (entry) => entry.profile.gateway,
    (entry) => entry.place.popularity ?? 3.4,
  );
  const sunrise = takeBest(
    entries,
    used,
    (entry) => entry.profile.sunrise,
  );
  const market = takeBest(
    entries,
    used,
    (entry) => entry.profile.marketMorning && !entry.profile.sunrise,
  );
  const night = takeBest(
    entries,
    used,
    (entry) => entry.profile.nightStreet,
    (entry) => entry.profile.closingScore + heroValue(entry) * 0.01,
  );
  const sunset = takeBest(
    entries,
    used,
    (entry) => entry.profile.sunset,
  );
  let late: Entry | undefined;
  if (!night && !sunset) {
    late = takeBest(
      entries,
      used,
      (entry) =>
        entry.profile.closingScore >= 60 &&
        entry.profile.windows.length > 0 &&
        Math.min(...entry.profile.windows.map(([start]) => start)) >= 16 * 60,
      (entry) => entry.profile.closingScore + heroValue(entry) * 0.01,
    );
  }
  const opening = [gateway, sunrise, market].filter(
    Boolean,
  ) as Entry[];
  const closing = [sunset, night].filter(Boolean) as Entry[];
  if (!closing.length && late) closing.push(late);
  let middle = entries.filter((entry) => !used.has(entry.place.id));
  // 上午限定型点位（寺庙后山等）当开场锚，但只有一天里另有下午内容或没有收尾锚时才用，
  // 避免出现“只逛一小时然后干等日落”的空壳日。
  const morning = takeBest(
    entries,
    used,
    (entry) =>
      entry.profile.morningOnly &&
      !entry.profile.sunrise &&
      !entry.profile.marketMorning &&
      !entry.profile.gateway,
    (entry) => heroValue(entry),
  );
  if (morning) {
    opening.push(morning);
    middle = middle.filter((entry) => entry !== morning);
  }

  return {
    opening,
    middle,
    closing,
    startMin: frameStart(opening, middle, closing, input),
  };
}

function frameStart(
  opening: Entry[],
  middle: Entry[],
  closing: Entry[],
  input: ComposeInput,
): number {
  const raw = frameStartRaw(opening, middle, closing, input);
  const baseStart = input.baseStart ?? PACES[input.pace].startMin;
  // 只要这一天还有「早上进得去」的点，出发就不该晚过 LATEST_START。
  // 原来几个分支是直接 return 的，封顶被绕过，于是仍会排出 11 点出门的一天。
  const morningPossible = [...opening, ...middle, ...closing].some((entry) =>
    entry.profile.windows.some(([start]) => start <= 10 * 60 + 30),
  );
  if (!morningPossible) return raw;
  return Math.min(raw, Math.max(baseStart, LATEST_START[input.pace]));
}

function frameStartRaw(
  opening: Entry[],
  middle: Entry[],
  closing: Entry[],
  input: ComposeInput,
): number {
  const baseStart = input.baseStart ?? PACES[input.pace].startMin;
  if (opening.some((entry) => entry.profile.sunrise)) {
    return Math.max(5 * 60, Math.min(baseStart, 6 * 60));
  }
  if (opening.some((entry) => entry.profile.marketMorning)) {
    return Math.min(
      baseStart,
      input.pace === "chill" ? 8 * 60 : 7 * 60 + 30,
    );
  }
  if (opening.some((entry) => entry.profile.gateway)) {
    return Math.min(baseStart, 7 * 60 + 30);
  }
  if (opening.some((entry) => entry.profile.morningOnly)) {
    return Math.max(7 * 60, Math.min(baseStart, 9 * 60));
  }
  const firstClosing = closing[0];
  if (!firstClosing) {
    const first = opening[0] ?? middle[0];
    return first
      ? startForFirst(first.profile, input.pace, baseStart)
      : baseStart;
  }
  // 植物园这类半天型大景，早上开门那段比午后更值钱：
  // 先走完大景再去接日落，别把四小时耗到天黑。
  const earlyLongStay = middle
    .filter((entry) => entry.profile.longStay)
    .flatMap((entry) => entry.profile.windows.map(([start]) => start))
    .filter((start) => start >= 8 * 60 && start <= 10 * 60);
  if (earlyLongStay.length) {
    return Math.max(baseStart, Math.min(...earlyLongStay));
  }
  // 收尾日如果中间有“上午十点前后才进入状态”的点（如厦大预约档），
  // 从那个窗口开始，比一律右对齐到傍晚更接近真实攻略。
  const morningish = middle
    .flatMap((entry) => entry.profile.windows.map(([start]) => start))
    .filter((start) => start >= 9 * 60 + 30 && start <= 11 * 60 + 30);
  if (morningish.length) {
    return Math.max(baseStart, Math.min(...morningish));
  }
  const prefix = advance(input.hotel, 0, 0, [...opening, ...middle], input);
  const pre =
    prefix.clock +
    rhythmTravelMinutes(prefix.prev, firstClosing.place, input);
  const aligned = Math.min(14 * 60 + 30, closingTarget(firstClosing) - pre);
  // 午饭是要花掉一小时的。围绕半天型大景（集美、植物园这类）排的收尾日，
// 右对齐出来的出发时间如果正好在饭点，得先把午饭扣出来，
// 否则午饭会把下午整体往后顶，主景一路拖到天黑，傍晚收尾就更晚了。
  const spansLunch =
    aligned >= 11 * 60 &&
    aligned < 13 * 60 &&
    middle.some((entry) => entry.profile.longStay);
  const mealReserve = spansLunch ? 60 + PACES[input.pace].bufferMin : 0;
  return Math.max(baseStart, aligned - mealReserve);
}

function orderMiddle(
  middle: Entry[],
  opening: Entry[],
  closing: Entry[],
  startMin: number,
  input: ComposeInput,
): Entry[] {
  if (middle.length <= 1) return [...middle];
  const buffer = PACES[input.pace].bufferMin;
  const prefix = advance(input.hotel, startMin, 0, opening, input);
  const n = middle.length;
  const beamLimit = n <= 7 ? Number.POSITIVE_INFINITY : 2400;

  let beams: ComposeState[] = [
    {
      order: [],
      prev: prefix.prev,
      clock: prefix.clock,
      score: prefix.score,
      used: new Set<string>(),
    },
  ];
  for (let depth = 0; depth < n; depth++) {
    const next: ComposeState[] = [];
    for (const state of beams) {
      for (const entry of middle) {
        if (state.used.has(entry.place.id)) continue;
        const minutes = rhythmTravelMinutes(state.prev, entry.place, input);
        const arrival = state.clock + minutes;
        next.push({
          order: [...state.order, entry],
          prev: entry.place,
          clock:
            arrival +
            rhythmDwell(entry.place, input.city, input.pace, input.styles) +
            buffer,
          score:
            state.score +
            placeDistance(state.prev, entry.place) * 0.22 +
            minutes * 0.01 +
            bandPenalty(entry.profile, arrival),
          used: new Set([...state.used, entry.place.id]),
        });
      }
    }
    next.sort((a, b) => a.score - b.score);
    beams = Number.isFinite(beamLimit) ? next.slice(0, beamLimit) : next;
  }

  let best: ComposeState | null = null;
  let bestTotal = Infinity;
  for (const state of beams) {
    if (state.order.length !== n) continue;
    const tail = advance(state.prev, state.clock, state.score, closing, input);
    const last = tail.prev;
    const backMinutes = rhythmTravelMinutes(last, input.hotel, input);
    const total =
      tail.score +
      placeDistance(last, input.hotel) * 0.22 +
      backMinutes * 0.01 +
      hardPenalty([...opening, ...state.order, ...closing]);
    if (total < bestTotal) {
      bestTotal = total;
      best = state;
    }
  }
  return best?.order ?? [...middle];
}

function buildOrder(
  entries: Entry[],
  input: ComposeInput,
): { order: Entry[]; startMin: number } {
  if (entries.length <= 1) {
    return {
      order: [...entries],
      startMin: entries[0]
        ? startForFirst(
            entries[0].profile,
            input.pace,
            input.baseStart ?? PACES[input.pace].startMin,
          )
        : input.baseStart ?? PACES[input.pace].startMin,
    };
  }
  const frame = buildFrame(entries, input);
  if (!frame.opening.length && !frame.closing.length) {
    const baseStart = input.baseStart ?? PACES[input.pace].startMin;
    // 原来的候选里固定带着 12:00 / 13:00 / 14:00，而评估只看「早到要等多久」，
    // 于是越晚出发分越高，最后排出一版 11 点出门的「充实」行程。
    // 只有整天都是日落/夜市型点位时，下午出门才成立。
    const lateOnly = entries.every(
      (entry) => entry.profile.sunset || entry.profile.nightStreet,
    );
    const candidates = new Set<number>([baseStart]);
    if (lateOnly) {
      candidates.add(12 * 60);
      candidates.add(13 * 60);
      candidates.add(14 * 60);
    }
    for (const entry of entries) {
      const open = entry.profile.windows[0]?.[0];
      if (open === undefined || open < 8 * 60) continue;
      // 点位开门晚可以顺着它推迟，但推到 LATEST_START 就封顶。
      if (lateOnly) {
        if (open <= 15 * 60) candidates.add(Math.max(baseStart, open));
      } else if (open <= LATEST_START[input.pace]) {
        candidates.add(open);
      }
    }
    let best: { order: Entry[]; startMin: number; total: number } | null =
      null;
    for (const startMin of candidates) {
      const result = plainSearch(entries, input, startMin);
      if (!best || result.total < best.total) {
        best = { order: result.order, startMin, total: result.total };
      }
    }
    return {
      order: best?.order ?? [...entries],
      startMin: best?.startMin ?? baseStart,
    };
  }
  const middle = orderMiddle(
    frame.middle,
    frame.opening,
    frame.closing,
    frame.startMin,
    input,
  );
  return {
    order: [...frame.opening, ...middle, ...frame.closing],
    startMin: frameStart(frame.opening, middle, frame.closing, input),
  };
}

export function composeDay(input: ComposeInput): ComposedDay {
  const entries: Entry[] = input.places.map((place) => ({
    place,
    profile: rhythmOf(input.city, place),
  }));
  if (!entries.length) {
    return {
      places: [],
      protectedIds: [],
      rhythm: {},
      warnings: [],
    };
  }
  if (input.fixed) {
    const summary = summarizeOrder(entries, input);
    return {
      places: input.places,
      ...summary,
      warnings: [],
    };
  }
  const built = buildOrder(entries, input);
  const summary = summarizeOrder(built.order, input, built.startMin);
  return {
    places: built.order.map((entry) => entry.place),
    ...summary,
  };
}

export interface DayNarrative {
  strategy: string;
  heroId?: string;
  heroName?: string;
  rhythm: DayRhythm;
}

function groupLabel(
  entries: Entry[],
  band: "early" | "morning" | "noon" | "afternoon" | "evening" | "night",
): string {
  const names = entries.map((entry) => entry.place.name);
  const hasSunrise = entries.some((entry) => entry.profile.sunrise);
  const hasSunset = entries.some((entry) => entry.profile.sunset);
  const market = entries.find((entry) => entry.profile.marketMorning);
  switch (band) {
    case "early":
      return hasSunrise
        ? `天没亮就出发，去${names.join("、")}看日出`
        : `一早去${names.join("、")}`;
    case "morning": {
      if (market) {
        const rest = names.filter((name) => name !== market.place.name);
        const tail = rest.length ? `，再去${rest.join("、")}` : "";
        return `早上去${market.place.name}吃早饭${tail}`;
      }
      return `上午去${names.join("、")}`;
    }
    case "noon": {
      const indoor = entries.some((entry) => entry.profile.indoor);
      return indoor
        ? `中午去${names.join("、")}避热`
        : `中午去${names.join("、")}`;
    }
    case "afternoon":
      return `午后去${names.join("、")}`;
    case "evening":
      return hasSunset
        ? `傍晚去${names.join("、")}看日落`
        : `傍晚去${names.join("、")}`;
    default:
      return `晚上去${names.join("、")}`;
  }
}

export function describeDay(
  stops: StopPlan[],
  city: string,
  pace: PaceId,
  heroId?: string,
): DayNarrative {
  const sights = stops.filter((stop) => stop.kind === "sight");
  const entries: Entry[] = sights.map((stop) => ({
    place: stop.place,
    profile: rhythmOf(city, stop.place),
  }));
  // 与选点阶段保持一致：夜市/短停不挂“主景”，否则白天的海景会被夜街盖掉。
  const hero = pickHero(entries, heroId);

  let indoorMidday = false;
  let sunrise = false;
  let sunset = false;
  let night = false;
  const groups = new Map<
    "early" | "morning" | "noon" | "afternoon" | "evening" | "night",
    Entry[]
  >();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const start = sights[index].startMin;
    if (entry.profile.indoor && start >= 11 * 60 && start <= 15 * 60 + 30) {
      indoorMidday = true;
    }
    if (entry.profile.sunrise && start < 8 * 60 + 30) sunrise = true;
    if (entry.profile.sunset && start >= 15 * 60) sunset = true;
    if (entry.profile.nightStreet && start >= 17 * 60) night = true;
    const band =
      start < 7 * 60 + 30
        ? "early"
        : start < 11 * 60
          ? "morning"
          : start < 13 * 60 + 30
            ? "noon"
            : start < 16 * 60 + 30
              ? "afternoon"
              : start < 18 * 60 + 30
                ? "evening"
                : "night";
    const list = groups.get(band) ?? [];
    list.push(entry);
    groups.set(band, list);
  }

  const order = [
    "early",
    "morning",
    "noon",
    "afternoon",
    "evening",
    "night",
  ] as const;
  const segments = order
    .filter((band) => groups.get(band)?.length)
    .map((band) => groupLabel(groups.get(band) as Entry[], band));

  const firstStart = sights[0]?.startMin;
  return {
    strategy: segments.length
      ? segments.join(" → ")
      : "今天留白，睡到自然醒，在酒店附近随意走走。",
    heroId: hero?.place.id,
    heroName: hero?.place.name,
    rhythm: {
      sunrise: sunrise || undefined,
      sunset: sunset || undefined,
      early:
        Boolean(sunrise) ||
        Boolean(
          firstStart !== undefined && firstStart < PACES[pace].startMin - 15,
        ) ||
        Boolean(entries.some((entry) => entry.profile.marketMorning)) ||
        undefined,
      night: night || undefined,
      indoorMidday: indoorMidday || undefined,
    },
  };
}