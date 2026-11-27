/**
 * 本地城市搜索：零延迟、离线可用的一层。
 *
 * 为什么需要这一层：城市搜索原本直接走 Photon，而 Photon 在国内网络下
 * 实测单次 10.7s、且多个城市返回 0 条。用户打的第一个字就卡在那里，
 * 而这座城市的坐标我们**本来就有**（知识库里 122 个目的地的中心点）。
 *
 * 排序规则（决定用户会不会选错城市，必须显式）：
 *   完全相等 > 去掉「市/县/区」后相等 > 前缀命中 > 包含查询 > 查询包含城市名
 *
 * 刻意不做的事：**不做模糊纠错**。宁可返回空让上层去问外部地理编码，
 * 也不要把「南」猜成「南京」——猜错会让用户以为系统认错了地方。
 */
import { LOCAL_CITIES, type LocalCity } from "../content/cities.generated";

/** 行政区后缀，比较前先剥掉：用户写「南京市」和「南京」应该等价。 */
const ADMIN_SUFFIX = /(特别行政区|自治区|自治州|地区|城市|市|县|区)$/;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function stripSuffix(value: string): string {
  const stripped = value.replace(ADMIN_SUFFIX, "");
  // 「上海市」→「上海」；但「市区」这类剥完只剩一个字的不要，避免误伤。
  return stripped.length >= 2 ? stripped : value;
}

/** 命中强度：数字越小越靠前。0 = 完全相等。 */
function rankOf(city: LocalCity, query: string): number | null {
  const name = normalize(city.name);
  const bareName = normalize(stripSuffix(city.name));
  const bareQuery = normalize(stripSuffix(query));

  if (name === query) return 0;
  if (bareName === bareQuery) return 1;
  if (name.startsWith(query)) return 2;
  if (bareName.startsWith(bareQuery)) return 3;
  if (name.includes(query)) return 4;
  // 「去南京」「南京周边」这类：查询里包含城市名，但要求名字够长，避免「京」这种单字乱命中。
  if (name.length >= 2 && query.includes(name)) return 5;
  return null;
}

/**
 * 在本地索引里找城市。空查询、无匹配都返回空数组。
 * @param limit 最多返回几条，默认 8。
 */
export function searchLocalCities(query: string, limit = 8): LocalCity[] {
  const q = normalize(query);
  if (!q) return [];

  const hits: { city: LocalCity; rank: number }[] = [];
  for (const city of LOCAL_CITIES) {
    const rank = rankOf(city, q);
    if (rank !== null) hits.push({ city, rank });
  }
  if (!hits.length) return [];

  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    // 同强度时短名优先：搜「南京」时「南京」该在「南京路」前面。
    if (a.city.name.length !== b.city.name.length) {
      return a.city.name.length - b.city.name.length;
    }
    return a.city.name.localeCompare(b.city.name, "zh-Hans-CN");
  });

  return hits.slice(0, Math.max(1, limit)).map((hit) => hit.city);
}

/** 按名字精确取坐标（含「南京市」这类全称）。找不到返回 null。 */
export function localCityCenter(name: string): LocalCity | null {
  const hits = searchLocalCities(name, 1);
  const first = hits[0];
  if (!first) return null;
  // 只有「就是这座城市」才返回，避免把「南京」的坐标安到「南京路」上。
  const rank = rankOf(first, normalize(name));
  return rank !== null && rank <= 1 ? first : null;
}
