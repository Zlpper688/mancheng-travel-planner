import type { Place } from "./types";

export const EARTH_RADIUS_KM = 6371.0088;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

export function haversine(a: [number, number], b: [number, number]): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function placeDistance(a: Place, b: Place): number {
  return haversine([a.lng, a.lat], [b.lng, b.lat]);
}

export function pointPlaceDistance(place: Place, point: [number, number]): number {
  return haversine([place.lng, place.lat], point);
}

export function bearing(
  from: [number, number],
  to: [number, number],
): number {
  const [lng1, lat1] = from;
  const [lng2, lat2] = to;
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const DIRECTIONS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];

export function directionLabel(deg: number): string {
  return DIRECTIONS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

export function angleDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export function estimateRouteDistanceKm(
  a: [number, number],
  b: [number, number],
): number {
  return haversine(a, b) * 1.32;
}

export function estimateModeMinutes(
  from: Place,
  to: Place,
  mode: "walk" | "transit" | "taxi",
): number {
  const direct = placeDistance(from, to);
  const routed = direct * 1.32;
  if (mode === "walk") {
    return Math.max(1, Math.round((routed / 4.6) * 60));
  }
  if (mode === "transit") {
    return Math.max(5, Math.round((routed / 17) * 60 + 7));
  }
  return Math.max(4, Math.round((routed / 24) * 60 + 3));
}

export function estimateTaxiFare(
  distanceKm: number,
  rate: { base: number; perKm: number },
): number {
  const fare = rate.base + Math.max(0, distanceKm - 3) * rate.perKm;
  return Math.max(rate.base, Math.round(fare));
}

export function estimateTransitFare(distanceKm: number): number {
  if (distanceKm <= 4) return 2;
  if (distanceKm <= 8) return 3;
  if (distanceKm <= 12) return 4;
  if (distanceKm <= 18) return 5;
  if (distanceKm <= 26) return 6;
  return 7;
}

export function roundToFive(minutes: number): number {
  return Math.round(minutes / 5) * 5;
}

export function minutesToTime(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function formatDuration(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  if (value < 60) return `${value} 分钟`;
  const h = Math.floor(value / 60);
  const m = value % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round(km * 1000))} 米`;
  return `${km.toFixed(1)} 公里`;
}

export function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededJitter(seed: number, key: string, spread = 1): number {
  const random = mulberry32((seed ^ hashString(key)) >>> 0);
  return (random() * 2 - 1) * spread;
}

export function decodeAmapPolyline(polyline: string | undefined | null): [number, number][] {
  if (!polyline) return [];
  return polyline
    .split(";")
    .map((pair) => pair.split(",").map(Number))
    .filter(
      (pair) =>
        pair.length === 2 &&
        Number.isFinite(pair[0]) &&
        Number.isFinite(pair[1]),
    )
    .map((pair) => [pair[0], pair[1]] as [number, number]);
}

export function mergePolylines(lines: [number, number][][]): [number, number][] {
  const out: [number, number][] = [];
  for (const line of lines) {
    for (const point of line) {
      const previous = out[out.length - 1];
      if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) {
        out.push(point);
      }
    }
  }
  return out;
}

export function straightLine(
  from: [number, number],
  to: [number, number],
): [number, number][] {
  return [from, to];
}

export function pathLengthKm(points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversine(points[i - 1], points[i]);
  }
  return total;
}

export function parseISODate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

export function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDaysISO(value: string, amount: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return toISODate(date);
}

export function todayISOLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function formatDateCN(value: string): string {
  const date = parseISODate(value);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

export function weekdayCN(value: string): string {
  const date = parseISODate(value);
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][
    date.getUTCDay()
  ];
}

export function formatDateRange(start: string, days: number): string {
  const end = addDaysISO(start, Math.max(0, days - 1));
  const startDate = parseISODate(start);
  const endDate = parseISODate(end);
  if (startDate.getUTCFullYear() === endDate.getUTCFullYear()) {
    if (startDate.getUTCMonth() === endDate.getUTCMonth()) {
      return `${startDate.getUTCMonth() + 1}月${startDate.getUTCDate()}日–${endDate.getUTCDate()}日`;
    }
    return `${startDate.getUTCMonth() + 1}月${startDate.getUTCDate()}日–${endDate.getUTCMonth() + 1}月${endDate.getUTCDate()}日`;
  }
  return `${startDate.getUTCFullYear()}年${startDate.getUTCMonth() + 1}月${startDate.getUTCDate()}日–${endDate.getUTCFullYear()}年${endDate.getUTCMonth() + 1}月${endDate.getUTCDate()}日`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function meanPoint(points: [number, number][]): [number, number] {
  if (!points.length) return [0, 0];
  const lng = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const lat = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return [lng, lat];
}
