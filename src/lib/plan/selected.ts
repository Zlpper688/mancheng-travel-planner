import { PACES } from "../constants";
import { placeDistance } from "../geo";
import type { Category, FixedPlace, PaceId, Place } from "../types";

const SELECTABLE: ReadonlySet<Category> = new Set<Category>([
  "attraction",
  "museum",
  "park",
  "viewpoint",
  "beach",
  "street",
  "temple",
  "market",
  "nature",
]);

const GROUP_RADIUS_KM = 4.2;
const FAR_NOTICE_KM = 25;

interface DistributeInput {
  days: number;
  pace: PaceId;
  hotel: Place;
  fixedPlaces?: FixedPlace[];
}

export interface SelectedDistribution {
  fixedPlaces: FixedPlace[];
  warnings: string[];
  selectedDays: number;
}

function samePlace(a: Place, b: Place): boolean {
  if (a.id === b.id) return true;
  return (
    placeDistance(a, b) < 0.25 &&
    (a.name.includes(b.name) || b.name.includes(a.name))
  );
}

function clusterSelected(places: Place[], dayCap: number): Place[][] {
  const groups: Place[][] = [];
  for (const place of places) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    groups.forEach((group, index) => {
      if (group.length >= dayCap) return;
      const islandConflict = group.some(
        (item) =>
          item.island !== place.island && Boolean(item.island || place.island),
      );
      if (islandConflict) return;
      const nearest = Math.min(
        ...group.map((item) => placeDistance(item, place)),
      );
      if (nearest <= GROUP_RADIUS_KM && nearest < bestDistance) {
        bestIndex = index;
        bestDistance = nearest;
      }
    });
    if (bestIndex >= 0) {
      groups[bestIndex].push(place);
    } else {
      groups.push([place]);
    }
  }
  return groups;
}

function groupDistance(a: Place[], b: Place[]): number {
  let min = Infinity;
  for (const left of a) {
    for (const right of b) {
      const distance = placeDistance(left, right);
      if (distance < min) min = distance;
    }
  }
  return min;
}

/** 片区多于天数时，优先合并地理上最近的片区，避免把两个远郊拼进同一天。 */
function mergeClosestGroups(groups: Place[][], target: number): Place[][] {
  const merged = groups.map((group) => [...group]);
  while (merged.length > target) {
    let bestI = 0;
    let bestJ = 1;
    let best = Infinity;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const distance = groupDistance(merged[i], merged[j]);
        if (distance < best) {
          best = distance;
          bestI = i;
          bestJ = j;
        }
      }
    }
    merged[bestI] = [...merged[bestI], ...merged[bestJ]];
    merged.splice(bestJ, 1);
  }
  return merged;
}

/** 合并后某天超出容量时，把离目标片区最近的点位移过去，避免一天塞到深夜。 */
function rebalanceDays(
  assignMap: Map<number, Place[]>,
  days: number[],
  dayCap: number,
) {
  const load = (day: number) => (assignMap.get(day) ?? []).length;
  for (let guard = 0; guard < days.length * dayCap; guard++) {
    const overloaded = days
      .filter((day) => load(day) > dayCap)
      .sort((a, b) => load(b) - load(a) || a - b);
    const under = days
      .filter((day) => load(day) < dayCap)
      .sort((a, b) => load(a) - load(b) || a - b);
    if (!overloaded.length || !under.length) return;

    const from = overloaded[0];
    const to = under[0];
    const target = assignMap.get(to) ?? [];
    const candidates = assignMap.get(from) ?? [];
    if (candidates.length <= dayCap) return;

    let moving: Place | null = null;
    let bestDistance = Infinity;
    for (const place of candidates) {
      const distance = target.length
        ? Math.min(...target.map((item) => placeDistance(item, place)))
        : Infinity;
      if (distance < bestDistance) {
        bestDistance = distance;
        moving = place;
      }
    }
    if (!moving || !Number.isFinite(bestDistance)) return;

    assignMap.set(
      from,
      candidates.filter((place) => place !== moving),
    );
    assignMap.set(to, [...target, moving]);
  }
}

/** 按离上一个点的距离 greedily 排序，让自选景点在一天里顺路走。 */
function orderPlaces(places: Place[], start: Place): Place[] {
  const remaining = [...places];
  const ordered: Place[] = [];
  let cursor = start;
  while (remaining.length) {
    let bestIndex = 0;
    let best = Infinity;
    remaining.forEach((place, index) => {
      const distance = placeDistance(cursor, place);
      if (distance < best) {
        best = distance;
        bestIndex = index;
      }
    });
    const [next] = remaining.splice(bestIndex, 1);
    ordered.push(next);
    cursor = next;
  }
  return ordered;
}

/**
 * 把用户勾选的景点按地理片区分组，均匀铺到行程天里，再交给固定日排程。
 * 与攻略固定点不冲突：优先使用未被攻略占用的日期，占满后才合并。
 */
export function distributeSelectedPlaces(
  selected: Place[],
  input: DistributeInput,
): SelectedDistribution {
  const warnings: string[] = [];
  const guideFixed = input.fixedPlaces ?? [];
  const guidePlaces = guideFixed.map((fixed) => fixed.place);

  const unique: Place[] = [];
  for (const place of selected) {
    if (!SELECTABLE.has(place.category)) continue;
    if (
      unique.some((existing) => samePlace(existing, place)) ||
      guidePlaces.some((existing) => samePlace(existing, place))
    ) {
      continue;
    }
    unique.push(place);
  }
  if (unique.length < selected.length) {
    warnings.push(
      `有 ${selected.length - unique.length} 个重复或非景点条目已自动合并。`,
    );
  }
  if (!unique.length) {
    return { fixedPlaces: guideFixed, warnings, selectedDays: 0 };
  }

  const dayCap = PACES[input.pace].sights;
  if (unique.length > input.days * dayCap) {
    warnings.push(
      `选中了 ${unique.length} 个景点，${input.days} 天按${PACES[input.pace].label}节奏平均每天超过 ${dayCap} 个，部分景点只能短暂停留，建议加天数或删减。`,
    );
  }

  const sorted = [...unique].sort(
    (a, b) => (b.popularity ?? 3.5) - (a.popularity ?? 3.5),
  );
  const groups = clusterSelected(sorted, dayCap);

  const assignMap = new Map<number, Place[]>();
  for (const fixed of guideFixed) {
    if (fixed.day < 1 || fixed.day > input.days) continue;
    const list = assignMap.get(fixed.day) ?? [];
    if (!list.some((item) => samePlace(item, fixed.place))) {
      list.push(fixed.place);
      assignMap.set(fixed.day, list);
    }
  }

  const allDays = Array.from({ length: input.days }, (_, index) => index + 1);
  const freeDays = allDays.filter((day) => !assignMap.has(day));
  const targetDays = freeDays.length ? freeDays : allDays;
  const selectedDays = new Set<number>();

  let arranged = groups;
  if (arranged.length > targetDays.length) {
    arranged = mergeClosestGroups(arranged, targetDays.length);
    warnings.push(
      `自选景点分散在 ${groups.length} 个片区，${input.days} 天里需要把最近的片区排在同一天，路上时间会多一些。`,
    );
  }
  if (!freeDays.length && guideFixed.length) {
    warnings.push("攻略日期已经占满，自选景点会与攻略点位排在同一天。");
  }

  if (freeDays.length) {
    arranged.forEach((group, index) => {
      const day =
        targetDays[
          Math.floor((index * targetDays.length) / arranged.length)
        ];
      assignMap.set(day, [...(assignMap.get(day) ?? []), ...group]);
      selectedDays.add(day);
    });
  } else {
    const loads = new Map<number, number>(
      allDays.map((day) => [day, (assignMap.get(day) ?? []).length]),
    );
    arranged.forEach((group) => {
      const day = [...allDays].sort(
        (a, b) => (loads.get(a) ?? 0) - (loads.get(b) ?? 0) || a - b,
      )[0];
      assignMap.set(day, [...(assignMap.get(day) ?? []), ...group]);
      loads.set(day, (loads.get(day) ?? 0) + group.length);
      selectedDays.add(day);
    });
  }

  rebalanceDays(assignMap, targetDays, dayCap);

  for (const day of selectedDays) {
    if (guideFixed.some((fixed) => fixed.day === day)) continue;
    const list = assignMap.get(day);
    if (list && list.length > 1) {
      assignMap.set(day, orderPlaces(list, input.hotel));
    }
  }

  const farPlaces = sorted.filter(
    (place) => placeDistance(input.hotel, place) >= FAR_NOTICE_KM,
  );
  if (farPlaces.length) {
    const names = farPlaces
      .slice(0, 3)
      .map(
        (place) =>
          `「${place.name}」约 ${Math.round(placeDistance(input.hotel, place))} km`,
      )
      .join("、");
    warnings.push(
      `${names}，车程较远，已按片区集中安排，出发前预留往返时间。`,
    );
  }

  const fixedPlaces: FixedPlace[] = [];
  for (let day = 1; day <= input.days; day++) {
    for (const place of assignMap.get(day) ?? []) {
      fixedPlaces.push({ place, day });
    }
  }
  return { fixedPlaces, warnings, selectedDays: selectedDays.size };
}