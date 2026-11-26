import { placeDistance } from "../geo";
import type { Place } from "../types";

/**
 * 区域环线的地理分段（宪法：区域游按基地分段推进，不能用单中心+单半径）。
 *
 * 问题：北疆/川藏/广西的必去点跨几百到上千公里，
 * 单中心的 selectDays 会用 farReachKm 把它们全裁掉，最后只排出中心城市周边。
 *
 * 解法：把必去点聚成 K 段（K=天数），每段一个基地，段内独立选点。
 * 用 k-center 贪心：先取最远点作种子，再反复取"离现有中心最远的点"作新中心，
 * 把每个点归到最近中心。这对团状（北疆两团）和线性（川藏沿 318）都成立。
 */
export interface RouteSegment {
  index: number;
  /** 该段的落脚基地（段内热度最高点的坐标，作为当天 reference）。 */
  center: [number, number];
  base: Place;
  /** 该段负责的景点。 */
  places: Place[];
  /** 段的地理标签（取热度最高点名字）。 */
  label: string;
  /** 段内跨度（km），供展示"这一天在这一带"。 */
  spanKm: number;
}

function centroid(places: Place[]): [number, number] {
  let lng = 0;
  let lat = 0;
  for (const p of places) {
    lng += p.lng;
    lat += p.lat;
  }
  return [lng / places.length, lat / places.length];
}

function topPlace(places: Place[]): Place {
  return [...places].sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))[0];
}

/**
 * 把景点按地理分成 k 段。
 * @param places 候选景点（已含必去点）
 * @param k 段数（通常 = 天数）
 * @param anchor 起点城市中心；给了就强制第一段落在起点附近（避免第一天的基地在千里之外）
 */
export function segmentPlaces(
  places: Place[],
  k: number,
  anchor?: [number, number],
): RouteSegment[] {
  if (!places.length) return [];
  const count = Math.max(1, Math.min(k, places.length));
  if (count === 1) {
    const c = centroid(places);
    const top = topPlace(places);
    return [{
      index: 1,
      center: c,
      base: { ...top, id: `seg-base-1`, name: `${top.name}一带`, category: "hotel" },
      places,
      label: top.name,
      spanKm: 0,
    }];
  }

  // k-center 贪心：第一个种子优先取 anchor 附近的点，否则取热度最高点。
  const seeds: Place[] = [];
  if (anchor) {
    const sorted = [...places].sort(
      (a, b) => placeDistance(a, { ...places[0], lng: anchor[0], lat: anchor[1] }) -
        placeDistance(b, { ...places[0], lng: anchor[0], lat: anchor[1] }),
    );
    seeds.push(sorted[0]);
  } else {
    seeds.push(topPlace(places));
  }
  while (seeds.length < count) {
    // 取离现有所有种子最远的那个点当新种子
    let far: Place | null = null;
    let farDist = -1;
    for (const p of places) {
      if (seeds.some((s) => s.id === p.id)) continue;
      const nearest = Math.min(...seeds.map((s) => placeDistance(p, s)));
      if (nearest > farDist) {
        farDist = nearest;
        far = p;
      }
    }
    if (!far) break;
    seeds.push(far);
  }

  // 每个点归到最近种子
  const groups: Place[][] = seeds.map(() => []);
  for (const p of places) {
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < seeds.length; i += 1) {
      const d = placeDistance(p, seeds[i]);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    groups[best].push(p);
  }

  return groups
    .filter((g) => g.length)
    .map((g, i) => {
      const top = topPlace(g);
      const c = centroid(g);
      let span = 0;
      for (const p of g) {
        for (const q of g) span = Math.max(span, placeDistance(p, q));
      }
      return {
        index: i + 1,
        center: c,
        base: {
          ...top,
          id: `seg-base-${i + 1}`,
          name: `${top.name}一带`,
          category: "hotel" as const,
        },
        places: g,
        label: top.name,
        spanKm: Math.round(span),
      };
    });
}

/** 判断一个目的地是不是区域环线（景点跨度 > 400km）。 */
export function isRegionSpan(places: Place[], thresholdKm = 400): boolean {
  if (places.length < 2) return false;
  // 经度或纬度任一方向的跨度超阈值就算区域。
  // 只看经度会漏掉广西这类南北走向（桂林→北海纬度差大、经度差小）。
  let minLng = Infinity; let maxLng = -Infinity;
  let minLat = Infinity; let maxLat = -Infinity;
  for (const p of places) {
    minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
    minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  }
  // 用中点作参考，把经纬度跨度都换算成公里再取较大者。
  const midLat = (minLat + maxLat) / 2;
  const lngKm = (maxLng - minLng) * 111 * Math.cos((midLat * Math.PI) / 180);
  const latKm = (maxLat - minLat) * 111;
  return Math.max(lngKm, latKm) > thresholdKm;
}
