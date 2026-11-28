import {
  angleDistance,
  bearing,
  estimateModeMinutes,
  placeDistance,
  seededJitter,
} from "../../geo";
import type { Category, Place, StyleId } from "../../types";
import { DEFAULT_PARAMS, type PlanParams } from "../params";
import { rhythmOf } from "../rhythm";
import {
  closingOnly,
  isFamous,
  isFlagship,
  isPremier,
  sunTooFar,
  type ScoredPlace,
} from "./shared";

export function farLimitKm(
  styles: StyleId[],
  params: PlanParams = DEFAULT_PARAMS,
): number {
  let limit = params.farLimitKm;
  if (styles.includes("family")) limit = Math.min(limit, 32);
  else if (styles.includes("citywalk")) limit = Math.min(limit, 38);
  return limit;
}

// 旗舰景点比普通远郊点多给 15 km 余量（最多 58 km），仍要满足单程 110 分钟。
export function farReachKm(
  styles: StyleId[],
  place: Place,
  params: PlanParams = DEFAULT_PARAMS,
): number {
  const base = farLimitKm(styles, params);
  // 区域环线/小城大景点的必去点带 reachMin：按 60km/h 折算成搜索半径，
  // 否则北疆的喀纳斯（150km）、芜湖的黄山（49km）在进池前就被 45km 裁掉。
  if (place.reachMin) {
    return Math.max(base, Math.min(320, place.reachMin * 0.9));
  }
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

/**
 * 单个点位的「分量」——名气加不可替代性，不是评分本身。
 *
 * 为什么要单独算一遍：高德那套 popularity 是四分制往上挤的，
 * 一个郊野公园和一个世界遗产都能到 4.6，光看分数分不出「值不值得跑 60 公里」。
 * 所以把「旗舰 / 城里人人知道 / 大室外 / 评分」分开加权，
 * 让只占其中一项的点位自然比占三项的低一档。
 */
function placeWeight(place: Place): number {
  let weight = 0.8;
  if (isFlagship(place)) weight += 1.6;
  if (isFamous(place)) weight += 1.0;
  if (isPremier(place)) weight += 0.6;
  if (isBigOutdoor(place)) weight += 0.5;
  // 评分只做微调：3.4 分以下不加分，4.8 以上封顶 1.4。
  weight += Math.min(1.4, Math.max(0, (place.popularity ?? 0) - 3.4));
  return weight;
}

/** 一组点位的总分量。第二个点边际递减——顺路逛值得，但不能跟主景同权。 */
export function farGroupWeight(group: ScoredPlace[]): number {
  const weights = group
    .map((item) => placeWeight(item.place))
    .sort((a, b) => b - a);
  return weights.reduce(
    (sum, weight, index) => sum + weight * (index === 0 ? 1 : index === 1 ? 0.55 : 0.3),
    0,
  );
}

/** 单程超过这个时长，才需要「分量」来证明值得跑一趟。 */
export const FAR_JUSTIFY_MIN = 45;

/**
 * 远足日值不值 = 分量 ÷ 单程小时。
 *
 * 原来只拦「组里只有 1 个点、又不是旗舰、单程还超过 45 分钟」，
 * 于是「郊野公园 + 一个广场」这种两点的组合能过，换来 85.9 km、路上 3 小时 53 分。
 * 那是通勤，不是远足。改成按小时折算，路程越久，要求的分量越高。
 */
export function farDayValue(
  group: ScoredPlace[],
  oneWayMin: number,
): { weight: number; hours: number; value: number } {
  const weight = farGroupWeight(group);
  const hours = Math.max(0.5, oneWayMin / 60);
  return { weight, hours, value: weight / hours };
}

/**
 * 门槛不是固定值：主城越够玩，越不该为郊外一个点丢掉城里的一整天。
 *
 * 三档按实测标定（厦门 / 三亚 / 成都 / 黄山 / 驻马店）：
 *   · 城里已经很丰富 —— 7.0：厦门「郊野公园 + 广场」算出 6.0，过不去；
 *   · 城里一般 —— 4.6：普通远郊点仍然排得进；
 *   · 城里没得玩 —— 2.8：名气全在城外的城市照旧给远足日。
 */
export const FAR_VALUE_FLOOR = {
  rich: 7,
  normal: 4.6,
  sparse: 2.8,
} as const;

/**
 * 顶级名录景点（世界遗产、5A、国家风景名胜）的折让系数。
 *
 * 「分量」里 isFlagship 只代表「高分」，一堆县城郊野公园也能到 4.6；
 * 真正值得专程跑的只有名录级那一小撮。所以门槛不整体下调，
 * 只在这一组里确实有 premier 点位时打折——黄山单点值 4.2，乘 0.6 后 4.2 的门槛留得住它。
 */
export const FAR_PREMIER_DISCOUNT = 0.6;

export function farValueFloor(
  nearStrong: number,
  autoCount: number,
  sparseNear: boolean,
): number {
  if (sparseNear) return FAR_VALUE_FLOOR.sparse;
  // 主城强点数量达到「每天两个」就算富：这种城市把一天交给单程一小时的路，
  // 换回来的通常只是一个 4.6 分的公园，划不来。
  return nearStrong >= Math.max(2, autoCount * 2)
    ? FAR_VALUE_FLOOR.rich
    : FAR_VALUE_FLOOR.normal;
}

/**
 * 这一组远郊点位值不值得单独占一天。
 *
 * 三种情况直接放行，不必算账：
 *   1. 单程不超过 45 分钟 —— 本来就在主城边上，顺路；
 *   2. 组里有 reachMin 的必去点（区域环线）—— 它就是这趟行程的目的；
 *   3. 组里有 premier 名录景点（世界遗产/5A/国家风景名胜）—— 门槛打折。
 */
export function farDayWorthGoing(
  group: ScoredPlace[],
  oneWayMin: number,
  valueFloor: number,
): boolean {
  if (oneWayMin <= FAR_JUSTIFY_MIN) return true;
  if (group.some((item) => (item.place.reachMin ?? 0) > 60)) return true;
  const required =
    valueFloor *
    (group.some((item) => isPremier(item.place)) ? FAR_PREMIER_DISCOUNT : 1);
  return farDayValue(group, oneWayMin).value >= required;
}

export function pickFarGroups(
  pool: ScoredPlace[],
  count: number,
  capacity: number,
  hotel: Place,
  seed: number,
  city: string,
  styles: StyleId[],
  valueFloor: number = FAR_VALUE_FLOOR.normal,
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
      // 区域环线的锚点（如喀纳斯）周边 16km 内常常没有第二个点，
      // 用形态给出的 reachMin 放宽成团半径，否则一天只能排一个点、被 thinFar 丢掉。
      const companyKm = (item.place.reachMin ?? 0) > 150 ? 40 : 16;
      const company = candidates.filter(
        (other) =>
          other.place.id !== item.place.id &&
          placeDistance(other.place, item.place) <= companyKm,
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
    // 区域环线的锚点周边可成团的半径更大（喀纳斯/禾木之间就 30–40km）。
    const groupRadiusKm = (anchor.place.reachMin ?? 0) > 150 ? 40 : 16;
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
          entry.km <= groupRadiusKm &&
          (entry.km <= 6 ||
            angleDistance(entry.dir, anchorDir) <= 55) &&
          estimateModeMinutes(anchor.place, entry.item.place, "taxi") <=
            (groupRadiusKm > 16 ? 60 : 30),
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
    // 值不值，看「分量 ÷ 单程小时」而不是点数：两点组合（郊野公园 + 一个广场）
    // 一样可能凑不出一趟值得的路，见 farDayValue 的注释。
    if (!farDayWorthGoing(group, oneWay, valueFloor)) continue;
    // 一个点撑不起一天、还要走一个多小时的路：以前只有这一条能拦，
    // 现在上面的分量门槛已经覆盖，保留判断是为了远足日不足时能给出解释。
    if (group.length === 1 && !fillsDay && oneWay > 45) continue;
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
