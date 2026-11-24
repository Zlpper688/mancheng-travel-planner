import type { Category } from "../types";

export const SCENIC_AREA =
  /风景名胜|风景区|景区|国家森林公园|森林公园|国家湿地公园|湿地公园|地质公园|自然保护区|旅游度假区/;

const MARQUEE_NAME =
  /博物馆|纪念馆|遗址|古城|古镇|古村|寺|庙|宫|塔|楼|阁|湖|岛|峡谷|瀑布|溶洞|山|峰/;

/**
 * OSM 没有评分/点评，但「风景区」「博物馆」这类命名和旅游业标签
 * 已经足以说明它值得专程去；用一个跨数据源统一的名气下限，
 * 避免同一座城换一个数据源就把名山古寺整批丢掉。
 */
export function marqueePopularity(input: {
  name: string;
  category: Category;
  taggedAttraction?: boolean;
}): number | null {
  if (SCENIC_AREA.test(input.name)) return 4.3;
  if (!MARQUEE_NAME.test(input.name)) return null;
  if (input.taggedAttraction || input.category === "attraction") return 4.2;
  if (input.category === "museum") return 4.15;
  if (input.category === "temple") return 4.1;
  return null;
}