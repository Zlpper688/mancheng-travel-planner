import { cached, fetchJson } from "../cache";
import { haversine } from "../geo";
import type { Place } from "../types";
import { classifyPlace } from "./normalize";

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
  const name =
    props.name ||
    props.street ||
    props.locality ||
    props.district ||
    props.city ||
    "未命名地点";
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
