import type { Category, Place } from "../types";

const CAFE_RE =
  /咖啡|茶室|茶馆|茶空间|甜品|烘焙|奶茶|coffee|caf[eé]|tea\s*house/i;
const FOOD_RE =
  /餐厅|饭店|小吃|酒楼|菜馆|面馆|海鲜|火锅|烧烤|食堂|餐吧|大排档|酒吧|酒馆|米粉|烧肉|餐厅|restaurant|bistro|diner|bar\b/i;
const MUSEUM_RE =
  /博物馆|博物院|美术馆|纪念馆|展览馆|艺术馆|科技馆|图书馆|书院|museum|gallery/i;
const TEMPLE_RE =
  /寺|庙|庵|道观|教堂|礼拜堂|祠堂|清真寺|church|temple|shrine|cathedral/i;
const BEACH_RE = /沙滩|海滩|海滨|浴场|海边|beach/i;
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

export function dedupePlaces(places: Place[]): Place[] {
  const out: Place[] = [];
  for (const place of places) {
    const duplicate = out.some((existing) => {
      const distance =
        Math.abs(existing.lat - place.lat) + Math.abs(existing.lng - place.lng);
      const sameName =
        cleanNameForMatch(existing.name) === cleanNameForMatch(place.name);
      return (sameName && distance < 0.003) || distance < 0.00008;
    });
    if (!duplicate) out.push(place);
  }
  return out;
}

export function isChainRestaurant(name: string): boolean {
  return /星巴克|瑞幸|麦当劳|肯德基|汉堡王|必胜客|赛百味|华莱士|蜜雪冰城|正新鸡排|绝味鸭脖|周黑鸭/.test(
    name,
  );
}

export function cityShortName(city: string): string {
  return city.replace(/市$/, "").trim();
}
