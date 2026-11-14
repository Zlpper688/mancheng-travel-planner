// 高德使用 GCJ-02，OpenStreetMap / MapLibre 使用 WGS-84。
// 统一在服务端转换，前端地图只处理 WGS-84。

const PI = Math.PI;
const SEMI_MAJOR = 6378245.0;
const ECCENTRICITY = 0.00669342162296594323;

function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(lng: number, lat: number): number {
  let ret =
    -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat +
    0.2 * Math.sqrt(Math.abs(lng));
  ret +=
    ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(lat * PI) + 40.0 * Math.sin((lat / 3.0) * PI)) * 2.0) /
    3.0;
  ret +=
    ((160.0 * Math.sin((lat / 12.0) * PI) +
      320 * Math.sin((lat * PI) / 30.0)) *
      2.0) /
    3.0;
  return ret;
}

function transformLng(lng: number, lat: number): number {
  let ret =
    300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat +
    0.1 * Math.sqrt(Math.abs(lng));
  ret +=
    ((20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) *
      2.0) /
    3.0;
  ret +=
    ((20.0 * Math.sin(lng * PI) + 40.0 * Math.sin((lng / 3.0) * PI)) * 2.0) /
    3.0;
  ret +=
    ((150.0 * Math.sin((lng / 12.0) * PI) +
      300.0 * Math.sin((lng / 30.0) * PI)) *
      2.0) /
    3.0;
  return ret;
}

export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - ECCENTRICITY * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((SEMI_MAJOR * (1 - ECCENTRICITY)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((SEMI_MAJOR / sqrtMagic) * Math.cos(radLat) * PI);
  return [lng + dLng, lat + dLat];
}

export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let wgsLng = lng;
  let wgsLat = lat;
  for (let i = 0; i < 2; i++) {
    const [gcjLng, gcjLat] = wgs84ToGcj02(wgsLng, wgsLat);
    wgsLng += lng - gcjLng;
    wgsLat += lat - gcjLat;
  }
  return [wgsLng, wgsLat];
}

export function convertGcjPolylineToWgs(
  points: [number, number][],
): [number, number][] {
  return points.map(([lng, lat]) => gcj02ToWgs84(lng, lat));
}

export function convertWgsPolylineToGcj(
  points: [number, number][],
): [number, number][] {
  return points.map(([lng, lat]) => wgs84ToGcj02(lng, lat));
}
