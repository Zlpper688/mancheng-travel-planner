import { findPlaceProfile } from "./tips/lookup";
import type { Place } from "./types";

export type WaterKind = "sea" | "lake" | "unknown";

const LAKE =
  /湖|池|水库|潭|溪|湿地|洱海|什刹海|后海|北海公园|中南海|滇池|纳木错|日月潭|千岛湖|太湖|巢湖|瘦西湖|大明湖|东钱湖|镜湖|鉴湖|月牙泉/i;

const SEA =
  /海滩|海滨|海边|海岸|海景|海风|看海|海浪|海面|海上|海湾|海港|海岛|滨海|沙滩|滩|潮汐|潮声|浪花|港湾/i;

// 「沙滩 / 滩」在内陆也很常见（人工沙滩、河滩、湖滩），单独出现不足以证明是海岸。
const STRONG_SEA =
  /海滩|海滨|海边|海岸|海景|海风|看海|海浪|海面|海上|海湾|海港|海岛|滨海|潮汐|潮声|浪花|港湾|入海口|出海口/i;

const COASTAL_SIGHT = new Set([
  "beach",
  "viewpoint",
  "attraction",
  "park",
  "nature",
  "street",
]);

function profileText(city: string, place: Place): string {
  const profile = findPlaceProfile(city, place.name);
  return [
    profile?.highlight ?? "",
    profile?.photo ?? "",
    profile?.caution ?? "",
    profile?.bestTime ?? "",
    profile?.booking ?? "",
  ].join(" ");
}

function isLakeOrRiver(city: string, place: Place): boolean {
  const lakeText = [
    place.name,
    place.address ?? "",
    place.note ?? "",
    (place.tags ?? []).join(" "),
    profileText(city, place),
  ].join(" ");
  if (LAKE.test(lakeText)) return true;
  // 名字里带河、江的多半是内河滩涂或滨江点位；地址不参与，避免「海珠区」这类误伤。
  return /[河江]/.test(place.name);
}

/**
 * 只看「这个点位本身」是否真的临海。
 * 地址只参与湖的判断：像「海珠区」「上海路」这样的地名不能当成海岸证据。
 */
export function placeWaterKind(city: string, place: Place): WaterKind {
  if (isLakeOrRiver(city, place)) return "lake";

  const seaText = [
    place.name,
    place.note ?? "",
    (place.tags ?? []).join(" "),
    profileText(city, place),
  ].join(" ");
  if (SEA.test(seaText)) return "sea";
  return "unknown";
}

/** 单个点位是否有明确的海岸证据；「沙滩」这类弱词不算。 */
export function hasStrongSeaEvidence(city: string, place: Place): boolean {
  if (isLakeOrRiver(city, place)) return false;
  const seaText = [
    place.name,
    place.note ?? "",
    (place.tags ?? []).join(" "),
    profileText(city, place),
  ].join(" ");
  if (STRONG_SEA.test(seaText)) return true;
  return (place.tags ?? []).some((tag) => /^coast$/i.test(tag));
}

/**
 * 城市层面是否靠海：要有明确的临海点位，才允许把「XX沙滩」当成海岸。
 * 内陆城市的「鲸鱼沙滩」这类人工沙滩不该生成海边心愿与文案。
 */
export function cityHasSea(city: string, places: Place[]): boolean {
  return places.some(
    (place) =>
      COASTAL_SIGHT.has(place.category) && hasStrongSeaEvidence(city, place),
  );
}

export function isSeaPlace(city: string, place: Place): boolean {
  return placeWaterKind(city, place) === "sea";
}
