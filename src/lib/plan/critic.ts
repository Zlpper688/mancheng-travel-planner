import { PACES } from "../constants";
import { angleDistance, bearing } from "../geo";
import type { DayPlan, PaceId, Place, RouteLeg, StopPlan, StyleId } from "../types";
import {
  DAY_ARCHETYPE_LABELS,
  EXPERIENCE_LABELS,
  dayArchetypeOf,
  experienceOf,
  isHumanitiesPlace,
  isIndoorPlace,
  type DayArchetypeId,
  type ExperienceId,
} from "./archetype";

export type PhenomenonId =
  | "rush"
  | "backtrack"
  | "exposure"
  | "fatigue"
  | "monotony"
  | "gap"
  | "meal-late"
  | "late-end"
  | "long-day"
  | "style-gap"
  | "day-monotony"
  | "trip-humanities";

export type Severity = "high" | "medium" | "low";

export interface PlanPhenomenon {
  id: PhenomenonId;
  severity: Severity;
  day: number;
  title: string;
  detail: string;
  suggestion: string;
  metric?: number;
}

export interface DayCritique {
  day: number;
  archetype: DayArchetypeId;
  sightCount: number;
  travelRatio: number;
  outdoorMiddayMin: number;
  score: number;
  phenomena: PlanPhenomenon[];
}

export interface PlanCritique {
  score: number;
  phenomena: PlanPhenomenon[];
  days: DayCritique[];
  summary: string;
}

export interface CriticContext {
  pace: PaceId;
  family: boolean;
  styles: StyleId[];
}

const PENALTY: Record<Severity, number> = {
  high: 10,
  medium: 5,
  low: 2,
};

function sightStops(day: DayPlan): StopPlan[] {
  return day.stops.filter((stop) => stop.kind === "sight");
}

function overlap(
  stop: StopPlan,
  startMin: number,
  endMin: number,
): number {
  return Math.max(
    0,
    Math.min(stop.endMin, endMin) - Math.max(stop.startMin, startMin),
  );
}

function legBetween(
  day: DayPlan,
  from: StopPlan,
  to: StopPlan,
): RouteLeg | undefined {
  return day.legs.find(
    (leg) => leg.fromName === from.place.name && leg.toName === to.place.name,
  );
}

function minutesLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return hours ? `${hours} 小时 ${rest} 分` : `${rest} 分钟`;
}

function timeLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function placesText(places: Place[], limit = 3): string {
  const names = places.slice(0, limit).map((place) => place.name);
  return `${names.join("、")}${places.length > limit ? ` 等 ${places.length} 个` : ""}`;
}

function styleGapPhenomena(
  days: DayPlan[],
  context: CriticContext,
): PlanPhenomenon[] {
  const sights = days.flatMap((day) =>
    sightStops(day).map((stop) => stop.place),
  );
  const allPlaces = days.flatMap((day) =>
    day.stops.map((stop) => stop.place),
  );
  if (!sights.length) return [];

  const text = (place: Place) =>
    `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")} ${place.address ?? ""}`;
  const hasSight = (test: (place: Place) => boolean) => sights.some(test);
  const hasAny = (test: (place: Place) => boolean) => allPlaces.some(test);
  const result: PlanPhenomenon[] = [];

  if (
    context.styles.includes("coastal") &&
    !hasSight(
      (place) =>
        place.category === "beach" ||
        /coast|海|沙滩|湾|岛/i.test(text(place)),
    )
  ) {
    result.push({
      id: "style-gap",
      severity: "medium",
      day: 0,
      title: "选了海岸风格，但路线里没有海",
      detail: "整趟没有任何沙滩、海岸线或临海点位。",
      suggestion: "至少安排 1 个海边点位，或把一天改成海岸日。",
    });
  }

  if (
    context.styles.includes("foodie") &&
    !hasAny((place) =>
      ["food", "cafe", "market"].includes(place.category),
    )
  ) {
    result.push({
      id: "style-gap",
      severity: "medium",
      day: 0,
      title: "选了寻味风格，但没有吃的点位",
      detail: "整趟没有市场、小吃街或咖啡馆。",
      suggestion: "把一个普通景点换成市场或老街，并把饭点留给本地小店。",
    });
  }

  if (
    context.styles.includes("citywalk") &&
    !hasAny(
      (place) =>
        place.category === "street" ||
        /citywalk|街|巷/i.test(text(place)),
    )
  ) {
    result.push({
      id: "style-gap",
      severity: "low",
      day: 0,
      title: "选了城市漫步，但都在景点里",
      detail: "整趟没有可连续走起来的街区。",
      suggestion: "安排半天街区路线，减少一次跨区移动。",
    });
  }

  if (
    context.styles.includes("family") &&
    !hasAny(
      (place) =>
        /family|亲子/i.test(text(place)) ||
        ["park", "beach", "museum"].includes(place.category),
    )
  ) {
    result.push({
      id: "style-gap",
      severity: "medium",
      day: 0,
      title: "亲子出行，但缺少孩子能玩的点",
      detail: "整趟没有公园、沙滩或室内亲子馆。",
      suggestion: "用公园、沙滩或博物馆替换一个人文点。",
    });
  }

  return result;
}

function tripPhenomena(days: DayPlan[]): PlanPhenomenon[] {
  const result: PlanPhenomenon[] = [];
  const sights = days.flatMap((day) => sightStops(day));
  if (!sights.length) return result;

  const humanities = sights.filter((stop) =>
    isHumanitiesPlace(stop.place),
  );
  const humanityRatio = humanities.length / sights.length;
  if (sights.length >= 8 && humanityRatio >= 0.5) {
    result.push({
      id: "trip-humanities",
      severity: "medium",
      day: 0,
      title: "整趟人文历史偏重",
      detail: `${sights.length} 个景点里 ${humanities.length} 个是人文历史类：${placesText(humanities.map((stop) => stop.place))}。`,
      suggestion: "保留大景点作锚点，至少换进 1 个海边、自然或市场体验。",
      metric: Math.round(humanityRatio * 100),
    });
  }

  let previous: DayArchetypeId | null = null;
  for (const day of days) {
    const current = dayArchetypeOf(day);
    if (
      previous &&
      current === previous &&
      current !== "mixed" &&
      current !== "island"
    ) {
      result.push({
        id: "day-monotony",
        severity: "low",
        day: day.index,
        title: "连续两天是同一种日型",
        detail: `第 ${day.index - 1} 天和第 ${day.index} 天主型都是「${DAY_ARCHETYPE_LABELS[current]}」。`,
        suggestion: "把其中一天换成海岸、自然或街区日，拉开体验差异。",
      });
    }
    previous = current;
  }

  return result;
}

function dayPhenomena(
  day: DayPlan,
  context: CriticContext,
): PlanPhenomenon[] {
  const result: PlanPhenomenon[] = [];
  const sights = sightStops(day);
  const capacity = PACES[context.pace].sights;
  const dayLength = Math.max(1, day.endMin - day.startMin);
  const travelRatio = day.stats.travelMin / dayLength;
  const avgDwell = sights.length
    ? Math.round(
        sights.reduce((total, stop) => total + stop.dwellMin, 0) /
          sights.length,
      )
    : 0;
  const overCapacity = sights.length > capacity + 1;
  const thinDwell =
    sights.length >= 3 && avgDwell < (context.pace === "packed" ? 40 : 48);
  const travelHeavy = sights.length >= 3 && travelRatio > 0.35;

  if (overCapacity || thinDwell || travelHeavy) {
    result.push({
      id: "rush",
      severity: overCapacity || travelRatio > 0.45 ? "high" : "medium",
      day: day.index,
      title: "这一天排得太赶",
      detail: `${sights.length} 个景点，容量约 ${capacity} 个；路上占 ${Math.round(travelRatio * 100)}%，平均停留 ${avgDwell} 分钟。`,
      suggestion: "减 1–2 个点，或把其中一个换成同片区的短体验。",
      metric: Math.round(travelRatio * 100),
    });
  }

  const experiences = new Map<ExperienceId, Place[]>();
  for (const stop of sights) {
    const id = experienceOf(stop.place);
    const list = experiences.get(id) ?? [];
    list.push(stop.place);
    experiences.set(id, list);
  }

  for (const [id, places] of experiences) {
    if (id === "mixed" || id === "culture") continue;
    if (places.length >= 3) {
      result.push({
        id: "monotony",
        severity: "medium",
        day: day.index,
        title: `一天里重复了 ${places.length} 个${EXPERIENCE_LABELS[id]}点`,
        detail: placesText(places, 4),
        suggestion: "保留 2 个，换一个不同体验类型的点。",
        metric: places.length,
      });
    }
  }

  if (sights.length >= 2) {
    let reversals = 0;
    for (let index = 1; index < sights.length - 1; index++) {
      const previous = sights[index - 1].place;
      const current = sights[index].place;
      const next = sights[index + 1].place;
      const first = bearing(
        [previous.lng, previous.lat],
        [current.lng, current.lat],
      );
      const second = bearing(
        [current.lng, current.lat],
        [next.lng, next.lat],
      );
      if (angleDistance(first, second) > 120) reversals += 1;
    }

    let routeKm = 0;
    let envelopeKm = 0;
    for (let index = 0; index < sights.length - 1; index++) {
      const leg = legBetween(day, sights[index], sights[index + 1]);
      routeKm += leg?.distanceKm ?? 0;
    }
    for (let left = 0; left < sights.length; left++) {
      for (let right = left + 1; right < sights.length; right++) {
        const a = sights[left].place;
        const b = sights[right].place;
        const km = Math.hypot(
          (a.lng - b.lng) * 101.5 * Math.cos((a.lat * Math.PI) / 180),
          (a.lat - b.lat) * 111,
        );
        envelopeKm = Math.max(envelopeKm, km);
      }
    }
    const routeRatio = envelopeKm > 0 ? routeKm / envelopeKm : 0;

    if (
      (reversals >= 2 && routeKm > 5) ||
      (routeKm > 8 && routeRatio > 2.2)
    ) {
      result.push({
        id: "backtrack",
        severity: "medium",
        day: day.index,
        title: "路线来回折返",
        detail: `方向反转 ${reversals} 次，景点间路程 ${routeKm.toFixed(1)} km，约是最远两点距离的 ${routeRatio.toFixed(1)} 倍。`,
        suggestion: "按同一方向重排，或把其中一个点换到另一天。",
        metric: Math.round(routeRatio * 10) / 10,
      });
    }
  }

  let outdoorMinutes = 0;
  let outdoorMiddayMin = 0;
  let rainOutdoorMin = 0;
  for (const stop of sights) {
    const minutes = stop.dwellMin;
    if (isIndoorPlace(stop.place)) continue;
    outdoorMinutes += minutes;
    outdoorMiddayMin += overlap(stop, 11 * 60, 15 * 60);
    for (const window of day.weather?.rainWindows ?? []) {
      if (window.mm < 1) continue;
      rainOutdoorMin += overlap(stop, window.startMin, window.endMin);
    }
  }
  const sightMinutes = sights.reduce(
    (total, stop) => total + stop.dwellMin,
    0,
  );
  const outdoorShare = sightMinutes ? outdoorMinutes / sightMinutes : 0;

  if (rainOutdoorMin >= 20) {
    result.push({
      id: "exposure",
      severity: day.weather?.estimated ? "medium" : "high",
      day: day.index,
      title: "降雨时段撞上了户外点",
      detail: `户外点位与降雨窗口重叠约 ${rainOutdoorMin} 分钟${day.weather?.estimated ? "（按历史气候估算，出发前再核对）" : ""}。`,
      suggestion: "把室内点挪到降雨时段，或把户外点换到当天另一侧。",
      metric: rainOutdoorMin,
    });
  } else if (
    (day.weather?.tMax ?? 0) >= 32 &&
    outdoorMiddayMin >= 60
  ) {
    result.push({
      id: "exposure",
      severity: "medium",
      day: day.index,
      title: "正午在户外暴晒",
      detail: `最高 ${day.weather?.tMax}°C，11–15 点户外停留约 ${outdoorMiddayMin} 分钟。`,
      suggestion: "把博物馆、咖啡馆或商场挪到正午，户外点放早晚。",
      metric: outdoorMiddayMin,
    });
  } else if (
    (day.weather?.precipProb ?? 0) >= 60 &&
    outdoorShare >= 0.6
  ) {
    result.push({
      id: "exposure",
      severity: "medium",
      day: day.index,
      title: "雨天户外占比偏高",
      detail: `降雨概率 ${day.weather?.precipProb}%，户外停留占 ${Math.round(outdoorShare * 100)}%。`,
      suggestion: "准备一个同片区的室内备选，或把户外点前移。",
      metric: Math.round(outdoorShare * 100),
    });
  }

  const walkLimit = context.family ? 6.5 : 9;
  const lengthLimit = context.family ? 11 * 60 : 13 * 60;
  const walkKm = day.stats.walkKm;
  if (walkKm > walkLimit + 0.5) {
    result.push({
      id: "fatigue",
      severity: walkKm > walkLimit + 3 ? "high" : "medium",
      day: day.index,
      title: "这一天的步行量偏大",
      detail: `${context.family ? "带娃" : "成人"}步行 ${walkKm.toFixed(1)} km，超过 ${walkLimit} km 的舒适线。`,
      suggestion: "减少步行段，或把午后留出来回住处休息。",
      metric: Math.round(walkKm * 10) / 10,
    });
  }
  if (dayLength > lengthLimit) {
    result.push({
      id: "long-day",
      severity: dayLength > lengthLimit + 90 ? "high" : "medium",
      day: day.index,
      title: "这一天在外太久",
      detail: `从 ${timeLabel(day.startMin)} 到 ${timeLabel(day.endMin)}，共 ${minutesLabel(dayLength)}。`,
      suggestion: context.family
        ? "带娃压缩到 11 小时以内，中间回住处或找个咖啡馆歇一段。"
        : "砍掉一个边缘点位，或把晚饭后的安排换成酒店附近的散步。",
      metric: Math.round((dayLength / 60) * 10) / 10,
    });
  }

  for (let index = 0; index < day.stops.length - 1; index++) {
    const previous = day.stops[index];
    const next = day.stops[index + 1];
    const gap = next.startMin - previous.endMin;
    if (gap <= 0) continue;
    const leg = legBetween(day, previous, next);
    const wait = gap - (leg?.durationMin ?? 0);
    const threshold =
      previous.kind === "meal" || next.kind === "meal" ? 75 : 50;
    if (wait > threshold) {
      const sunsetWait =
        wait <= 90 &&
        next.kind === "sight" &&
        next.startMin >= 16 * 60 + 30 &&
        next.startMin <= 19 * 60 + 30 &&
        !isIndoorPlace(next.place);
      result.push({
        id: "gap",
        severity: sunsetWait ? "low" : wait > 90 ? "medium" : "low",
        day: day.index,
        title: sunsetWait ? "留了一段等日落的时间" : "中间空了一段",
        detail: sunsetWait
          ? `${previous.place.name} 结束后，到 ${next.place.name} 开始还有约 ${Math.round(wait)} 分钟，像是为日落留的空档。`
          : `${previous.place.name} 结束后，到 ${next.place.name} 开始，中间约 ${Math.round(wait)} 分钟没有安排。`,
        suggestion: sunsetWait
          ? "不想干等的话，可以在附近补一个咖啡馆或街区；刻意留白也合理。"
          : "在附近补一个咖啡、市场或街区，或把下一个点提前。",
        metric: Math.round(wait),
      });
    }
  }

  for (const stop of day.stops) {
    if (stop.kind !== "meal" || !stop.slot) continue;
    if (stop.slot === "lunch" && stop.startMin > 13 * 60 + 30) {
      result.push({
        id: "meal-late",
        severity: stop.startMin > 14 * 60 + 30 ? "high" : "medium",
        day: day.index,
        title: "午饭偏晚",
        detail: `午饭从 ${timeLabel(stop.startMin)} 才开始。`,
        suggestion: "把上午的点减一个，或把午饭锚点前移。",
        metric: stop.startMin - 13 * 60 - 30,
      });
    }
    if (stop.slot === "dinner" && stop.startMin > 20 * 60) {
      result.push({
        id: "meal-late",
        severity: stop.startMin > 21 * 60 ? "high" : "medium",
        day: day.index,
        title: "晚饭偏晚",
        detail: `晚饭从 ${timeLabel(stop.startMin)} 才开始。`,
        suggestion: "把傍晚的点提前，或把晚饭放到酒店附近。",
        metric: stop.startMin - 20 * 60,
      });
    }
  }

  const endLimit = context.family ? 21 * 60 + 30 : 23 * 60;
  if (day.endMin > endLimit) {
    result.push({
      id: "late-end",
      severity: day.endMin > endLimit + 60 ? "high" : "medium",
      day: day.index,
      title: "收尾偏晚",
      detail: `这一天到 ${timeLabel(day.endMin)} 才结束。`,
      suggestion: context.family
        ? "带娃尽量 21:30 前回住处，砍掉一个夜间点。"
        : "把最后一个点前移，或把夜游换成离酒店更近的收尾。",
      metric: day.endMin - endLimit,
    });
  }

  return result;
}

function scoreOf(phenomena: PlanPhenomenon[]): number {
  const penalty = phenomena.reduce(
    (total, item) => total + PENALTY[item.severity],
    0,
  );
  return Math.max(0, 100 - penalty);
}

export function critiquePlan(
  days: DayPlan[],
  context: CriticContext,
): PlanCritique {
  const phenomena: PlanPhenomenon[] = [];
  const dayCritiques: DayCritique[] = [];

  for (const day of days) {
    const items = dayPhenomena(day, context);
    phenomena.push(...items);
    const sights = sightStops(day);
    const length = Math.max(1, day.endMin - day.startMin);
    let outdoorMiddayMin = 0;
    for (const stop of sights) {
      if (isIndoorPlace(stop.place)) continue;
      outdoorMiddayMin += overlap(stop, 11 * 60, 15 * 60);
    }
    dayCritiques.push({
      day: day.index,
      archetype: dayArchetypeOf(day),
      sightCount: sights.length,
      travelRatio: Math.round((day.stats.travelMin / length) * 100),
      outdoorMiddayMin,
      score: scoreOf(items),
      phenomena: items,
    });
  }

  phenomena.push(...styleGapPhenomena(days, context));
  phenomena.push(...tripPhenomena(days));

  const high = phenomena.filter((item) => item.severity === "high").length;
  const medium = phenomena.filter((item) => item.severity === "medium").length;
  const low = phenomena.filter((item) => item.severity === "low").length;
  const summary = phenomena.length
    ? `发现 ${phenomena.length} 个现象：${high ? `${high} 个高优先、` : ""}${medium ? `${medium} 个中优先、` : ""}${low ? `${low} 个提示` : ""}`.replace(/、$/, "")
    : "没有发现明显的排坏现象。";

  return {
    score: scoreOf(phenomena),
    phenomena,
    days: dayCritiques,
    summary,
  };
}