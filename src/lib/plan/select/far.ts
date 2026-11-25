import {
  angleDistance,
  bearing,
  estimateModeMinutes,
  placeDistance,
  seededJitter,
} from "../../geo";
import type { Category, Place, StyleId } from "../../types";
import { rhythmOf } from "../rhythm";
import {
  closingOnly,
  isFamous,
  isFlagship,
  isPremier,
  sunTooFar,
  type ScoredPlace,
} from "./shared";

export function farLimitKm(styles: StyleId[]): number {
  let limit = 45;
  if (styles.includes("family")) limit = 32;
  else if (styles.includes("citywalk")) limit = 38;
  return limit;
}

// 旗舰景点比普通远郊点多给 15 km 余量（最多 58 km），仍要满足单程 110 分钟。
export function farReachKm(styles: StyleId[], place: Place): number {
  const base = farLimitKm(styles);
  return isFlagship(place) ? Math.min(58, base + 15) : base;
}

export function decideFarDays(
  requested: number | undefined,
  autoCount: number,
  capacity: number,
  farPool: ScoredPlace[],
  anchors: ScoredPlace[],
  cap = 2,
  nearStrong = autoCount,
  sparseOverride?: boolean,
): number {
  if (autoCount < 1) return 0;
  const hardCap = Math.min(
    Math.max(0, cap),
    autoCount >= 2 ? autoCount - 1 : 1,
  );
  if (requested !== undefined) {
    return Math.max(0, Math.min(requested, hardCap));
  }
  if (autoCount < 2 || anchors.length === 0) return 0;
  // 市中心只剩社区公园时，宁可把 3 天里的 2 天给城外的名山古寺；
  // 近处本身有足够真景点就只保留 1 个远足日。
  const sparseNear = sparseOverride ?? nearStrong < autoCount;
  // 两天以内的短行程：城区景点够玩就不排远足日。
  // 两天本来只够逛一片，把其中一天交给单程一小时的车程，结果就是「一天主城、一天赶路」。
  // 反过来，黄山这种名气全在山上的城市 sparseNear 为真，仍然会保留远足日。
  if (autoCount <= 2 && !sparseNear && !anchors.some((item) => isPremier(item.place))) {
    return 0;
  }
  const want =
    anchors.length >= 3 &&
    farPool.length >= capacity * 1.5 &&
    (autoCount >= 5 || sparseNear)
      ? 2
      : 1;
  return Math.min(want, hardCap);
}

// 远足日先选“主锚点”，再收拢周边顺路点位，保证一天只去一个方向。
const BIG_OUTDOOR = new Set<Category>(["nature", "park", "beach", "viewpoint"]);

function isBigOutdoor(place: Place): boolean {
  return BIG_OUTDOOR.has(place.category) && (place.popularity ?? 0) >= 4.15;
}

export function pickFarGroups(
  pool: ScoredPlace[],
  count: number,
  capacity: number,
  hotel: Place,
  seed: number,
  city: string,
  styles: StyleId[],
): ScoredPlace[][] {
  const remaining = [...pool].sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const groups: ScoredPlace[][] = [];
  const usedRoles: Record<string, number> = {};
  let previousDir: number | null = null;
  let usedBigOutdoor = false;

  for (let day = 0; day < count; day++) {
    const candidates = remaining.filter((item) => !used.has(item.place.id));
    if (!candidates.length) break;
    const famous = candidates.filter((item) => isFamous(item.place));
    const anchorPool = famous.length ? famous : candidates;
    let bestAnchor: ScoredPlace | null = null;
    let bestValue = -Infinity;
    for (const item of anchorPool.slice(0, 36)) {
      const profile = rhythmOf(city, item.place);
      if (profile.quickStop) continue;
      // 远足日要有一个白天能撑起来的点，纯傍晚的普通点位不当远足锚点。
      if (closingOnly(profile) && !isFamous(item.place)) continue;
      const dir = bearing(
        [hotel.lng, hotel.lat],
        [item.place.lng, item.place.lat],
      );
      const company = candidates.filter(
        (other) =>
          other.place.id !== item.place.id &&
          placeDistance(other.place, item.place) <= 16,
      ).length;
      let value =
        item.score +
        Math.min(3, company) * 0.45 +
        seededJitter(seed, `far-${day}-${item.place.id}`, 0.5);
      // 大景点优先：名山、国家公园这类旗舰点位比同分的村镇街巷更值得占一个远足日。
      if (isBigOutdoor(item.place) && isFlagship(item.place)) value += 1.2;
      if (previousDir !== null && angleDistance(dir, previousDir) < 55) {
        value -= 2.2;
      }
      // 已经用一天爬过名山，第二天优先换寺庙、古城这类不重复的类型；
      // 只有没得选时才会再排一座大山。
      if (usedBigOutdoor && isBigOutdoor(item.place)) value -= 2.6;
      if (!profile.heroEligible) value -= 0.9;
      if (profile.sunset) {
        value += usedRoles.sunset
          ? (styles.includes("coastal") ? -1.2 : -2.6)
          : 0.45;
      }
      if (profile.sunrise && sunTooFar(item.place, hotel)) value -= 2.4;
      if (profile.sunrise && usedRoles.sunrise) value -= 3;
      if (value > bestValue) {
        bestValue = value;
        bestAnchor = item;
      }
    }
    if (!bestAnchor) break;
    const anchor = bestAnchor;
    const anchorProfile = rhythmOf(city, anchor.place);
    const group: ScoredPlace[] = [anchor];
    used.add(anchor.place.id);
    // 车程近的外围城区可以排满；真正 1–2 小时的远足日少排一个点，留出路上时间。
    const oneWay = estimateModeMinutes(hotel, anchor.place, "taxi");
    const groupCap =
      oneWay <= 45 ? capacity : Math.max(2, capacity - 1);
    const anchorDir = bearing(
      [hotel.lng, hotel.lat],
      [anchor.place.lng, anchor.place.lat],
    );
    const nearby = candidates
      .filter(
        (item) =>
          item.place.id !== anchor.place.id && !used.has(item.place.id),
      )
      .map((item) => ({
        item,
        km: placeDistance(item.place, anchor.place),
        dir: bearing(
          [hotel.lng, hotel.lat],
          [item.place.lng, item.place.lat],
        ),
      }))
      .filter(
        (entry) =>
          entry.km <= 16 &&
          (entry.km <= 6 ||
            angleDistance(entry.dir, anchorDir) <= 55) &&
          estimateModeMinutes(anchor.place, entry.item.place, "taxi") <= 30,
      )
      .sort(
        (a, b) =>
          b.item.score - b.km * 0.16 - (a.item.score - a.km * 0.16),
      );
    const groupRoles: Record<string, number> = {
      sunset: anchorProfile.sunset ? 1 : 0,
      sunrise: anchorProfile.sunrise ? 1 : 0,
      market: anchorProfile.marketMorning ? 1 : 0,
      quick: anchorProfile.quickStop ? 1 : 0,
      indoor: anchorProfile.indoor ? 1 : 0,
    };
    let groupBigOutdoor = isBigOutdoor(anchor.place) ? 1 : 0;
    for (const entry of nearby) {
      if (group.length >= groupCap) break;
      // 单程已超过 45 分钟，还要顺路看一棵树、一个雕塑并不划算；
      // 名气没底的微景点宁可不排，把时间留给主锚点。
      if (oneWay > 45 && (entry.item.place.popularity ?? 0) < 3.5) continue;
      const profile = rhythmOf(city, entry.item.place);
      // 一天只爬一座名山：游客不会在同一天连爬金顶山、云梦山、老乐山。
      if (isBigOutdoor(entry.item.place) && groupBigOutdoor >= 1) continue;
      if (profile.quickStop && groupRoles.quick >= 1) continue;
      if (profile.sunset && groupRoles.sunset >= 1) continue;
      if (profile.sunrise && groupRoles.sunrise >= 1) continue;
      if (profile.indoor && groupRoles.indoor >= 2) continue;
      const groupOpensEarly =
        (groupRoles.market ?? 0) > 0 || (groupRoles.sunrise ?? 0) > 0;
      if (profile.sunset && groupOpensEarly) continue;
      if (
        (profile.marketMorning || profile.sunrise) &&
        (groupRoles.sunset ?? 0) > 0
      ) {
        continue;
      }
      group.push(entry.item);
      used.add(entry.item.place.id);
      groupBigOutdoor += isBigOutdoor(entry.item.place) ? 1 : 0;
      groupRoles.sunset += profile.sunset ? 1 : 0;
      groupRoles.sunrise += profile.sunrise ? 1 : 0;
      groupRoles.market += profile.marketMorning ? 1 : 0;
      groupRoles.quick += profile.quickStop ? 1 : 0;
      groupRoles.indoor += profile.indoor ? 1 : 0;
    }
    // 单程超过 45 分钟、又只有一个撑不起一天的普通点位，不值得为它单独占一天；
    // 名山、国家公园本身就能玩一整天，即使只有一个锚点也保留。
    const fillsDay =
      isFlagship(anchor.place) ||
      (BIG_OUTDOOR.has(anchor.place.category) &&
        (anchor.place.popularity ?? 0) >= 4.25);
    const thinFar = group.length === 1 && !fillsDay && oneWay > 45;
    if (thinFar) continue;
    groups.push(group);
    if (isBigOutdoor(anchor.place)) usedBigOutdoor = true;
    usedRoles.sunset = (usedRoles.sunset ?? 0) + (groupRoles.sunset > 0 ? 1 : 0);
    usedRoles.sunrise = (usedRoles.sunrise ?? 0) + (groupRoles.sunrise > 0 ? 1 : 0);
    previousDir = bearing(
      [hotel.lng, hotel.lat],
      [anchor.place.lng, anchor.place.lat],
    );
  }
  return groups;
}
