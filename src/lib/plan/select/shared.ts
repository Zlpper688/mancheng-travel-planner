import { placeDistance } from "../../geo";
import type { Place } from "../../types";
import type { RhythmProfile } from "../rhythm/profile";

export type ScoredPlace = { place: Place; score: number; distance: number };

export const FAR_MIN_POPULARITY = 4.15;
export const FAR_MAX_ONE_WAY_MIN = 110;

/**
 * 远足日能容忍的单程车程，按行程长度收口。
 *
 * 110 分钟是为「专程去黄山」这类长线留的余量，但两天行程里塞一个单程 80 分钟的
 * 城郊点，等于把半个白天交给公路：实际排出来会变成「一天主城、一天赶路」。
 * 短行程只在车程可控的范围内找远足点，找不到就老老实实待在城里。
 */
export function farOneWayCap(days: number): number {
  if (days <= 2) return 65;
  if (days === 3) return 90;
  return FAR_MAX_ONE_WAY_MIN;
}

/**
 * 顶级名录：值得为它专程跑一趟的那种。比 isFlagship 更严——
 * 「XX国家森林公园」「XX国家湿地公园」在开放数据里满地都是，两天的城市行程
 * 不该为一个 20 公里外的森林公园把一天交给公路；但黄山、九寨沟这种必须去。
 *
 * 只认名录关键词和真实评分：开放数据的 popularity 是「有没有 wikidata」推出来的，
 * 拿它当名气用会把一堆县级景区也抬成顶级。
 */
const PREMIER =
  /国家风景名胜|世界遗产|世界自然遗产|世界文化遗产|国家公园|5A|五A|全国重点/;

export function isPremier(place: Place): boolean {
  return PREMIER.test(place.name) || (place.rating ?? 0) >= 4.7;
}

/**
 * 单个点位能容忍的单程上限。顶级景区（黄山、九寨沟这类）值得为它多开一段，
 * 否则「去黄山却不上山」会成为短行程里最荒谬的结果。
 */
export function farOneWayCapFor(days: number, place: Place): number {
  const base = farOneWayCap(days);
  if (!isPremier(place)) return base;
  return Math.max(base, 90);
}

export function isFamous(place: Place): boolean {
  return (
    (place.popularity ?? 0) >= FAR_MIN_POPULARITY ||
    (place.rating ?? 0) >= 4.6
  );
}

// 国家级/世界级名录里的景点值得为它多开一段车：黄山国家风景名胜区离屯溪
// 49 km，死守 45 km 半径会把整趟黄山行最该去的山直接裁掉。
const NATIONAL_FLAGSHIP =
  /国家公园|国家风景名胜|国家森林公园|国家地质公园|国家湿地公园|国家矿山公园|世界遗产|世界地质公园|世界自然遗产|5A|五A|全国重点/;

export function isFlagship(place: Place): boolean {
  const popularity = place.popularity ?? 0;
  if (popularity >= 4.4) return true;
  if (popularity < 4.2) return false;
  if (NATIONAL_FLAGSHIP.test(place.name)) return true;
  // 有维基数据（OSM 里存为 Q 编号）说明是有词条的知名点位，不是街边雕塑。
  return (place.tags ?? []).some((tag) => /^Q\d+$/.test(tag));
}

export function sunTooFar(place: Place, hotel: Place): boolean {
  return placeDistance(hotel, place) > 6.5;
}

// 只有傍晚才进入状态的普通点位，撑不起一整天；名气不够时不该当锚点。
export function closingOnly(profile: RhythmProfile): boolean {
  return (
    !profile.sunset &&
    !profile.nightStreet &&
    profile.windows.length > 0 &&
    Math.min(...profile.windows.map(([start]) => start)) >= 14 * 60
  );
}