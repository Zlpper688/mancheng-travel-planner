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
import type {
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
import type { DaySeed } from "./select";

type MealSlot = "lunch" | "dinner" | "cafe";

interface StopSeed {
  place: Place;
  kind: StopKind;
  fixed: boolean;
  slot?: MealSlot;
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
  startMin: number;
}

export interface ScheduleInput
  extends Omit<BuildContext, "far" | "startMin"> {
  seedDay: DaySeed;
  usedMealIds: Set<string>;
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
}

const MODES: TransportMode[] = ["walk", "transit", "taxi"];
const LUNCH_START = 11 * 60;
const DINNER_START = 17 * 60;

function kindOf(place: Place): StopKind {
  if (place.category === "food") return "meal";
  if (place.category === "cafe") return "cafe";
  return "sight";
}

export function pickTransportMode(
  from: Place,
  to: Place,
  pref: TransportPref,
  styles: StyleId[],
): TransportMode {
  const crossing =
    Boolean(from.island || to.island) && from.island !== to.island;
  if (crossing) return "transit";
  const km = placeDistance(from, to);
  const citywalk = styles.includes("citywalk");
  const family = styles.includes("family");
  if (pref === "walk") {
    if (km <= 2.4 || (citywalk && km <= 3.2)) return "walk";
    if (km <= 12) return "transit";
    return "taxi";
  }
  if (pref === "transit") {
    if (km <= 0.9) return "walk";
    if (km <= 18) return "transit";
    return "taxi";
  }
  if (pref === "drive") {
    if (km <= 0.9) return "walk";
    return "taxi";
  }
  if (km <= 1.2) return "walk";
  if (km <= 2.2 && (citywalk || family)) return "walk";
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
): number {
  if (kind === "meal") return roundToFive(Math.max(55, 60 * PACES[pace].dwellScale));
  if (kind === "cafe") return roundToFive(35 * PACES[pace].dwellScale);
  const base = CATEGORY_DWELL[place.category] || 50;
  let minutes = base * PACES[pace].dwellScale;
  if (styles.includes("culture") && ["museum", "temple", "attraction"].includes(place.category)) {
    minutes *= 1.15;
  }
  if (styles.includes("coastal") && ["beach", "viewpoint", "park"].includes(place.category)) {
    minutes *= 1.1;
  }
  if (styles.includes("family") && ["museum", "attraction", "park"].includes(place.category)) {
    minutes *= 1.1;
  }
  if (styles.includes("foodie") && ["market", "street"].includes(place.category)) {
    minutes *= 1.05;
  }
  minutes *= 1 + (crowd - 1) * 0.35;
  return Math.max(20, roundToFive(minutes));
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

function roughTimeline(
  places: Place[],
  hotel: Place,
  startMin: number,
  pace: PaceId,
  transport: TransportPref,
  styles: StyleId[],
  crowd: number,
): { arrive: number; end: number }[] {
  let clock = startMin;
  let previous = hotel;
  const result: { arrive: number; end: number }[] = [];
  for (const place of places) {
    const mode = pickTransportMode(previous, place, transport, styles);
    const travel = adjustDuration(
      estimateModeMinutes(previous, place, mode),
      mode,
      crowd,
    );
    const arrive = clock + travel;
    const dwell = dwellFor(place, "sight", pace, styles, crowd);
    result.push({ arrive, end: arrive + dwell });
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
): number {
  const distance = placeDistance(place, target);
  let score = (place.popularity ?? 3.4) * 1.2 - distance * 1.7;
  const tags = `${(place.tags ?? []).join(" ")} ${place.name}`;
  if (/cluster|小吃|排档|老字号/.test(tags)) score += 0.45;
  if (/local|本地/.test(tags)) score += 0.3;
  if (styles.includes("foodie")) score += 0.8;
  if (kind === "cafe" && place.category !== "cafe") score -= 4;
  if (kind !== "cafe" && place.category === "cafe") score -= 3;
  if (place.island && target.island !== place.island) score -= 3;
  if (!place.island && target.island) score -= 3;
  return score;
}

function chooseMeal(
  candidates: Place[],
  used: Set<string>,
  target: Place,
  kind: StopKind,
  styles: StyleId[],
  maxKm: number,
): Place | null {
  const pool = candidates.filter(
    (place) =>
      !used.has(place.id) &&
      (kind === "cafe" ? place.category === "cafe" : place.category === "food"),
  );
  const pick = (limit: number) => {
    let best: Place | null = null;
    let bestScore = -Infinity;
    for (const place of pool) {
      const distance = placeDistance(place, target);
      if (distance > limit) continue;
      const score = mealScore(place, target, styles, kind);
      if (score > bestScore) {
        best = place;
        bestScore = score;
      }
    }
    return best;
  };
  return pick(maxKm) ?? pick(maxKm * 1.8);
}

function insertMeals(
  sights: StopSeed[],
  options: { lunch: boolean; dinner: boolean; cafe: boolean },
  context: BuildContext,
  used: Set<string>,
): { stops: StopSeed[]; warnings: string[] } {
  if (!sights.length) return { stops: sights, warnings: [] };
  const warnings: string[] = [];
  const rough = roughTimeline(
    sights.map((stop) => stop.place),
    context.hotel,
    context.startMin,
    context.pace,
    context.transport,
    context.styles,
    context.crowd,
  );

  let lunchIndex = sights.length;
  if (options.lunch) {
    const found = rough.findIndex((item) => item.arrive >= LUNCH_START + 15);
    if (found >= 0) lunchIndex = found;
  }
  let cafeIndex = sights.length;
  if (options.cafe) {
    const found = rough.findIndex((item) => item.arrive >= 14 * 60 + 30);
    cafeIndex = found >= 0 ? Math.max(found, Math.min(sights.length, lunchIndex + 1)) : sights.length;
  }

  const insertions: { index: number; order: number; seed: StopSeed }[] = [];
  const foodPlaces = context.meals.filter((place) => place.category === "food");
  const cafePlaces = context.meals.filter((place) => place.category === "cafe");

  if (options.lunch) {
    const target = midpointTarget(sights, lunchIndex, context.hotel);
    const meal = chooseMeal(foodPlaces, used, target, "meal", context.styles, 2.8);
    if (meal) {
      used.add(meal.id);
      insertions.push({
        index: lunchIndex,
        order: 0,
        seed: { place: meal, kind: "meal", fixed: false, slot: "lunch" },
      });
    } else {
      warnings.push("附近没有合适的午餐点，午饭时间留给你随走随吃。");
    }
  }

  if (options.cafe) {
    const target = midpointTarget(sights, cafeIndex, context.hotel);
    const cafe = chooseMeal(cafePlaces, used, target, "cafe", context.styles, 2.2);
    if (cafe) {
      used.add(cafe.id);
      insertions.push({
        index: cafeIndex,
        order: 1,
        seed: { place: cafe, kind: "cafe", fixed: false, slot: "cafe" },
      });
    }
  }

  if (options.dinner) {
    const last = sights[sights.length - 1]?.place ?? context.hotel;
    const lastRough = rough[rough.length - 1];
    const target = !lastRough || lastRough.end < 16 * 60 ? context.hotel : last;
    const dinner = chooseMeal(foodPlaces, used, target, "meal", context.styles, 3.6);
    if (dinner) {
      used.add(dinner.id);
      insertions.push({
        index: sights.length,
        order: 2,
        seed: { place: dinner, kind: "meal", fixed: false, slot: "dinner" },
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
  return { stops: result, warnings };
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
    note: "路线为估算",
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
    const distanceKm = Math.max(
      0.05,
      estimateRouteDistanceKm([from.lng, from.lat], [to.lng, to.lat]),
    );
    const estimatedMinutes =
      estimateModeMinutes(from, to, candidate) + (candidate === "taxi" ? 2 : 0);
    return {
      mode: candidate,
      durationMin: adjustDuration(estimatedMinutes, candidate, crowd),
      distanceKm,
      cost:
        candidate === "walk"
          ? 0
          : candidate === "transit"
            ? estimateTransitFare(distanceKm)
            : estimateTaxiFare(distanceKm, getTaxiRate(city)),
      costUnit: candidate === "taxi" ? "vehicle" : "person",
      estimated: true,
      note: crossing
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
    };
  }

  const hasMeal = sightStops.some((stop) => stop.kind === "meal");
  const hasCafe = sightStops.some((stop) => stop.kind === "cafe");
  const { stops: ordered, warnings: mealWarnings } = insertMeals(
    sightStops,
    {
      lunch: !hasMeal,
      dinner: !hasMeal,
      cafe: !hasCafe && context.pace !== "packed" && sightStops.length >= 2,
    },
    context,
    used,
  );
  warnings.push(...mealWarnings);

  const nodes = [context.hotel, ...ordered.map((stop) => stop.place), context.hotel];
  const modes: TransportMode[] = [];
  for (let index = 1; index < nodes.length; index++) {
    modes.push(
      pickTransportMode(nodes[index - 1], nodes[index], context.transport, context.styles),
    );
  }

  const routes = await mapLimit(modes, 4, (mode, index) =>
    safeRoute(context.provider, nodes[index], nodes[index + 1], mode, context.city),
  );

  let clock = context.startMin;
  let previous = context.hotel;
  const stops: StopPlan[] = [];
  const legs: RouteLeg[] = [];

  for (let index = 0; index < ordered.length; index++) {
    const stop = ordered[index];
    const mode = modes[index];
    const route = routes[index];
    const departMin = Math.ceil(clock / 5) * 5;
    const leg = makeLeg(index, previous, stop.place, mode, route, departMin, context.crowd, context.city);
    let arriveMin = leg.arriveMin;
    const rawDwell = dwellFor(stop.place, stop.kind, context.pace, context.styles, context.crowd);
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
    }

    const startMin = Math.ceil((arriveMin + wait) / 5) * 5;
    const endMin = startMin + dwell;
    const notes = [stop.place.note, openNote].filter(Boolean) as string[];
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
    if (stop.kind === "sight") {
      const buffer = roundToFive(
        PACES[context.pace].bufferMin *
          (stop.fixed ? 0.55 : 1) *
          (1 + (context.crowd - 1) * 0.4),
      );
      clock += Math.max(0, buffer);
    }
    previous = stop.place;
  }

  const finalIndex = ordered.length;
  const finalDepart = Math.ceil(clock / 5) * 5;
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

  const endMin = returnLeg.arriveMin;
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

  const names = stops.map((stop) => stop.place.name).join(" ");
  const tips: string[] = [];
  if (context.far) {
    tips.push(
      context.startMin < PACES[context.pace].startMin
        ? "今天是远足日，路上时间较长，早点出发，回程留点余量。"
        : "今天是远足日，景点集中在另一片城区，按这条线走不用来回折返。",
    );
  }
  if (names.includes("厦门大学")) {
    tips.push("厦门大学需要提前预约，进校记得带身份证。");
  }
  if (legs.some((leg) => /轮渡|候船|跨海/.test(`${leg.note ?? ""}`))) {
    tips.push("今天要坐轮渡，末班船时间出发前再确认一下。");
  }
  if (stats.walkKm >= 5) {
    tips.push("今天步行不少，穿一双好走的鞋。");
  }
  if (endMin > 21 * 60) {
    tips.push("回到酒店会比较晚，晚饭别拖太晚。");
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

  return {
    stops,
    legs,
    startMin: legs[0]?.departMin ?? PACES[context.pace].startMin,
    endMin,
    stats,
    warnings,
    tip: tips.slice(0, 2).join(" "),
  };
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
    startMin: PACES[input.pace].startMin - (farLong ? 30 : 0),
  };
  const localUsed = new Set(input.usedMealIds);

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
  let last: BuiltDay | null = null;
  const anchorIds = new Set(input.seedDay.anchorIds ?? []);
  const maxDrops = input.seedDay.fixed ? 0 : 2;
  const endLimit = PACES[input.pace].endMin + (farLong ? 75 : 0);

  for (let drop = 0; drop <= maxDrops; drop++) {
    last = await buildOnce(attempt, context, localUsed);
    const overrun = last.endMin - endLimit;
    if (overrun <= 75) break;
    if (drop === maxDrops) {
      warnings.push(`今日行程比较满，回到酒店约 ${minutesToTime(last.endMin)}。`);
      break;
    }
    const sights = attempt.filter(
      (stop) => stop.kind === "sight" && !stop.fixed,
    );
    const droppable = sights.some((stop) => !anchorIds.has(stop.place.id))
      ? sights.filter((stop) => !anchorIds.has(stop.place.id))
      : sights;
    if (!droppable.length) {
      warnings.push(`今日行程比较满，回到酒店约 ${minutesToTime(last.endMin)}。`);
      break;
    }
    const victim = droppable[droppable.length - 1];
    attempt = attempt.filter((stop) => stop !== victim);
    warnings.push(`为了不赶路，今天略过了「${victim.place.name}」。`);
  }

  localUsed.forEach((id) => input.usedMealIds.add(id));
  const built = last as BuiltDay;

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
    far,
  };

  return {
    plan,
    warnings: Array.from(new Set([...warnings, ...built.warnings])),
  };
}
