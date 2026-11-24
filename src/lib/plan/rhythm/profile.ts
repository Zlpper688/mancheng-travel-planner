import { CATEGORY_DWELL, PACES } from "../../constants";
import { estimateModeMinutes, placeDistance, roundToFive } from "../../geo";
import { findPlaceProfile } from "../../tips/lookup";
import { usableMetroTrip } from "../../transit/metro";
import type { Category, PaceId, Place, StyleId, TransportPref } from "../../types";

export interface TravelContext {
  city: string;
  styles: StyleId[];
  transport: TransportPref;
}

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
    (/晚上|夜晚|亮灯|夜市/.test(profile?.bestTime ?? "") &&
      (place.category === "street" || place.category === "market")) ||
    /步行街|夜市/.test(place.name);
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
  const earlyBoat = /上岛|船票|轮渡/.test(
    `${place.name} ${place.note ?? ""} ${profile?.bestTime ?? ""} ${profile?.booking ?? ""}`,
  );
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
  input: TravelContext,
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

export function startForFirst(
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
    if (best >= 10 * 60 + 30) return Math.max(baseStart, 10 * 60 + 45);
  }
  return baseStart;
}

export function bandPenalty(profile: RhythmProfile, arrivalMin: number): number {
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

