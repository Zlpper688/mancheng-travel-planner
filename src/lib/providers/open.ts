import { cached, fetchJson } from "../cache";
import { getTaxiRate } from "../constants";
import { DEMO_NOTE, XIAMEN_MEALS, XIAMEN_SIGHTS, isDemoCity } from "../demo/xiamen";
import {
  estimateModeMinutes,
  estimateRouteDistanceKm,
  estimateTaxiFare,
  estimateTransitFare,
  haversine,
  straightLine,
} from "../geo";
import type { Category, Place, TransportMode } from "../types";
import {
  classifyPlace,
  dedupePlaces,
  isChainRestaurant,
} from "./normalize";
import { photonCitySearch, photonReverse, photonSearch } from "./photon";
import type {
  DiscoverOptions,
  DiscoverResult,
  PlaceProvider,
  RawRoute,
  SearchOptions,
} from "./types";

type OverpassElement = {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements?: OverpassElement[];
};

function overpassAddress(tags: Record<string, string>): string | undefined {
  const parts = [
    tags["addr:district"],
    tags["addr:street"],
    tags["addr:housenumber"],
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : tags["addr:full"];
}

const POPULARITY_BASE: Partial<Record<Category, number>> = {
  attraction: 3.7,
  museum: 3.5,
  park: 3.2,
  viewpoint: 3.4,
  beach: 3.5,
  street: 3.2,
  temple: 3.2,
  market: 3.2,
  nature: 3.3,
  food: 3.2,
  cafe: 3.1,
};

function mapOverpassElement(element: OverpassElement): Place | null {
  const tags = element.tags ?? {};
  const name = tags["name:zh"] || tags.name || tags["name:en"];
  if (!name) return null;
  const lat = element.lat ?? element.center?.lat;
  const lng = element.lon ?? element.center?.lon;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng)
  ) {
    return null;
  }
  const category = classifyPlace(
    name,
    Object.entries(tags)
      .map(([key, value]) => `${key}=${value}`)
      .join(" "),
    "",
    tags,
  );
  let popularity = POPULARITY_BASE[category] ?? 3;
  if (tags.wikidata) popularity += 1;
  if (tags.wikipedia) popularity += 0.5;
  if (tags.tourism === "attraction") popularity += 0.3;
  const notes = tags.description?.slice(0, 80);
  return {
    id: `osm-${element.type}-${element.id}`,
    name,
    category,
    lat,
    lng,
    address: overpassAddress(tags),
    city: tags["addr:city"],
    openHours: tags.opening_hours,
    popularity: Math.min(5, popularity),
    note: notes,
    source: "osm",
    tags: Object.values(tags).slice(0, 8),
  };
}

async function overpassQuery(query: string): Promise<Place[] | null> {
  try {
    const body = new URLSearchParams({ data: query }).toString();
    const data = await fetchJson<OverpassResponse>(
      "https://overpass-api.de/api/interpreter",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      10_000,
    );
    return (data.elements ?? [])
      .map(mapOverpassElement)
      .filter((place): place is Place => Boolean(place));
  } catch {
    return null;
  }
}

type SparqlBinding = {
  item?: { value: string };
  itemLabel?: { value: string };
  coord?: { value: string };
  typeLabel?: { value: string };
  sitelinks?: { value: string };
};

type SparqlResponse = {
  results?: { bindings?: SparqlBinding[] };
};

const WIKIDATA_TYPES = [
  "Q570116", // 旅游景点
  "Q33506", // 博物馆
  "Q22698", // 公园
  "Q40080", // 海滩
  "Q839954", // 历史遗址
  "Q44539", // 寺庙
  "Q16970", // 教堂
  "Q12280", // 桥
  "Q1329623", // 市场
  "Q11707", // 餐厅
  "Q30022", // 咖啡馆
  "Q23413", // 城堡
  "Q5003624", // 纪念碑
  "Q23397", // 湖泊
  "Q42195", // 塔
  "Q1107656", // 园林
  "Q174782", // 广场
  "Q43501", // 动物园
].map((id) => `wd:${id}`);

function parseWktPoint(value: string): [number, number] | null {
  const match = value.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
  if (!match) return null;
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

async function wikidataSearch(
  center: [number, number],
  radiusKm: number,
): Promise<Place[]> {
  const sparql = `SELECT ?item ?itemLabel ?coord ?typeLabel ?sitelinks WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord.
    bd:serviceParam wikibase:center "Point(${center[0]} ${center[1]})"^^geo:wktLiteral.
    bd:serviceParam wikibase:radius "${Math.min(radiusKm, 18)}".
  }
  ?item wdt:P31 ?type.
  VALUES ?type { ${WIKIDATA_TYPES.join(" ")} }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
} ORDER BY DESC(?sitelinks) LIMIT 90`;

  try {
    const data = await fetchJson<SparqlResponse>(
      "https://query.wikidata.org/sparql",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Accept: "application/sparql-results+json",
        },
        body: new URLSearchParams({ query: sparql }).toString(),
      },
      18_000,
    );
    const places: Place[] = [];
    for (const binding of data.results?.bindings ?? []) {
      const name = binding.itemLabel?.value;
      const coord = binding.coord?.value;
      if (!name || !coord) continue;
      const point = parseWktPoint(coord);
      if (!point) continue;
      const typeLabel = binding.typeLabel?.value ?? "";
      const sitelinks = Number(binding.sitelinks?.value ?? 0);
      const category = classifyPlace(name, typeLabel);
      if (category === "hotel" || category === "other") continue;
      places.push({
        id: `wikidata-${binding.item?.value.split("/").pop() ?? name}`,
        name,
        category,
        lat: point[1],
        lng: point[0],
        source: "wikidata",
        popularity: Math.min(5, 3.4 + Math.log10(1 + Math.max(0, sitelinks)) * 0.75),
        tags: typeLabel ? [typeLabel] : [],
      });
    }
    return dedupePlaces(places);
  } catch {
    return [];
  }
}

function routeFallback(
  from: Place,
  to: Place,
  mode: TransportMode,
  city: string,
  reason: string,
): RawRoute {
  const distanceKm = Math.max(
    0.05,
    estimateRouteDistanceKm([from.lng, from.lat], [to.lng, to.lat]),
  );
  const rate = getTaxiRate(city);
  if (mode === "walk") {
    return {
      mode,
      durationMin: estimateModeMinutes(from, to, "walk"),
      distanceKm,
      cost: 0,
      costUnit: "person",
      estimated: true,
      geometry: straightLine([from.lng, from.lat], [to.lng, to.lat]),
      note: reason,
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
      geometry: straightLine([from.lng, from.lat], [to.lng, to.lat]),
      note: "公交耗时为估算，接入高德后可精确到线路与班次",
    };
  }
  return {
    mode,
    durationMin: estimateModeMinutes(from, to, "taxi") + 2,
    distanceKm,
    cost: estimateTaxiFare(distanceKm, rate),
    costUnit: "vehicle",
    estimated: true,
    geometry: straightLine([from.lng, from.lat], [to.lng, to.lat]),
    note: "路径与费用为估算",
  };
}

type OsrmResponse = {
  code?: string;
  routes?: {
    duration: number;
    distance: number;
    geometry?: { coordinates?: [number, number][] };
  }[];
};

async function osrmRoute(
  from: Place,
  to: Place,
  profile: "foot" | "car",
): Promise<{ durationMin: number; distanceKm: number; geometry: [number, number][] } | null> {
  const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
  const key = `osrm:${profile}:${from.lng.toFixed(5)},${from.lat.toFixed(5)}:${to.lng.toFixed(5)},${to.lat.toFixed(5)}`;
  return cached(key, 6 * 60 * 60 * 1000, async () => {
    try {
      const url = `https://routing.openstreetmap.de/routed-${profile}/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
      const data = await fetchJson<OsrmResponse>(url, {}, 12_000);
      const route = data.routes?.[0];
      if (!route || data.code === "NoRoute") return null;
      const geometry = route.geometry?.coordinates;
      return {
        durationMin: Math.max(1, Math.round(route.duration / 60)),
        distanceKm: Math.max(0.05, route.distance / 1000),
        geometry:
          geometry && geometry.length >= 2
            ? geometry
            : straightLine([from.lng, from.lat], [to.lng, to.lat]),
      };
    } catch {
      return null;
    }
  });
}

async function openRoute(
  from: Place,
  to: Place,
  mode: TransportMode,
  city: string,
): Promise<RawRoute> {
  if (from.lng === to.lng && from.lat === to.lat) {
    return {
      mode,
      durationMin: 1,
      distanceKm: 0,
      cost: 0,
      costUnit: "person",
      estimated: false,
      geometry: straightLine([from.lng, from.lat], [to.lng, to.lat]),
    };
  }

  const crossing =
    Boolean(from.island || to.island) && from.island !== to.island;
  if (crossing) {
    return {
      mode,
      durationMin: mode === "taxi" ? 46 : 50,
      distanceKm: Math.max(
        0.4,
        estimateRouteDistanceKm([from.lng, from.lat], [to.lng, to.lat]),
      ),
      cost: 40,
      costUnit: "person",
      estimated: true,
      geometry: straightLine([from.lng, from.lat], [to.lng, to.lat]),
      note: "需乘轮渡，已预留候船时间；船票参考 35–50 元/人",
    };
  }

  const direct = haversine([from.lng, from.lat], [to.lng, to.lat]);
  const rate = getTaxiRate(city);

  if (mode === "walk") {
    const route = await osrmRoute(from, to, "foot");
    if (route) {
      return {
        mode,
        durationMin: route.durationMin,
        distanceKm: route.distanceKm,
        cost: 0,
        costUnit: "person",
        estimated: false,
        geometry: route.geometry,
      };
    }
    return routeFallback(from, to, mode, city, "步行路径为估算");
  }

  if (mode === "taxi") {
    const route = await osrmRoute(from, to, "car");
    if (route) {
      return {
        mode,
        durationMin: route.durationMin + 2,
        distanceKm: route.distanceKm,
        cost: estimateTaxiFare(route.distanceKm, rate),
        costUnit: "vehicle",
        estimated: false,
        geometry: route.geometry,
        note: "费用按里程估算，不含拥堵加价",
      };
    }
    return routeFallback(from, to, mode, city, "驾车路径为估算");
  }

  const distanceKm = Math.max(0.3, direct * 1.32);
  return {
    mode,
    durationMin: estimateModeMinutes(from, to, "transit"),
    distanceKm,
    cost: estimateTransitFare(distanceKm),
    costUnit: "person",
    estimated: true,
    geometry: straightLine([from.lng, from.lat], [to.lng, to.lat]),
    note: "公交耗时为估算，接入高德后可精确到线路与班次",
  };
}

async function discoverOpen(options: DiscoverOptions): Promise<DiscoverResult> {
  if (isDemoCity(options.city)) {
    return {
      sights: XIAMEN_SIGHTS,
      meals: XIAMEN_MEALS,
      notes: [
        "厦门为内置演示城市，点位坐标为真实地点，门票与人均为参考值。",
        "配置高德 Key 后可替换为真实评分、营业信息与公交方案。",
      ],
      source: "demo",
      sourceNote: "开源演示数据 · 真实步行/驾车路线",
      isDemo: true,
    };
  }

  const center: [number, number] = options.center ?? [options.hotel.lng, options.hotel.lat];
  const radiusKm = Math.min(15, Math.max(6, options.radiusKm));
  const radius = Math.round(radiusKm * 1000);
  const lat = center[1];
  const lng = center[0];
  const scenicQuery = `[out:json][timeout:12];
(
  nwr(around:${radius},${lat},${lng})[tourism~"^(attraction|museum|viewpoint|gallery|zoo|aquarium)$"];
  nwr(around:${radius},${lat},${lng})[historic~"^(monument|memorial|castle|ruins|archaeological_site|fort)$"];
  nwr(around:${radius},${lat},${lng})[leisure~"^(park|garden)$"];
  nwr(around:${radius},${lat},${lng})[natural=beach];
);
out center tags 280;`;
  const foodRadius = Math.min(6000, radius);
  const foodQuery = `[out:json][timeout:12];
(
  nwr(around:${foodRadius},${lat},${lng})[amenity~"^(restaurant|cafe|food_court|marketplace)$"];
);
out center tags 160;`;

  const [scenicResult, foodResult] = await Promise.all([
    overpassQuery(scenicQuery),
    overpassQuery(foodQuery),
  ]);

  let sights = (scenicResult ?? []).filter(
    (place) =>
      !["food", "cafe", "hotel", "other"].includes(place.category),
  );
  let meals = (foodResult ?? []).filter((place) =>
    ["food", "cafe", "market"].includes(place.category),
  );
  meals = meals.filter((place) => !isChainRestaurant(place.name));
  const notes: string[] = [];

  if (sights.length < 6) {
    const wikidataPlaces = await wikidataSearch([lng, lat], radiusKm + 3);
    sights = dedupePlaces([...sights, ...wikidataPlaces]).filter(
      (place) =>
        !["food", "cafe", "hotel", "other"].includes(place.category),
    );
    const wikidataMeals = wikidataPlaces.filter((place) =>
      ["food", "cafe"].includes(place.category),
    );
    meals = dedupePlaces([...meals, ...wikidataMeals]);
    notes.push(
      "详细点位接口不可用时，已使用 Wikidata 知名地标补齐；餐饮以就近建议为主。",
    );
  }
  if (!meals.length) {
    notes.push("该城市暂未取到餐饮点位，已按路线位置预留用餐时间。");
  }
  if (!scenicResult && !sights.length) {
    notes.push("开源点位服务暂时不可用，可配置高德 Key 后重试。");
  }

  sights = dedupePlaces(sights).sort(
    (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  );
  meals = dedupePlaces(meals).sort(
    (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  );

  return {
    sights: sights.slice(0, 180),
    meals: meals.slice(0, 90),
    notes,
    source: "open",
    sourceNote: "OpenStreetMap / Wikidata · 真实步行/驾车路线",
  };
}

export const openProvider: PlaceProvider = {
  source: "open",
  sourceNote: "OpenStreetMap / Wikidata · 真实步行/驾车路线",
  async search(query: string, options: SearchOptions = {}) {
    if (options.kind === "city") {
      return photonCitySearch(query);
    }
    const results = await photonSearch(query, {
      limit: 12,
      center: options.center,
      maxDistanceKm: 60,
    });
    if (options.kind === "hotel") {
      const hotelish = results.filter(
        (place) =>
          place.category === "hotel" ||
          /酒店|宾馆|民宿|旅馆|客栈|公寓|饭店/.test(place.name),
      );
      const pool = hotelish.length ? hotelish : results;
      return pool.slice(0, 8).map((place) => ({ ...place, category: "hotel" as const }));
    }
    return results.slice(0, 10);
  },
  reverse(lat: number, lng: number) {
    return photonReverse(lat, lng);
  },
  discover: discoverOpen,
  route: openRoute,
};
