import { placeDistance } from "../../geo";
import type { Place } from "../../types";
import type { RhythmProfile } from "../rhythm/profile";

export type ScoredPlace = { place: Place; score: number; distance: number };

export const FAR_MIN_POPULARITY = 4.15;
export const FAR_MAX_ONE_WAY_MIN = 110;

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