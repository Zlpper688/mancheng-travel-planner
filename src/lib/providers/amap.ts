import { cached, fetchJson, mapLimit } from "../cache";
import {
  convertGcjPolylineToWgs,
  gcj02ToWgs84,
  wgs84ToGcj02,
} from "../coords";
import { getTaxiRate } from "../constants";
import { TravelError } from "../errors";
import {
  decodeAmapPolyline,
  estimateModeMinutes,
  estimateRouteDistanceKm,
  estimateTaxiFare,
  estimateTransitFare,
  mergePolylines,
  straightLine,
} from "../geo";
import type { Category, Place, TransportMode } from "../types";
import {
  classifyPlace,
  dedupePlaces,
  isChainRestaurant,
  numberOrUndefined,
  parseAmapLocation,
} from "./normalize";
import { photonCitySearch, photonReverse, photonSearch } from "./photon";
import type {
  DiscoverOptions,
  DiscoverResult,
  PlaceProvider,
  RawRoute,
  SearchOptions,
} from "./types";

const AMAP_BASE = "https://restapi.amap.com/v3";

type AmapBaseResponse = {
  status?: string;
  info?: string;
  infocode?: string;
};

type AmapPoiRaw = {
  id?: string;
  name?: string;
  type?: string;
  typecode?: string;
  address?: unknown;
  location?: string;
  cityname?: string;
  adname?: string;
  pname?: string;
  biz_ext?: unknown;
  biz_type?: string;
};

type AmapPoiResponse = AmapBaseResponse & {
  pois?: AmapPoiRaw[];
  count?: string;
};

type AmapWalkingPath = {
  distance?: string;
  duration?: string;
  steps?: { polyline?: string }[];
};

type AmapDrivingPath = {
  distance?: string;
  duration?: string;
  steps?: { polyline?: string }[];
};

type AmapTransit = {
  cost?: string;
  duration?: string;
  distance?: string;
  walking_distance?: string;
  segments?: {
    walking?: { steps?: { polyline?: string }[] };
    bus?: {
      buslines?: {
        polyline?: string;
      }[];
    };
  }[];
};

type AmapDirectionResponse = AmapBaseResponse & {
  route?: {
    paths?: AmapWalkingPath[] & AmapDrivingPath[];
    transits?: AmapTransit[];
    distance?: string;
  };
};

function getKey(): string {
  const key = process.env.AMAP_KEY?.trim();
  if (!key) {
    throw new TravelError(
      "未配置高德 Key",
      "AMAP_NOT_CONFIGURED",
      "在 .env.local 中填入 AMAP_KEY 后重启开发服务器",
    );
  }
  return key;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value !== "[]"
    ? value.trim()
    : undefined;
}

async function amapGet<T>(
  path: string,
  params: Record<string, string | number>,
  timeout = 15_000,
): Promise<T & AmapBaseResponse> {
  const key = getKey();
  const search = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(params).map(([name, value]) => [name, String(value)]),
    ),
    key,
  });
  const data = await fetchJson<T & AmapBaseResponse>(
    `${AMAP_BASE}${path}?${search.toString()}`,
    {},
    timeout,
  );
  if (data.status !== "1") {
    throw new TravelError(
      `高德服务返回错误：${data.info ?? "未知错误"}`,
      data.infocode === "10001" || data.infocode === "10009"
        ? "AMAP_KEY_INVALID"
        : "AMAP_ERROR",
      data.infocode === "10003"
        ? "今日调用配额可能已用完，可明天再试或更换 Key"
        : "检查 Key 是否为「Web服务」类型，以及控制台中的配额设置",
    );
  }
  return data;
}

const CATEGORY_FALLBACK_POPULARITY: Partial<Record<Category, number>> = {
  attraction: 3.7,
  museum: 3.5,
  park: 3.3,
  viewpoint: 3.4,
  beach: 3.5,
  street: 3.3,
  temple: 3.3,
  market: 3.2,
  nature: 3.3,
  food: 3.3,
  cafe: 3.2,
};

function mapAmapPoi(raw: AmapPoiRaw, forceHotel = false): Place | null {
  const name = asString(raw.name);
  const coordinate = parseAmapLocation(raw.location);
  if (!name || !coordinate) return null;
  const [gcjLng, gcjLat] = coordinate;
  const [lng, lat] = gcj02ToWgs84(gcjLng, gcjLat);
  const type = asString(raw.type) ?? "";
  const typecode = asString(raw.typecode) ?? "";
  const category = forceHotel
    ? "hotel"
    : classifyPlace(name, type, typecode);
  const biz =
    raw.biz_ext && typeof raw.biz_ext === "object" && !Array.isArray(raw.biz_ext)
      ? (raw.biz_ext as Record<string, unknown>)
      : {};
  const rating = numberOrUndefined(biz.rating);
  const cost = numberOrUndefined(biz.cost);
  const address = [asString(raw.adname), asString(raw.address)]
    .filter(Boolean)
    .join(" ");
  return {
    id: `amap-${asString(raw.id) ?? `${gcjLng}-${gcjLat}`}`,
    name,
    category,
    lat,
    lng,
    address: address || undefined,
    city: asString(raw.cityname),
    rating: rating && rating > 0 && rating <= 5 ? rating : undefined,
    cost: cost && cost > 0 ? cost : undefined,
    openHours: asString(biz.open_time),
    popularity:
      rating && rating > 0
        ? Math.min(5, rating)
        : (CATEGORY_FALLBACK_POPULARITY[category] ?? 3.3),
    source: "amap",
    tags: type ? type.split(";") : [],
  };
}

async function amapTextSearch(
  query: string,
  city: string | undefined,
  center: [number, number] | undefined,
  kind: "hotel" | "any",
): Promise<Place[]> {
  const limit = kind === "hotel" ? 12 : 10;
  if (city) {
    const data = await amapGet<AmapPoiResponse>("/place/text", {
      keywords: query,
      city,
      citylimit: "true",
      offset: limit,
      page: 1,
      extensions: "all",
    });
    return (data.pois ?? [])
      .map((raw) => mapAmapPoi(raw, kind === "hotel"))
      .filter((place): place is Place => Boolean(place));
  }
  if (center) {
    const [gcjLng, gcjLat] = wgs84ToGcj02(center[0], center[1]);
    const data = await amapGet<AmapPoiResponse>("/place/around", {
      keywords: query,
      location: `${gcjLng},${gcjLat}`,
      radius: 20000,
      offset: limit,
      page: 1,
      sortrule: "weight",
      extensions: "all",
    });
    return (data.pois ?? [])
      .map((raw) => mapAmapPoi(raw, kind === "hotel"))
      .filter((place): place is Place => Boolean(place));
  }
  return [];
}

type AroundSpec = {
  center: [number, number];
  radius: number;
  types: string;
  pages: number;
};

async function fetchAround(spec: AroundSpec): Promise<Place[]> {
  const [gcjLng, gcjLat] = wgs84ToGcj02(spec.center[0], spec.center[1]);
  const results: Place[] = [];
  for (let page = 1; page <= spec.pages; page++) {
    const data = await amapGet<AmapPoiResponse>(
      "/place/around",
      {
        location: `${gcjLng},${gcjLat}`,
        radius: Math.min(50000, Math.round(spec.radius)),
        types: spec.types,
        offset: 25,
        page,
        sortrule: "weight",
        extensions: "all",
      },
      18_000,
    );
    for (const raw of data.pois ?? []) {
      const place = mapAmapPoi(raw);
      if (place) results.push(place);
    }
    if ((data.pois ?? []).length < 25) break;
  }
  return results;
}

async function discoverAmap(options: DiscoverOptions): Promise<DiscoverResult> {
  const center: [number, number] =
    options.center ?? [options.hotel.lng, options.hotel.lat];
  const hotel: [number, number] = [options.hotel.lng, options.hotel.lat];
  const radius = Math.min(30_000, Math.max(8_000, options.radiusKm * 1000));
  const specs: AroundSpec[] = [
    { center, radius, types: "110000|140000", pages: 2 },
    { center: hotel, radius: Math.min(12_000, radius), types: "110000|140000|080000", pages: 1 },
    { center: hotel, radius: 5000, types: "050000", pages: 2 },
    { center: hotel, radius: 6000, types: "050500", pages: 1 },
    { center, radius: 4000, types: "050000", pages: 1 },
  ];

  const results = await mapLimit(specs, 3, (spec) => fetchAround(spec));
  const all = dedupePlaces(results.flat());

  const rawSights = all.filter(
    (place) => !["food", "cafe", "hotel", "other"].includes(place.category),
  );
  let meals = all.filter((place) => ["food", "cafe"].includes(place.category));
  const localMeals = meals.filter((place) => !isChainRestaurant(place.name));
  if (localMeals.length >= 8) meals = localMeals;

  const sights = rawSights.sort(
    (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  );
  meals = meals.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));

  const notes: string[] = [];
  if (!meals.length) {
    notes.push("附近未找到餐饮商户，已按路线位置预留用餐时间。");
  }
  if (sights.length < 6) {
    notes.push("附近可选景点较少，可以扩大活动范围或调整偏好。");
  }

  return {
    sights: sights.slice(0, 180),
    meals: meals.slice(0, 100),
    notes,
    source: "amap",
    sourceNote: "高德地图 · 商户与公交换乘实时数据",
  };
}

function fallbackRoute(
  from: Place,
  to: Place,
  mode: TransportMode,
  city: string,
): RawRoute {
  const distanceKm = Math.max(
    0.05,
    estimateRouteDistanceKm([from.lng, from.lat], [to.lng, to.lat]),
  );
  const rate = getTaxiRate(city);
  const geometry = straightLine([from.lng, from.lat], [to.lng, to.lat]);
  if (mode === "walk") {
    return {
      mode,
      durationMin: estimateModeMinutes(from, to, "walk"),
      distanceKm,
      cost: 0,
      costUnit: "person",
      estimated: true,
      geometry,
      note: "高德步行路线暂不可用，已给出估算",
    };
  }
  if (mode === "transit") {
    return {
      mode,
      durationMin: estimateModeMinutes(from, to, "transit"),
      distanceKm,
      cost: estimateTransitFare(distanceKm),
      costUnit: "person",
      estimated: true,
      geometry,
      note: "公交换乘暂不可用，已给出估算",
    };
  }
  return {
    mode,
    durationMin: estimateModeMinutes(from, to, "taxi") + 2,
    distanceKm,
    cost: estimateTaxiFare(distanceKm, rate),
    costUnit: "vehicle",
    estimated: true,
    geometry,
    note: "驾车路线暂不可用，已给出估算",
  };
}

async function amapRoute(
  from: Place,
  to: Place,
  mode: TransportMode,
  city: string,
): Promise<RawRoute> {
  const [fromLng, fromLat] = wgs84ToGcj02(from.lng, from.lat);
  const [toLng, toLat] = wgs84ToGcj02(to.lng, to.lat);
  const origin = `${fromLng},${fromLat}`;
  const destination = `${toLng},${toLat}`;
  const key = `amap:route:${mode}:${from.lng.toFixed(5)},${from.lat.toFixed(5)}:${to.lng.toFixed(5)},${to.lat.toFixed(5)}:${city}`;

  return cached(key, 6 * 60 * 60 * 1000, async () => {
    try {
      if (mode === "walk") {
        const data = await amapGet<AmapDirectionResponse>("/direction/walking", {
          origin,
          destination,
        });
        const path = data.route?.paths?.[0] as AmapWalkingPath | undefined;
        if (!path) throw new Error("no walking route");
        const distanceKm = Number(path.distance ?? 0) / 1000;
        const gcjGeometry = mergePolylines(
          (path.steps ?? []).map((step) => decodeAmapPolyline(step.polyline)),
        );
        return {
          mode,
          durationMin: Math.max(1, Math.round(Number(path.duration ?? 0) / 60)),
          distanceKm: Math.max(0.05, distanceKm),
          cost: 0,
          costUnit: "person" as const,
          estimated: false,
          geometry: gcjGeometry.length
            ? convertGcjPolylineToWgs(gcjGeometry)
            : straightLine([from.lng, from.lat], [to.lng, to.lat]),
        };
      }

      if (mode === "taxi") {
        const data = await amapGet<AmapDirectionResponse>("/direction/driving", {
          origin,
          destination,
          strategy: 0,
          extensions: "all",
        });
        const path = data.route?.paths?.[0] as AmapDrivingPath | undefined;
        if (!path) throw new Error("no driving route");
        const distanceKm = Number(path.distance ?? 0) / 1000;
        const gcjGeometry = mergePolylines(
          (path.steps ?? []).map((step) => decodeAmapPolyline(step.polyline)),
        );
        return {
          mode,
          durationMin:
            Math.max(1, Math.round(Number(path.duration ?? 0) / 60)) + 2,
          distanceKm: Math.max(0.05, distanceKm),
          cost: estimateTaxiFare(distanceKm, getTaxiRate(city)),
          costUnit: "vehicle" as const,
          estimated: false,
          geometry: gcjGeometry.length
            ? convertGcjPolylineToWgs(gcjGeometry)
            : straightLine([from.lng, from.lat], [to.lng, to.lat]),
          note: "费用按里程估算，不含拥堵加价",
        };
      }

      const cityName = city.replace(/市$/, "");
      const data = await amapGet<AmapDirectionResponse>(
        "/direction/transit/integrated",
        {
          origin,
          destination,
          city: cityName,
          cityd: cityName,
          strategy: 0,
          nightflag: 0,
        },
      );
      const transit = data.route?.transits?.[0];
      if (!transit) throw new Error("no transit route");
      const geometryParts: [number, number][][] = [];
      for (const segment of transit.segments ?? []) {
        for (const step of segment.walking?.steps ?? []) {
          geometryParts.push(decodeAmapPolyline(step.polyline));
        }
        for (const busline of segment.bus?.buslines ?? []) {
          geometryParts.push(decodeAmapPolyline(busline.polyline));
        }
      }
      const gcjGeometry = mergePolylines(geometryParts);
      const distanceKm =
        Number(transit.distance ?? data.route?.distance ?? 0) / 1000;
      const walkingKm = Number(transit.walking_distance ?? 0) / 1000;
      return {
        mode,
        durationMin: Math.max(
          1,
          Math.round(Number(transit.duration ?? 0) / 60),
        ),
        distanceKm: Math.max(0.05, distanceKm),
        cost: numberOrUndefined(transit.cost) ?? estimateTransitFare(distanceKm),
        costUnit: "person" as const,
        estimated: false,
        geometry: gcjGeometry.length
          ? convertGcjPolylineToWgs(gcjGeometry)
          : straightLine([from.lng, from.lat], [to.lng, to.lat]),
        note:
          walkingKm > 0.9
            ? `含约 ${Math.round(walkingKm * 1000)} 米步行换乘`
            : undefined,
      };
    } catch {
      return fallbackRoute(from, to, mode, city);
    }
  });
}

export const amapProvider: PlaceProvider = {
  source: "amap",
  sourceNote: "高德地图 · 商户与公交换乘实时数据",
  async search(query: string, options: SearchOptions = {}) {
    if (options.kind === "city") return photonCitySearch(query);
    try {
      const place = await cached(
        `amap:search:${query}:${options.city ?? "-"}:${options.center?.join(",") ?? "-"}:${options.kind ?? "any"}`,
        10 * 60 * 1000,
        () =>
          amapTextSearch(
            query,
            options.city,
            options.center,
            options.kind === "hotel" ? "hotel" : "any",
          ),
      );
      if (place.length) return place;
    } catch (error) {
      if (error instanceof TravelError) {
        // 酒店 / 地点搜索失败时退回 Photon，保证还能选到落脚点。
      } else {
        throw error;
      }
    }
    const fallback = await photonSearch(query, {
      limit: 10,
      center: options.center,
      maxDistanceKm: 60,
    });
    return options.kind === "hotel"
      ? fallback
          .slice(0, 8)
          .map((place) => ({ ...place, category: "hotel" as const }))
      : fallback.slice(0, 10);
  },
  async reverse(lat: number, lng: number) {
    try {
      const [gcjLng, gcjLat] = wgs84ToGcj02(lng, lat);
      const data = await amapGet<{
        regeocode?: {
          formatted_address?: string;
          addressComponent?: { city?: string; district?: string };
        };
      }>(
        "/geocode/regeo",
        { location: `${gcjLng},${gcjLat}`, extensions: "base" },
        10_000,
      );
      const formatted = data.regeocode?.formatted_address;
      if (formatted) {
        return {
          id: `amap-reverse-${lat.toFixed(5)}-${lng.toFixed(5)}`,
          name: formatted,
          category: "hotel",
          lat,
          lng,
          address: data.regeocode?.addressComponent?.city,
          source: "amap",
        };
      }
    } catch {
      // 回退到 Photon
    }
    return photonReverse(lat, lng);
  },
  discover: discoverAmap,
  route: amapRoute,
};
