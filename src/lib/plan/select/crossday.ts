/**
 * 跨天去重 —— 同一处景点、同一座岛，不该排进两天。
 *
 * audit.ts 早就能报 CROSS_DAY_REPEAT，但那是事后体检：报了也只是提醒，
 * 用户看到的仍然是「昨天在鼓浪屿，今天又上鼓浪屿」——同一座岛买两趟轮渡。
 * 实测厦门就是这么排的：D1 主景「鼓浪屿万国建筑群」，D2 主景「鼓浪屿」。
 *
 * 这里在选点阶段就把重复掐掉，并尽量用同片区的候补点补位，别让那天变秃。
 *
 * 判定「同一片」用两条，都不用外部数据：
 *   1. 名字互相包含（≥3 字）——「鼓浪屿万国建筑群」含「鼓浪屿」，
 *      「厦门大学（思明校区）」含「厦门大学」。这条能兜住高德 POI 没有 island 字段的问题。
 *   2. 坐标 150 m 内 —— 兜住「XX 东门 / XX 景区」这类不同录法。
 *
 * 归属规则：同一片里，谁的名气大就以谁所在的那天为主；
 * 名气一样再看是不是当天主景，最后才按天序。这样「鼓浪屿」不会输给
 * 「鼓浪屿万国建筑群」——后者是前者的一部分。
 *
 * 三条边界：
 *   · 远足日（frozen）整组不动，那是成组算好的一整天；
 *   · 一天只剩一个点时不碰，宁可留一处重复也不能把那天清空；
 *   · 换进来的点必须在当天剩余点位的片区半径内，且类别同族，不把路线拆散。
 */
import { placeDistance } from "../../geo";
import type { Place } from "../../types";
import { placeKeyOf, nearSamePlace } from "../same-place";
import type { ScoredPlace } from "./shared";

export interface CrossDayInput {
  /** 按天给出点位，第 0 个是当天主景。 */
  days: Array<{ day: number; places: Place[]; frozen: boolean }>;
  /** 全城候补（含已在行程里的点，内部会过滤）。 */
  scored: ScoredPlace[];
  /** 换进来的点离当天其他点位不能超过这个半径（km）。 */
  clusterKm: number;
}

export interface CrossDayChange {
  day: number;
  name: string;
  /** 被谁顶掉/挪到哪；为空表示这个点直接删掉。 */
  replacedBy?: string;
  reason: "same-spot" | "same-area";
}

export interface CrossDayResult {
  days: Map<number, Place[]>;
  changes: CrossDayChange[];
}

/** 类别家族：换点时不至于把「博物馆」换成「大排档」。 */
function familyOf(place: Place): string {
  if (["attraction", "temple", "museum"].includes(place.category)) return "culture";
  if (["park", "nature", "viewpoint", "beach"].includes(place.category)) return "outdoor";
  if (["street", "market"].includes(place.category)) return "street";
  if (["food", "cafe"].includes(place.category)) return "food";
  return "other";
}

/** 名字互相包含（至少 3 个字，避免「中山路」这种两字通用词误伤）。 */
function nameNests(a: Place, b: Place): boolean {
  if (a.name === b.name) return true;
  const [short, long] = a.name.length <= b.name.length ? [a.name, b.name] : [b.name, a.name];
  return short.length >= 3 && long.includes(short);
}

/** 同一片：名字互相包含，或坐标 150 m 内。 */
function sameArea(a: Place, b: Place): boolean {
  if (a.id === b.id) return false;
  return nameNests(a, b) || nearSamePlace(a, b);
}

export function dedupeAcrossDays(input: CrossDayInput): CrossDayResult {
  const days = new Map<number, Place[]>(
    input.days.map((entry) => [entry.day, [...entry.places]]),
  );
  const frozenDays = new Set(
    input.days.filter((entry) => entry.frozen).map((entry) => entry.day),
  );
  const changes: CrossDayChange[] = [];
  const usedIds = new Set<string>();
  const dayOf = new Map<string, number>();
  for (const [day, places] of days) {
    for (const place of places) {
      usedIds.add(place.id);
      dayOf.set(place.id, day);
    }
  }
  const widestDay = Math.max(...[...days.values()].map((list) => list.length));

  /**
   * 同一片里的归属排序：名字短的是「上位」。
   *
   * 「鼓浪屿」和「鼓浪屿万国建筑群」打架时，该让的是后者——后者是前者的一部分，
   * 去过岛就不必再单列岛上的一个馆。按名气排会反过来：万国建筑群的评分
   * 常常不比整座岛低，结果把「鼓浪屿」本身挤掉了（实测厦门就丢过整座岛）。
   * 名气、主景、天序只在名字分不出高下时（比如坐标兜底的两处不同名字）才用。
   */
  const rank = (place: Place, day: number): number[] => [
    place.name.replace(/[（(【\[].*?[）)】\]]/g, "").length,
    -(place.popularity ?? 0),
    days.get(day)?.[0]?.id === place.id ? 0 : 1,
    day,
  ];
  const better = (a: Place, b: Place): boolean => {
    const ra = rank(a, dayOf.get(a.id) ?? 0);
    const rb = rank(b, dayOf.get(b.id) ?? 0);
    for (let i = 0; i < ra.length; i += 1) {
      if (ra[i] !== rb[i]) return ra[i] < rb[i];
    }
    return false;
  };

  // 把全部景点按「同一片」归堆（并查集；一趟行程只有十几个点，直接两两比）。
  const all = [...days.entries()].flatMap(([day, places]) =>
    places.map((place) => ({ day, place })),
  );
  const parent = all.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      if (all[i].day === all[j].day) continue;
      if (!sameArea(all[i].place, all[j].place)) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[b] = a;
    }
  }

  const groups = new Map<number, number[]>();
  all.forEach((_, index) => {
    const root = find(index);
    const list = groups.get(root) ?? [];
    list.push(index);
    groups.set(root, list);
  });

  const findReplacement = (day: number, victim: Place): Place | undefined => {
    const mates = (days.get(day) ?? []).filter((place) => place.id !== victim.id);
    const family = familyOf(victim);
    // 别的天已经占住的片区（1.5 km 内）不再放点：否则「去重」只是把
    // 同一个片区从第一天挪到第二天，等于还是两天在同一个地方打转。
    const occupied = input.days
      .filter((entry) => entry.day !== day)
      .flatMap((entry) => entry.places);
    return input.scored
      .filter((item) => !usedIds.has(item.place.id))
      .filter((item) => familyOf(item.place) === family)
      .filter((item) => all.every((entry) => !sameArea(entry.place, item.place)))
      .filter((item) =>
        occupied.every((other) => placeDistance(other, item.place) > 1.5),
      )
      .filter((item) =>
        mates.every(
          (mate) => placeDistance(mate, item.place) <= Math.max(3, input.clusterKm),
        ),
      )
      // 别为了补一个位置再堆第三个同类点：一天连看三座馆/三处老宅，
      // 体检会记 SAME_CATEGORY_RUN，人也记不住看了什么。
      .filter(
        (item) =>
          mates.filter((mate) => mate.category === item.place.category).length < 2,
      )
      .sort((a, b) => b.score - a.score)[0]?.place;
  };

  for (const indices of groups.values()) {
    // 跨天的才算重复；同一天里的重复由 audit 的 DUPLICATE_PLACE 管。
    const spansDays = new Set(indices.map((index) => all[index].day)).size > 1;
    if (!spansDays) continue;
    const members = indices
      .map((index) => all[index])
      .sort((a, b) => (better(a.place, b.place) ? -1 : 1));

    for (const member of members.slice(1)) {
      const day = member.day;
      const places = days.get(day);
      if (!places || places.length <= 1) continue;
      if (frozenDays.has(day)) continue;

      // 跨天的重复一律「换点或删掉」，不搬到主那天去。
      // 早先这里是「搬到主那天」，实测反而把冗余点保了下来：
      // 万国建筑群从第 1 天挪到第 2 天，第 2 天照样同时有鼓浪屿和它。
      const replacement = findReplacement(day, member.place);
      const nextPlaces = places.filter((place) => place.id !== member.place.id);
      if (replacement) {
        usedIds.add(replacement.id);
        dayOf.set(replacement.id, day);
        days.set(day, [...nextPlaces, replacement]);
        changes.push({
          day,
          name: member.place.name,
          replacedBy: replacement.name,
          reason: "same-spot",
        });
      } else if (nextPlaces.length) {
        days.set(day, nextPlaces);
        changes.push({ day, name: member.place.name, reason: "same-spot" });
      }
    }
  }

  return { days, changes };
}
