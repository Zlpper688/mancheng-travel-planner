/**
 * 「这是不是同一个地方」的判定。
 *
 * 抽成独立模块是因为两个地方要用同一把尺子：
 *   · audit.ts —— 事后体检，把「同一个点排进两天」报出来；
 *   · select 的跨天去重 —— 排线时就不让这种事发生。
 * 两边各写一套的话，迟早出现「体检说重复、去重却说没重复」。
 */

/**
 * 判定键。
 *
 * 只比 id 是不够的：同一处景点在 OSM / 维基数据 / 本地知识库里各有各的 id，
 * 名字还会带后缀（「厦门大学」vs「厦门大学（思明校区）」）。实测就有一次
 * 3 天行程里排进了两次厦大、两次沙坡尾，而按 id 判重一声没吭。
 * 所以键取「去括号、去符号后的名字 + 类别」，坐标只在名字对不上时做兜底。
 */
export function placeKeyOf(place: {
  name: string;
  category: string;
  lat: number;
  lng: number;
}): string {
  const name = place.name
    .replace(/[（(【\[].*?[）)】\]]/g, "")
    .replace(/[\s·•\-—_]/g, "")
    .toLowerCase();
  return `${place.category}|${name}`;
}

/** 名字不同但离得极近（150 m 内）也算同一处，兜住「XX 东门 / XX 景区」这类录法。 */
export function nearSamePlace(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): boolean {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLng =
    (a.lng - b.lng) * 111.32 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dLat, dLng) <= 0.15;
}

/** 两处点位是不是「同一处」：键相同，或坐标在 150 m 内。 */
export function isSameSpot(
  a: { name: string; category: string; lat: number; lng: number },
  b: { name: string; category: string; lat: number; lng: number },
): boolean {
  return placeKeyOf(a) === placeKeyOf(b) || nearSamePlace(a, b);
}
