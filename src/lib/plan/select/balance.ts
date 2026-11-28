/**
 * 跨天叙事均衡 —— 三天不能都是「老城区 + 博物馆」。
 *
 * selectDays 已经用地理分片解决了「三天都在城东」，
 * 但主题分布没人管：同一个片区里既有古厝也有海边，贪心会先把高分的一类抽干，
 * 结果第二天和第一天长得一模一样，第三天只剩边角料。
 *
 * 这里做一件很窄的事：在**不破坏片区**的前提下，把两天之间「主题重复」的点位
 * 换一换，让每天的体验向量彼此分开；顺带保证第一天别是全趟最累的那天
 * （刚到一座城，先热身；最后一天要好离开）。
 *
 * 边界（宁可少换，也不要换坏）：
 *   · 锚点（当天第一个点）不动，它是那天的主景；
 *   · 只换非锚点，且换过去的点必须仍落在当天片区半径内；
 *   · 远足日整组冻结，不能拿城里的点去换；
 *   · 一天最多换 1 个，总交换次数上限 3。
 */
import { placeDistance } from "../../geo";
import type { Place } from "../../types";
import { rhythmOf } from "../rhythm";

const DIMS = [
  "culture",
  "nature",
  "street",
  "night",
  "coast",
  "food",
  "classic",
  "indoor",
] as const;

type Dim = (typeof DIMS)[number];

function vectorOf(place: Place, city: string): number[] {
  const text = `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")}`;
  const rhythm = rhythmOf(city, place);
  const hits: Record<Dim, number> = {
    culture:
      ["museum", "temple"].includes(place.category) ||
      /历史|古厝|故居|文化|书院|寺/.test(text)
        ? 1
        : 0,
    nature: ["park", "nature", "hike"].includes(place.category) ? 1 : 0,
    street: ["street", "market"].includes(place.category) ? 1 : 0,
    night: rhythm.nightStreet ? 1 : 0,
    coast: place.island || place.category === "beach" ? 1 : 0,
    food: ["food", "market"].includes(place.category) || /小吃|海鲜|美食/.test(text) ? 1 : 0,
    classic: place.category === "attraction" ? 1 : 0,
    indoor: rhythm.indoor ? 1 : 0,
  };
  return DIMS.map((dim) => hits[dim]);
}

function sumVector(places: Place[], city: string): number[] {
  const total = new Array(DIMS.length).fill(0);
  for (const place of places) {
    const v = vectorOf(place, city);
    for (let i = 0; i < total.length; i++) total[i] += v[i];
  }
  return total;
}

/** 余弦距离（0 = 完全同主题，1 = 完全不搭）。 */
function dissimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 体力口径与 energy.ts 保持一致：只为比较「哪一天更累」。 */
function effortOf(place: Place, city: string): number {
  const rhythm = rhythmOf(city, place);
  if (["hike", "nature"].includes(place.category)) return 3;
  if (place.category === "attraction") return rhythm.longStay ? 2.6 : 2;
  if (place.category === "park") return 1.6;
  if (place.category === "museum") return 1;
  if (["street", "market"].includes(place.category)) return 0.6;
  return 0.8;
}

export interface BalanceInput {
  /** 1 起的天序，与 days 数组同序。 */
  days: Place[][];
  city: string;
  /** 当天片区半径（km）：换进来的点必须还在圈里。 */
  clusterKm: number;
  /** 冻结的天（远足日、攻略日），键是 1 起的天号。 */
  frozen?: Set<number>;
}

export interface BalanceResult {
  days: Place[][];
  swaps: number;
}

export function balanceDays(input: BalanceInput): BalanceResult {
  const groups = input.days.map((places) => [...places]);
  const n = groups.length;
  if (n < 2) return { days: groups, swaps: 0 };

  const radius = Math.max(4, input.clusterKm * 1.45);
  const anchors = groups.map((places) => places[0]);
  const frozen = input.frozen ?? new Set<number>();
  const isFrozen = (index: number) => frozen.has(index + 1);
  const swapsPerDay = new Array(n).fill(0);
  let swaps = 0;

  // 三个来回足够：再换下去只会把「顺路」换没，收益趋近于零。
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (isFrozen(i) || groups[i].length < 2) continue;
      for (let j = i + 1; j < n; j++) {
        if (isFrozen(j) || groups[j].length < 2) continue;
        if (swapsPerDay[i] >= 1 || swapsPerDay[j] >= 1) continue;
        const before = dissimilarity(
          sumVector(groups[i], input.city),
          sumVector(groups[j], input.city),
        );

        let best: { a: number; b: number; gain: number } | null = null;
        for (let a = 1; a < groups[i].length; a++) {
          for (let b = 1; b < groups[j].length; b++) {
            const pa = groups[i][a];
            const pb = groups[j][b];
            // 换过去还得在当天片区里，否则「均衡主题」会把路线拆散。
            if (placeDistance(pa, anchors[j]) > radius) continue;
            if (placeDistance(pb, anchors[i]) > radius) continue;
            const left = [...groups[i]];
            const right = [...groups[j]];
            left[a] = pb;
            right[b] = pa;
            const after = dissimilarity(
              sumVector(left, input.city),
              sumVector(right, input.city),
            );
            const gain = after - before;
            // 首尾节奏：同样是换，把重体力从第一天换出去、或者从最后一天换出去，
            // 门槛都降低。第一天刚到要热身，最后一天要留力气赶车。
            const firstDay = i === 0;
            const lastDay = j === n - 1;
            const lighterFirst =
              firstDay &&
              effortOf(pa, input.city) - effortOf(pb, input.city) >= 1 &&
              gain > -0.08;
            const lighterLast =
              lastDay &&
              // 不把重体力从末日换到首日：刚到就爬坡是最难受的一种开局。
              i > 0 &&
              effortOf(pb, input.city) - effortOf(pa, input.city) >= 1 &&
              gain > -0.08;
            if (
              (gain > 0.12 || lighterFirst || lighterLast) &&
              (!best || gain > best.gain)
            ) {
              best = { a, b, gain };
            }
          }
        }
        if (!best) continue;
        const movedOut = groups[i][best.a];
        const movedIn = groups[j][best.b];
        groups[i][best.a] = movedIn;
        groups[j][best.b] = movedOut;
        swapsPerDay[i] += 1;
        swapsPerDay[j] += 1;
        swaps += 1;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return { days: groups, swaps };
}
