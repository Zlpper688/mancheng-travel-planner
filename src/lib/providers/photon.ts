import { cached, fetchJson, mapLimit } from "../cache";
import { haversine } from "../geo";
import type { Category, Place } from "../types";
import { marqueePopularity } from "./fame";
import {
  classifyPlace,
  collapseScenicChildren,
  normalizePoiName,
} from "./normalize";

type PhotonProperties = {
  osm_type?: string;
  osm_id?: number;
  osm_key?: string;
  osm_value?: string;
  type?: string;
  name?: string;
  street?: string;
  housenumber?: string;
  locality?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
  postcode?: string;
  extent?: [number, number, number, number];
  extra?: { admin_level?: string };
};

type PhotonFeature = {
  properties: PhotonProperties;
  geometry: { coordinates: [number, number] };
};

type PhotonResponse = {
  features?: PhotonFeature[];
};

function mapFeature(feature: PhotonFeature): Place | null {
  const props = feature.properties ?? {};
  const coords = feature.geometry?.coordinates;
  if (!coords || coords.length !== 2) return null;
  const [lng, lat] = coords;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  const name = normalizePoiName(
    props.name ||
      props.street ||
      props.locality ||
      props.district ||
      props.city ||
      "未命名地点",
  );
  const tags: Record<string, string> = {};
  if (props.osm_key && props.osm_value) {
    tags[props.osm_key] = props.osm_value;
  }
  const addressParts = [
    props.state,
    props.city && props.city !== props.state ? props.city : "",
    props.district,
    props.street,
    props.housenumber,
  ].filter(Boolean);
  return {
    id: `osm-${props.osm_type ?? "x"}-${props.osm_id ?? `${lng}-${lat}`}`,
    name,
    category: classifyPlace(
      name,
      `${props.osm_key ?? ""}=${props.osm_value ?? ""}`,
      "",
      tags,
    ),
    lat,
    lng,
    address: addressParts.length ? addressParts.join(" · ") : undefined,
    city: props.city,
    source: "osm",
    tags: [props.osm_key, props.osm_value].filter(Boolean) as string[],
  };
}

export const PHOTON_SIGHT_INCLUDES = [
  "osm.tourism.attraction",
  "osm.tourism.museum",
  "osm.tourism.viewpoint",
  "osm.leisure.park",
  "osm.leisure.nature_reserve",
  "osm.amenity.place_of_worship",
  "osm.natural.peak",
  "osm.natural.beach",
] as const;

export const PHOTON_DEEP_SIGHT_INCLUDES = [
  ...PHOTON_SIGHT_INCLUDES,
  "osm.tourism.gallery",
  "osm.tourism.theme_park",
  "osm.tourism.zoo",
  "osm.tourism.aquarium",
  "osm.leisure.garden",
  "osm.historic.monument",
  "osm.historic.castle",
  "osm.historic.ruins",
  "osm.historic.archaeological_site",
  "osm.amenity.marketplace",
  "osm.natural.waterfall",
  "osm.natural.cave_entrance",
] as const;

export const PHOTON_HOTEL_INCLUDES = [
  "osm.tourism.hotel",
  "osm.tourism.guest_house",
  "osm.tourism.hostel",
  "osm.tourism.apartment",
  "osm.tourism.motel",
] as const;

const PHOTON_POPULARITY: Partial<Record<Category, number>> = {
  attraction: 3.92,
  museum: 3.9,
  viewpoint: 3.85,
  beach: 3.9,
  nature: 3.72,
  temple: 3.68,
  street: 3.6,
  park: 3.55,
  market: 3.5,
  hotel: 3.2,
};

function photonPopularity(place: Place): number {
  let score = PHOTON_POPULARITY[place.category] ?? 3.4;
  const marquee = marqueePopularity({
    name: place.name,
    category: place.category,
    taggedAttraction:
      (place.tags ?? []).includes("tourism") &&
      (place.tags ?? []).includes("attraction"),
  });
  if (marquee !== null) score = Math.max(score, marquee);
  return Math.min(5, Math.round(score * 100) / 100);
}

function bboxFor(center: [number, number], radiusKm: number): string {
  const latDelta = radiusKm / 111;
  const lngDelta =
    radiusKm /
    (111 * Math.max(0.2, Math.cos((center[1] * Math.PI) / 180)));
  return [
    center[0] - lngDelta,
    center[1] - latDelta,
    center[0] + lngDelta,
    center[1] + latDelta,
  ]
    .map((value) => value.toFixed(4))
    .join(",");
}

/**
 * Photon 只按名字搜索时，小城市会完全搜不到点位；include 分类 + bbox
 * 才能在不依赖 Overpass/Wikidata 的情况下枚举一座城有什么。
 */
export async function photonCategorySearch(options: {
  center: [number, number];
  radiusKm: number;
  categories: readonly string[];
  limit?: number;
}): Promise<Place[]> {
  const { center, radiusKm, categories, limit = 100 } = options;
  const bbox = bboxFor(center, radiusKm);
  const batches = await mapLimit([...categories], 3, async (category) => {
    const params = new URLSearchParams({
      bbox,
      limit: String(limit),
      include: category,
    });
    const key = `photon:category:${category}:${bbox}:${limit}`;
    return cached(
      key,
      10 * 60 * 1000,
      async () => {
        try {
          const data = await fetchJson<PhotonResponse>(
            `https://photon.komoot.io/api/?${params.toString()}`,
            {},
            10_000,
          );
          const places: Place[] = [];
          for (const feature of data.features ?? []) {
            const place = mapFeature(feature);
            if (place) {
              places.push({ ...place, popularity: photonPopularity(place) });
            }
          }
          return places;
        } catch {
          return [];
        }
      },
      { cacheIf: (value) => value.length > 0 },
    );
  });

  const out: Place[] = [];
  for (const place of batches
    .flat()
    .filter(
      (place) =>
        haversine(center, [place.lng, place.lat]) <= radiusKm * 1.05,
    )
    .sort(
      (a, b) =>
        (b.popularity ?? 0) - (a.popularity ?? 0) ||
        haversine(center, [a.lng, a.lat]) - haversine(center, [b.lng, b.lat]),
    )) {
    if (
      out.some(
        (existing) =>
          existing.name === place.name &&
          haversine([existing.lng, existing.lat], [place.lng, place.lat]) < 5,
      )
    ) {
      continue;
    }
    out.push(place);
  }
  return collapseScenicChildren(out);
}

export async function photonSearch(
  query: string,
  options: {
    limit?: number;
    center?: [number, number];
    maxDistanceKm?: number;
  } = {},
): Promise<Place[]> {
  const { limit = 10, center, maxDistanceKm = 80 } = options;
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  if (center) {
    params.set("lat", String(center[1]));
    params.set("lon", String(center[0]));
  }
  const url = `https://photon.komoot.io/api/?${params.toString()}`;
  const cacheKey = `photon:search:${query}:${center?.join(",") ?? "-"}:${limit}`;
  return cached(cacheKey, 10 * 60 * 1000, async () => {
    const data = await fetchJson<PhotonResponse>(url, {}, 12_000);
    return (data.features ?? [])
      .map(mapFeature)
      .filter((place): place is Place => Boolean(place))
      .filter((place) => {
        if (!center) return true;
        return haversine(center, [place.lng, place.lat]) <= maxDistanceKm;
      });
  });
}

export async function photonReverse(lat: number, lng: number): Promise<Place | null> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    limit: "1",
  });
  const cacheKey = `photon:reverse:${lat.toFixed(5)}:${lng.toFixed(5)}`;
  return cached(cacheKey, 30 * 60 * 1000, async () => {
    const data = await fetchJson<PhotonResponse>(
      `https://photon.komoot.io/reverse?${params.toString()}`,
      {},
      12_000,
    );
    const feature = data.features?.[0];
    return feature ? mapFeature(feature) : null;
  });
}

export interface CityBoundaryInfo {
  name: string;
  center: [number, number];
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
  /** Overpass area id（仅当城市对应 OSM relation 时可用） */
  areaId?: number;
}

export async function photonCityBoundary(
  query: string,
  near?: [number, number],
): Promise<CityBoundaryInfo | null> {
  const params = new URLSearchParams({ q: query, limit: "8" });
  if (near) {
    params.set("lat", String(near[1]));
    params.set("lon", String(near[0]));
  }
  const cacheKey = `photon:city-boundary:${query}:${near?.join(",") ?? "-"}`;
  return cached(cacheKey, 24 * 60 * 60 * 1000, async () => {
    const data = await fetchJson<PhotonResponse>(
      `https://photon.komoot.io/api/?${params.toString()}`,
      {},
      12_000,
    );
    const short = query.replace(/市$/, "").trim();
    let best: {
      score: number;
      info: CityBoundaryInfo;
    } | null = null;

    for (const feature of data.features ?? []) {
      const props = feature.properties ?? {};
      const extent = props.extent;
      const coords = feature.geometry?.coordinates;
      if (
        !Array.isArray(extent) ||
        extent.length !== 4 ||
        !coords ||
        coords.length !== 2
      ) {
        continue;
      }
      const [minLng, maxLat, maxLng, minLat] = extent;
      if (
        ![minLng, minLat, maxLng, maxLat].every((value) =>
          Number.isFinite(value),
        ) ||
        maxLng <= minLng ||
        maxLat <= minLat
      ) {
        continue;
      }
      const name = props.name ?? "";
      const type = props.type ?? "";
      const adminLevel = Number(props.extra?.admin_level ?? 99);
      let score = 0;
      if (type === "city") score += 12;
      else if (["district", "county", "state", "region"].includes(type)) {
        score += 5;
      }
      if (adminLevel <= 5) score += 6;
      else if (adminLevel <= 6) score += 4;
      if (short && name.includes(short)) score += 9;
      if (props.osm_type === "R") score += 2;
      if (near) {
        score -= haversine(near, [coords[0], coords[1]]) / 25;
      }
      if (!best || score > best.score) {
        best = {
          score,
          info: {
            name: name || query,
            center: [coords[0], coords[1]],
            bbox: [minLng, minLat, maxLng, maxLat],
            areaId:
              props.osm_type === "R" && props.osm_id
                ? 3_600_000_000 + props.osm_id
                : undefined,
          },
        };
      }
    }
    return best?.info ?? null;
  });
}

const CITY_TYPES = new Set([
  "city",
  "district",
  "county",
  "state",
  "locality",
  "town",
  "village",
  "region",
  "borough",
]);

export async function photonCitySearch(query: string): Promise<Place[]> {
  const results = await photonSearch(query, { limit: 12, maxDistanceKm: 20_000 });
  const cities = results.filter((place) => {
    const raw = place.tags ?? [];
    return (
      CITY_TYPES.has(raw[0] ?? "") ||
      CITY_TYPES.has(raw[1] ?? "") ||
      /市$|区$|县$|镇$/.test(place.name)
    );
  });
  const pool = cities.length >= 2 ? cities : results.filter((place) => /市$|区$|县$/.test(place.name));
  const seen = new Set<string>();
  return pool
    .filter((place) => {
      const key = `${place.name}-${place.lat.toFixed(2)}-${place.lng.toFixed(2)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}
