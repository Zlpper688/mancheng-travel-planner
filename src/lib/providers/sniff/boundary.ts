import { cached, fetchJson } from "../../cache";
import { convertGcjPolylineToWgs } from "../../coords";
import { pointInRings } from "./shared";
import type { SniffBoundary } from "./types";

type DatavFeature = {
  properties?: { name?: string; adcode?: number | string };
  geometry?: { type?: string; coordinates?: unknown };
};

type DatavCollection = {
  features?: DatavFeature[];
};

type Ring = [number, number][];

const DATAV_ROOT = "https://geo.datav.aliyun.com/areas_v3/bound";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MUNICIPALITIES = new Set(["110000", "120000", "310000", "500000"]);

function ringsOf(geometry: DatavFeature["geometry"]): Ring[] {
  if (!geometry?.coordinates) return [];
  const rings: Ring[] = [];
  const pushPolygon = (polygon: unknown) => {
    if (!Array.isArray(polygon)) return;
    for (const ring of polygon) {
      if (!Array.isArray(ring)) continue;
      const points = ring
        .filter(
          (point): point is [number, number] =>
            Array.isArray(point) &&
            point.length >= 2 &&
            Number.isFinite(Number(point[0])) &&
            Number.isFinite(Number(point[1])),
        )
        .map((point) => [Number(point[0]), Number(point[1])] as [number, number]);
      if (points.length >= 3) {
        rings.push(convertGcjPolylineToWgs(points));
      }
    }
  };
  if (geometry.type === "Polygon") {
    pushPolygon(geometry.coordinates);
  } else if (geometry.type === "MultiPolygon") {
    if (Array.isArray(geometry.coordinates)) {
      for (const polygon of geometry.coordinates) pushPolygon(polygon);
    }
  }
  return rings;
}

function bboxOf(rings: Ring[]): [number, number, number, number] {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}

function shortName(value: string): string {
  return value
    .replace(/(特别行政区|维吾尔自治区|壮族自治区|回族自治区|自治区|自治州|地区|省|市|盟|县)$/g, "")
    .trim();
}

function nameMatches(featureName: string | undefined, city: string): boolean {
  if (!featureName) return false;
  const a = shortName(featureName);
  const b = shortName(city);
  return Boolean(a && b) && (a === b || a.includes(b) || b.includes(a));
}

function contains(feature: DatavFeature, center: [number, number]): boolean {
  const rings = ringsOf(feature.geometry);
  return rings.length > 0 && pointInRings(center[0], center[1], rings);
}

function toBoundary(
  feature: DatavFeature,
  fallbackName: string,
): SniffBoundary | null {
  const rings = ringsOf(feature.geometry);
  if (!rings.length) return null;
  const adcode = feature.properties?.adcode
    ? String(feature.properties.adcode)
    : undefined;
  return {
    name: feature.properties?.name || fallbackName,
    bbox: bboxOf(rings),
    rings,
    adcode,
  };
}

async function datavCollection(
  adcode: string,
  key: string,
): Promise<DatavCollection | null> {
  return cached(
    `datav:${key}:${adcode}`,
    WEEK_MS,
    () => fetchJson<DatavCollection>(`${DATAV_ROOT}/${adcode}_full.json`, {}, 15_000),
    { cacheIf: (value) => Boolean(value?.features?.length) },
  );
}

/**
 * DataV（阿里云）行政区边界：覆盖中国城市，坐标 GCJ-02，转为 WGS-84 后用于裁剪。
 * 先按中心点找省，再找省内城市；直辖市直接使用省级边界。
 */
export async function datavCityBoundary(
  city: string,
  center: [number, number],
): Promise<SniffBoundary | null> {
  return cached(
    `datav:city:${city}:${center[0].toFixed(2)}:${center[1].toFixed(2)}`,
    WEEK_MS,
    async () => {
      const china = await datavCollection("100000", "china");
      const provinces = china?.features ?? [];
      if (!provinces.length) return null;

      const province =
        provinces.find((feature) => nameMatches(feature.properties?.name, city)) ??
        provinces.find((feature) => contains(feature, center));
      if (!province) return null;
      const provinceAdcode = province.properties?.adcode
        ? String(province.properties.adcode)
        : "";
      if (!provinceAdcode) return null;

      if (MUNICIPALITIES.has(provinceAdcode)) {
        return toBoundary(province, city);
      }

      const provinceData = await datavCollection(provinceAdcode, "province");
      const cities = provinceData?.features ?? [];
      if (!cities.length) return toBoundary(province, city);

      const cityFeature =
        cities.find((feature) => nameMatches(feature.properties?.name, city)) ??
        cities.find((feature) => contains(feature, center));
      if (cityFeature) return toBoundary(cityFeature, city);

      return toBoundary(province, city);
    },
    { cacheIf: (value) => Boolean(value?.rings?.length) },
  ).catch(() => null);
}