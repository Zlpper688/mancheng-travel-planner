import type { PlanResult, Place, StopPlan } from "./types";
import { findPlaceProfile } from "./tips/lookup";

/**
 * 落地支持（宪法 B 块）：跳转 + 行前待办。
 *
 * 定位很克制：
 * 1. 只做**跳转**，不碰支付、库存、退改（宪法第 11 节）。
 *    用高德官方 URI API（不需要 Key，H5 可直接打开 App），
 *    门票只给搜索入口，让用户自己在官方渠道买。
 * 2. 不编造票价与放票规则：预约信息全部来自 PLACE_PROFILES 的
 *    booking / bookingNote（有 source 字段注明整理来源）。
 * 3. 行前待办是**汇总**，不是新数据——把散在点位上的预约/票务拎成一张清单，
 *    免得用户翻完整个行程才发现鼓浪屿要实名船票。
 */

const AMAP_MARKER = "https://uri.amap.com/marker";
const AMAP_SEARCH = "https://uri.amap.com/search";

/** 高德地图定位到该点（H5 打开后可直接唤起 App 导航）。 */
export function navUrl(place: Place): string {
  const params = new URLSearchParams({
    position: `${place.lng.toFixed(6)},${place.lat.toFixed(6)}`,
    name: place.name.slice(0, 40),
    src: "mancheng",
    coordinate: "gaode",
    callnative: "1",
  });
  return `${AMAP_MARKER}?${params.toString()}`;
}

/** 高德搜「城市 + 景点名」，落地页里能直接看到门票与官方购票入口。 */
export function ticketSearchUrl(place: Place, city: string): string {
  const params = new URLSearchParams({
    keyword: `${city}${place.name} 门票`.slice(0, 60),
    city: city.slice(0, 20),
    src: "mancheng",
    callnative: "1",
  });
  return `${AMAP_SEARCH}?${params.toString()}`;
}

export interface BookingItem {
  day: number;
  dayDate: string;
  placeName: string;
  placeId: string;
  /** 票务/预约的原始描述，如「船票实名预约」「门票约 50」。 */
  booking: string;
  /** 补充说明，来自 profile.bookingNote。 */
  note?: string;
  /** 需要提前预约（而不是现场买票）。 */
  needsReservation: boolean;
  source: string;
}

/**
 * 从行程里汇总「出发前要办的事」。
 *
 * 判据：
 * - profile.booking 含「预约 / 放票 / 摇号 / 实名」→ 需要提前约
 * - 其余含「门票」的只提示现场/线上买票，不占用「必须提前」名额
 */
export function collectBookings(plan: PlanResult, city: string): BookingItem[] {
  const items: BookingItem[] = [];
  const seen = new Set<string>();
  for (const day of plan.days) {
    for (const stop of day.stops) {
      if (stop.kind !== "sight") continue;
      const place = stop.place;
      if (seen.has(place.id)) continue;
      const profile = findPlaceProfile(place.city ?? city, place.name);
      if (!profile?.booking) continue;
      const needsReservation = /预约|放票|摇号|实名/.test(profile.booking);
      // 既不需要预约、又没有票价信息的，不算待办（避免清单里全是噪音）。
      if (!needsReservation && !/门票|票/.test(profile.booking)) continue;
      seen.add(place.id);
      items.push({
        day: day.index,
        dayDate: day.date,
        placeName: place.name,
        placeId: place.id,
        booking: profile.booking,
        note: profile.bookingNote,
        needsReservation,
        source: profile.source,
      });
    }
  }
  // 必须先约的排前面，其次按天数。
  return items.sort(
    (a, b) =>
      Number(b.needsReservation) - Number(a.needsReservation) || a.day - b.day,
  );
}

export function reservationCount(items: BookingItem[]): number {
  return items.filter((item) => item.needsReservation).length;
}

/** 行前待办的一句话摘要，放进 dataNotes / 行程头部。 */
export function bookingSummary(items: BookingItem[]): string | null {
  const must = reservationCount(items);
  if (!items.length) return null;
  if (!must) {
    return `这趟有 ${items.length} 处需要买票，点开点位可直接跳转查询。`;
  }
  return `出发前要办 ${must} 件事：${items
    .filter((item) => item.needsReservation)
    .slice(0, 3)
    .map((item) => item.placeName)
    .join("、")}${must > 3 ? " 等" : ""}需要提前预约。`;
}

/** 判断某个停留点是否值得显示「查票」入口。 */
export function hasTicketInfo(stop: StopPlan, city: string): boolean {
  if (stop.kind !== "sight") return false;
  if (stop.ticket) return true;
  const profile = findPlaceProfile(stop.place.city ?? city, stop.place.name);
  return Boolean(profile?.booking);
}
