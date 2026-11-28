import { haversine } from "../geo";
import type { Category, Place } from "../types";
import { SCENIC_AREA } from "./fame";

const CAFE_RE =
  /咖啡|茶室|茶馆|茶空间|甜品|烘焙|奶茶|coffee|caf[eé]|tea\s*house/i;
const FOOD_RE =
  /餐厅|饭店|小吃|酒楼|菜馆|面馆|海鲜|火锅|烧烤|食堂|餐吧|大排档|酒吧|酒馆|米粉|烧肉|餐厅|restaurant|bistro|diner|bar\b/i;
const MUSEUM_RE =
  /博物馆|博物院|美术馆|纪念馆|展览馆|艺术馆|科技馆|图书馆|书院|museum|gallery/i;
const TEMPLE_RE =
  /寺|庙|庵|道观|教堂|礼拜堂|祠堂|清真寺|church|temple|shrine|cathedral/i;
const BEACH_RE = /沙滩|海滩|银滩|金滩|海滨|浴场|海边|滩|beach/i;
const VIEW_RE =
  /观景|观景台|眺望|索道|天台|灯塔|观景平台|lookout|viewpoint/i;
const PARK_RE =
  /公园|植物园|花园|绿地|湿地|绿道|动物园|园\b|park|garden/i;
const MARKET_RE = /市场|菜场|菜市|夜市|集市|market/i;
const STREET_RE =
  /步行街|老街|古街|街|路|巷|弄|里|坊|古城|古镇|村|镇|文创园|艺术区|社区|street|alley|quarter/i;
const NATURE_RE =
  /山|森林|峡谷|瀑布|溪|湖|岛|湾|湿地|自然保护区|mountain|forest|lake|island|bay/i;
const HOTEL_RE =
  /酒店|宾馆|民宿|旅馆|客栈|青旅|公寓|hotel|hostel|guesthouse|inn/i;
const ATTRACTION_RE =
  /景区|景点|遗址|炮台|城堡|古建|文化村|游乐|马戏|水族馆|海洋馆|塔|楼|阁|桥|码头|广场|attraction|zoo|aquarium|monument|memorial|castle|bridge|square/i;

export function classifyPlace(
  name: string,
  typeText = "",
  typecode = "",
  tags: Record<string, string> = {},
): Category {
  const haystack = `${name} ${typeText}`.toLowerCase();

  if (tags.tourism === "hotel" || tags.tourism === "guest_house") return "hotel";
  if (HOTEL_RE.test(name)) return "hotel";
  if (typecode.startsWith("100") && !tags.amenity) return "hotel";

  if (tags.amenity === "cafe") return "cafe";
  if (tags.amenity === "restaurant" || tags.amenity === "food_court") return "food";
  if (tags.amenity === "marketplace") return "market";
  if (CAFE_RE.test(name)) return "cafe";
  if (FOOD_RE.test(name) || typecode.startsWith("0505")) {
    return typecode.startsWith("0505") || CAFE_RE.test(haystack) ? "cafe" : "food";
  }
  if (typecode.startsWith("050")) return "food";

  // 文创园、皇家驿站常被 OSM 标成 leisure=park，但游客去的是街区/园区而非绿地。
  if (/驿站|文创园|创意园|艺术区/.test(name)) return "street";

  // 步行街 / 广场 / 商场：「春熙路」「宽窄巷子」「南锣鼓巷」「王府井」「天安门广场」
  // 在 OSM 里都不是 tourism=attraction，而是 highway=pedestrian / place=square，
  // 只按 tourism 取点会把一整类城市地标漏掉。
  if (tags.highway === "pedestrian" || tags.place === "square" || tags.shop === "mall") {
    return "street";
  }

  if (tags.tourism === "museum" || tags.tourism === "gallery") return "museum";
  if (MUSEUM_RE.test(name)) return "museum";

  if (tags.tourism === "viewpoint") return "viewpoint";
  if (tags.natural === "beach") return "beach";
  if (tags.leisure === "park" || tags.leisure === "garden") return "park";
  if (tags.historic && TEMPLE_RE.test(name)) return "temple";

  if (BEACH_RE.test(name)) return "beach";
  if (TEMPLE_RE.test(name)) return "temple";
  if (VIEW_RE.test(name)) return "viewpoint";
  if (PARK_RE.test(name)) return "park";
  if (MARKET_RE.test(name)) return "market";

  if (typecode.startsWith("110") || typecode.startsWith("140")) {
    if (STREET_RE.test(name)) return "street";
    if (NATURE_RE.test(name)) return "nature";
    return typecode.startsWith("140") ? "museum" : "attraction";
  }

  if (STREET_RE.test(name)) return "street";
  if (NATURE_RE.test(name)) return "nature";
  if (ATTRACTION_RE.test(haystack)) return "attraction";
  if (tags.tourism === "attraction") return "attraction";
  return "other";
}

export function cleanNameForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[（(【\[].*?[）)】\]]/g, "")
    .replace(/(厦门市|厦门|景区|景点|旅游区|游客中心)/g, "")
    .replace(/[\s·\-—_,，。.:：;；'"“”‘’!！?？、/\\]/g, "")
    .trim();
}

export function nameSimilarity(query: string, candidate: string): number {
  const a = cleanNameForMatch(query);
  const b = cleanNameForMatch(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) {
    return 0.68 + (Math.min(a.length, b.length) / Math.max(a.length, b.length)) * 0.3;
  }
  const charsA = new Set(a.split(""));
  const charsB = new Set(b.split(""));
  let overlap = 0;
  charsA.forEach((char) => {
    if (charsB.has(char)) overlap++;
  });
  const dice = (2 * overlap) / (charsA.size + charsB.size);
  return dice * 0.55;
}

export function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseAmapLocation(value: unknown): [number, number] | null {
  if (typeof value !== "string") return null;
  const [lng, lat] = value.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

/** 餐饮/咖啡/酒店不去参与「同名同景」合并：连锁店本来就该各算各的。 */
function mergesBySightName(category: Place["category"]): boolean {
  return !["food", "cafe", "hotel", "other"].includes(category);
}

export function dedupePlaces(places: Place[]): Place[] {
  const out: Place[] = [];
  for (const place of places) {
    const duplicate = out.some((existing) => {
      const distance =
        Math.abs(existing.lat - place.lat) + Math.abs(existing.lng - place.lng);
      const sameName =
        cleanNameForMatch(existing.name) === cleanNameForMatch(place.name);
      // 同名景点在 2 km 内按同一个地方处理。
      // 原来这里只有 0.003（约 300 m），于是「厦门大学」和「厦门大学（思明校区）」
      // 会被当成两个点，排进同一次行程的两天里——跨天重复的根因之一。
      // 景点（校区、景区大门、索道口）本来就可以差一两公里；
      // 餐饮咖啡仍用严格阈值，避免把同名的连锁店并成一间。
      const sameNameRadius =
        mergesBySightName(place.category) && mergesBySightName(existing.category)
          ? 0.02
          : 0.003;
      return (sameName && distance < sameNameRadius) || distance < 0.00008;
    });
    if (!duplicate) out.push(place);
  }
  return out;
}

const SCENIC_PARENT = new RegExp(
  `${SCENIC_AREA.source}|古镇|古城|驿站|文化园`,
);

const GATE_NAME = /(?:东|西|南|北|正|大)门$/;

/** OSM 的 name:zh 偶尔是错别字或旧称；主 name 带中文时以主 name 为准。 */
export function readOsmName(tags: Record<string, string>): string | undefined {
  const primary = (tags.name ?? "").trim();
  if (primary && /[\u4e00-\u9fa5]/.test(primary)) return primary;
  return (
    tags["name:zh-Hans"] ||
    tags["name:zh"] ||
    primary ||
    tags["name:en"]
  )?.trim();
}

/** 「嵖岈山东门」「嵖岈山南门」是同一片景区，统一回景区本体名。 */
export function normalizePoiName(raw: string): string {
  const match = raw.match(
    /^(.{2,}(?:山|峰|景区|公园|古镇|古城|寺|湖|岛|峡谷|洞|园|陵|庙|宫))(?:(?:东|西|南|北|正|大)门)$/,
  );
  return match?.[1] ?? raw;
}

/** 景区内部的观景台、花海、某座峰不该和景区本体平级成候选。 */
export function collapseScenicChildren(places: Place[]): Place[] {
  const parents = places.filter((place) => SCENIC_PARENT.test(place.name));
  if (!parents.length) return places;
  return places.filter((place) => {
    if (parents.includes(place)) return true;
    if (place.category === "museum" || place.category === "temple") return true;
    // 景区大门可能离游客中心几公里，单独作为候选没有意义。
    const radius = GATE_NAME.test(place.name) ? 5 : 2;
    return !parents.some(
      (parent) =>
        parent.id !== place.id &&
        haversine([parent.lng, parent.lat], [place.lng, place.lat]) < radius,
    );
  });
}

export function isChainRestaurant(name: string): boolean {
  return /星巴克|瑞幸|麦当劳|肯德基|汉堡王|必胜客|赛百味|华莱士|蜜雪冰城|正新鸡排|绝味鸭脖|周黑鸭/.test(
    name,
  );
}

export function cityShortName(city: string): string {
  return city.replace(/市$/, "").trim();
}
