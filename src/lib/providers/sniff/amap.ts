import type { Place } from "../../types";
import {
  amapCityBoundary,
  amapSweepPage,
  type AmapCityBoundary,
} from "../amap";
import {
  clampPopularity,
  mergePlaceLayers,
  SIGHT_CATEGORIES,
  withinBoundary,
} from "./shared";
import type { SniffBoundary, SniffSourceResult, SniffStage } from "./types";

const TYPE_SWEEPS = [
  "110000", // 风景名胜：公园、寺庙、观景、特色街区等
  "140500|140600|140700", // 博物馆 / 展览馆 / 美术馆
  "080300|080500", // 娱乐场所 / 度假疗养
] as const;

const PAGE_BUDGET: Record<SniffStage, number[]> = {
  base: [6, 2, 0],
  deep: [48, 10, 3],
};

function toBoundary(boundary: AmapCityBoundary | null): SniffBoundary | undefined {
  if (!boundary) return undefined;
  return {
    name: boundary.name,
    bbox: boundary.bbox,
    adcode: boundary.adcode,
    rings: boundary.rings,
  };
}

function withRankBoost(place: Place, rank: number): Place {
  const boost = Math.max(0, 0.55 - rank * 0.0022);
  return {
    ...place,
    tags: place.tags ? [...place.tags] : undefined,
    popularity: clampPopularity((place.popularity ?? 3.4) + boost),
  };
}

export async function sniffAmap(
  city: string,
  center: [number, number],
  stage: SniffStage,
): Promise<SniffSourceResult> {
  const notes: string[] = [];
  let requests = 0;

  let boundary: AmapCityBoundary | null = null;
  try {
    boundary = await amapCityBoundary(city);
    requests += 1;
  } catch {
    notes.push("高德行政区边界暂时取不到，已按全市检索范围扫描。");
  }
  const boundaryInfo = toBoundary(boundary);
  const scope = boundary?.adcode || city;
  const budgets = PAGE_BUDGET[stage];
  const collected: Place[] = [];
  let raw = 0;
  let total = 0;
  let truncated = false;

  for (let typeIndex = 0; typeIndex < TYPE_SWEEPS.length; typeIndex += 1) {
    const types = TYPE_SWEEPS[typeIndex];
    const maxPages = budgets[typeIndex] ?? 0;
    if (!maxPages) continue;
    let page = 1;
    let scanned = 0;
    let currentTotal = 0;
    try {
      while (page <= maxPages) {
        const result = await amapSweepPage(scope, types, page, 25);
        requests += 1;
        raw += result.rawCount;
        scanned += result.rawCount;
        if (result.totalCount > 0) {
          currentTotal = Math.max(currentTotal, result.totalCount);
          total = Math.max(total, result.totalCount);
        }
        const baseRank = (page - 1) * 25;
        result.places.forEach((place, index) => {
          if (!SIGHT_CATEGORIES.has(place.category)) return;
          if (
            !withinBoundary(place, city, boundaryInfo, center)
          ) {
            return;
          }
          collected.push(withRankBoost(place, baseRank + index));
        });
        if (result.rawCount < 25) break;
        if (result.totalCount > 0 && page * 25 >= result.totalCount) break;
        page += 1;
      }
    } catch (error) {
      notes.push(
        `高德「${types}」类型扫描中断：${
          error instanceof Error ? error.message : "上游返回异常"
        }`,
      );
    }
    if (currentTotal > scanned) truncated = true;
  }

  const places = mergePlaceLayers([collected]);
  if (places.length) {
    notes.unshift(
      `高德全城扫描：共 ${raw} 条 POI，保留 ${places.length} 个景点候选。`,
    );
  } else {
    notes.push("高德没有返回可用的景点候选，稍后刷新可重试。");
  }
  if (truncated) {
    notes.push("高德返回量超过本次分页上限，仍有更多点位未纳入。");
  }

  return {
    source: "amap",
    places,
    notes,
    requests,
    truncated,
    raw,
    boundary: boundaryInfo,
  };
}