import { haversine } from "../../geo";
import type { Category, Place } from "../../types";
import { cleanNameForMatch, nameSimilarity } from "../normalize";
import type { SniffBoundary, SniffSourceBreakdown } from "./types";

export const SIGHT_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
  "attraction",
  "museum",
  "park",
  "viewpoint",
  "beach",
  "street",
  "temple",
  "market",
  "nature",
]);

export function clampPopularity(value: number): number {
  return Math.min(5, Math.max(0, value));
}

export function pointInRings(
  lng: number,
  lat: number,
  rings: [number, number][][],
): boolean {
  // 奇偶规则统计全部环：外环、内环（孔洞）与多岛面都能正确处理。
  let inside = false;
  for (const ring of rings) {
    if (ring.length < 3) continue;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
      const [lngA, latA] = ring[index];
      const [lngB, latB] = ring[previous];
      const intersects =
        latA > lat !== latB > lat &&
        lng < ((lngB - lngA) * (lat - latA)) / (latB - latA || 1e-12) + lngA;
      if (intersects) inside = !inside;
    }
  }
  return inside;
}

function cityMismatch(place: Place, city: string): boolean {
  const placeCity = place.city?.trim();
  if (!placeCity) return false;
  const short = city.replace(/市$/, "").trim();
  const placeShort = placeCity.replace(/市$/, "").trim();
  if (!short || !placeShort) return false;
  if (placeShort.includes(short) || short.includes(placeShort)) return false;
  // 只拦截明确属于另一座地级市/县的地址，避免把边界附近的飞地误删。
  return /[市县区]$/.test(placeCity);
}

export function withinBoundary(
  place: Place,
  city: string,
  boundary: SniffBoundary | undefined,
  center: [number, number],
): boolean {
  if (cityMismatch(place, city)) return false;
  if (!boundary) {
    return haversine(center, [place.lng, place.lat]) <= 60;
  }
  if (boundary.rings?.length) {
    return pointInRings(place.lng, place.lat, boundary.rings);
  }
  const [minLng, minLat, maxLng, maxLat] = boundary.bbox;
  const pad = 0.04;
  return (
    place.lng >= minLng - pad &&
    place.lng <= maxLng + pad &&
    place.lat >= minLat - pad &&
    place.lat <= maxLat + pad
  );
}

function samePlace(a: Place, b: Place): boolean {
  if (a.id === b.id) return true;
  const distance = haversine([a.lng, a.lat], [b.lng, b.lat]);
  if (distance > 0.9) return false;
  const nameA = cleanNameForMatch(a.name);
  const nameB = cleanNameForMatch(b.name);
  if (nameA && nameA === nameB) return true;
  const similarity = nameSimilarity(a.name, b.name);
  return similarity >= 0.88 || (distance < 0.12 && similarity >= 0.82);
}

function mergeInto(target: Place, incoming: Place): void {
  target.rating ??= incoming.rating;
  target.cost ??= incoming.cost;
  target.costNote ??= incoming.costNote;
  target.openHours ??= incoming.openHours;
  target.address ??= incoming.address;
  target.city ??= incoming.city;
  target.note ??= incoming.note;
  target.island ??= incoming.island;
  target.wikidataId ??= incoming.wikidataId;
  // OSM 图层没有图，同一个点位的精选图不能被去重吃掉。
  target.image ??= incoming.image;
  target.commons ??= incoming.commons;
  if (
    (incoming.popularity ?? 0) > (target.popularity ?? 0)
  ) {
    target.popularity = incoming.popularity;
  }
  if (incoming.tags?.length) {
    const tags = [...(target.tags ?? [])];
    for (const tag of incoming.tags) {
      if (tags.length >= 12) break;
      if (!tags.includes(tag)) tags.push(tag);
    }
    target.tags = tags;
  }
}

export function mergePlaceLayers(layers: Place[][]): Place[] {
  const merged: Place[] = [];
  for (const layer of layers) {
    for (const place of layer) {
      const existing = merged.find((item) => samePlace(item, place));
      if (existing) mergeInto(existing, place);
      else merged.push({ ...place, tags: place.tags ? [...place.tags] : undefined });
    }
  }
  return merged;
}

export function emptyBreakdown(): SniffSourceBreakdown {
  return { amap: 0, osm: 0, wikidata: 0, demo: 0 };
}

export function distanceToCenter(place: Place, center: [number, number]): number {
  return haversine(center, [place.lng, place.lat]);
}