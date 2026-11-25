import { cached, fetchJson } from "../cache";
import { getTaxiRate } from "../constants";
import { DEMO_NOTE, XIAMEN_MEALS, XIAMEN_SIGHTS } from "../../content/demo-xiamen";
import { isDemoCity } from "../demo";
import {
  estimateModeMinutes,
  estimateRouteDistanceKm,
  estimateTaxiFare,
  estimateTransitFare,
  haversine,
  straightLine,
} from "../geo";
import type { Category, Place, TransportMode } from "../types";
import { marqueePopularity } from "./fame";
import {
  classifyPlace,
  collapseScenicChildren,
  dedupePlaces,
  isChainRestaurant,
  readOsmName,
} from "./normalize";
import {
  PHOTON_HOTEL_INCLUDES,
  PHOTON_SIGHT_INCLUDES,
  photonCategorySearch,
  photonCitySearch,
  photonReverse,
  photonSearch,
} from "./photon";
import { datavCityBoundary } from "./sniff/boundary";
import { withinBoundary } from "./sniff/shared";
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
  const name = readOsmName(tags);
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
  const marquee = marqueePopularity({
    name,
    category,
    taggedAttraction: tags.tourism === "attraction",
  });
  // OSM 的 tourism=attraction 门槛极低，一座雕塑、一个环岛都可能被打上；
  // 没有维基、简介或地标命名佐证的孤立点位只配当兜底，不能和名山古寺同档。
  const substantiated =
    Boolean(tags.wikidata || tags.wikipedia || tags.description) ||
    marquee !== null;
  if (tags.tourism === "attraction" && !substantiated) {
    popularity = Math.min(popularity, 3.25);
  }
  if (marquee !== null) popularity = Math.max(popularity, marquee);
  const notes = tags.description?.slice(0, 80);
  const qid = tags.wikidata?.match(/^Q\d+$/)?.[0];
  return {
    id: `osm-${element.type}-${element.id}`,
    name,
    category,
    lat,
    lng,
    address: overpassAddress(tags),
    city: tags["addr:city"],
    openHours: tags.opening_hours,
    cost: tags.fee === "no" ? 0 : undefined,
    popularity: Math.min(5, popularity),
    note: notes,
    source: "osm",
    tags: Object.values(tags).slice(0, 8),
    wikidataId: qid,
    image: tags.image?.slice(0, 300),
    commons: tags.wikimedia_commons?.slice(0, 300),
    wikipedia: tags.wikipedia?.slice(0, 200),
    website: (tags.website ?? tags["contact:website"])?.slice(0, 300),
  };
}

const OVERPASS_MIRROR =
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter";

async function overpassQuery(
  query: string,
  options: { allowMirror?: boolean; timeoutMs?: number } = {},
): Promise<Place[] | null> {
  const { allowMirror = false, timeoutMs = 6_000 } = options;
  const body = new URLSearchParams({ data: query }).toString();
  const targets = [
    { url: "https://overpass-api.de/api/interpreter", timeout: timeoutMs },
    ...(allowMirror ? [{ url: OVERPASS_MIRROR, timeout: 28_000 }] : []),
  ];
  let mirrorRetried = false;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const startedAt = Date.now();
    try {
      const data = await fetchJson<OverpassResponse>(
        target.url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        },
        target.timeout,
      );
      return (data.elements ?? [])
        .map(mapOverpassElement)
        .filter((place): place is Place => Boolean(place));
    } catch {
      // 公共镜像按客户端限流，偶尔瞬时 504：快速失败时补一次重试，
      // 已经跑了很久的超时则不再拖时间。
      if (
        target.url === OVERPASS_MIRROR &&
        !mirrorRetried &&
        Date.now() - startedAt < 8_000
      ) {
        mirrorRetried = true;
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        targets.push({ url: OVERPASS_MIRROR, timeout: 28_000 });
      }
    }
  }
  return null;
}

function bboxForRadius(
  center: [number, number],
  radiusKm: number,
): { south: number; west: number; north: number; east: number } {
  const latDelta = radiusKm / 111.32;
  const lngDelta =
    radiusKm /
    (111.32 * Math.max(0.2, Math.cos((center[1] * Math.PI) / 180)));
  return {
    south: center[1] - latDelta,
    west: center[0] - lngDelta,
    north: center[1] + latDelta,
    east: center[0] + lngDelta,
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const NON_VISIT =
  /都城|古都|故都|王朝|朝代|政权|古国|聚居地|聚落|村落|线路|路网|廊道|世界遗产|墓葬群|陵邑|陵区|陵墓群|遗址群|墓地|墓群|丝绸之路/;

async function wikidataSupplement(
  center: [number, number],
  radiusKm: number,
): Promise<Place[]> {
  const [wikidataPlaces, heritagePlaces] = await Promise.all([
    wikidataSearch(center, radiusKm + 3, 90, NON_VISIT),
    wikidataHeritageSearch(center, radiusKm + 3, 400, NON_VISIT),
  ]);
  return [...wikidataPlaces, ...heritagePlaces];
}

const GATE = /(?:东|西|南|北|正|大)门$/;
const SCENIC_PARENT_NAME =
  /风景名胜区|风景区|景区|森林公园|自然保护区|旅游度假区/;

/**
 * OSM 没有评分，但一个景区在 3 km 内标出多个大门，通常说明它开发成熟；
 * 给这类景区本体加一点名气权重，避免小峡谷和 5A 级山岳被同等对待。
 */
function boostByGateCount(places: Place[]): Place[] {
  const gates = places.filter((place) => GATE.test(place.name));
  if (!gates.length) return places;
  for (const parent of places) {
    if (!SCENIC_PARENT_NAME.test(parent.name)) continue;
    const count = gates.filter(
      (gate) =>
        parent.id !== gate.id &&
        parent.name.startsWith(gate.name.replace(GATE, "")) &&
        haversine([parent.lng, parent.lat], [gate.lng, gate.lat]) <= 3,
    ).length;
    if (count >= 2) {
      parent.popularity = Math.min(
        5,
        Math.round(
          ((parent.popularity ?? 3.4) + Math.min(0.5, count * 0.15)) * 100,
        ) / 100,
      );
    }
  }
  return places;
}

type SparqlBinding = {
  item?: { value: string };
  itemLabel?: { value: string };
  coord?: { value: string };
  typeLabel?: { value: string };
  sitelinks?: { value: string };
  desc?: { value: string };
};

type SparqlResponse = {
  results?: { bindings?: SparqlBinding[] };
};

const WIKIDATA_TYPES = [
  "Q570116", // 旅游景点
  "Q33506", // 博物馆
  "Q207694", // 美术馆
  "Q22698", // 公园
  "Q167346", // 植物园
  "Q40080", // 海滩
  "Q839954", // 历史遗址
  "Q44539", // 寺庙
  "Q16970", // 教堂
  "Q24354", // 剧院
  "Q576603", // 主题公园
  "Q194570", // 水族馆
  "Q43501", // 动物园
  "Q12280", // 桥
  "Q1329623", // 市场
  "Q11707", // 餐厅
  "Q30022", // 咖啡馆
  "Q23413", // 城堡
  "Q4989906", // 纪念碑
  "Q5003624", // 纪念建筑
  "Q42195", // 塔
  "Q1107656", // 园林
  "Q174782", // 广场
].map((id) => `wd:${id}`);

const WIKIDATA_TYPE_CATEGORY: Array<[RegExp, Category]> = [
  [/博物馆|美術館|美术馆|纪念馆|展览馆/, "museum"],
  [/植物园|公园|园林|花园/, "park"],
  [/海滩|海灘|沙滩|沙灘|滩/, "beach"],
  [/教堂|寺庙|寺廟|寺院|道观|清真寺/, "temple"],
  [/剧院|劇院|文化中心|艺术中心/, "attraction"],
  [/桥|橋|塔|纪念碑|紀念碑|广场|廣場|旅游景点|旅遊景點|主题公园|主題公園|水族馆|水族館|动物园|動物園|遗址|遺址/, "attraction"],
];

/** 文保称谓不含功能信息，按名称判断建筑用途，避免「山庄」「花园」被当成山野或公园。 */
function heritageCategory(name: string): Category {
  if (/博物馆|博物院|美术馆|纪念馆|展览馆|陈列馆/.test(name)) return "museum";
  if (/教堂|礼拜堂|寺|庙|庵|道观|清真寺/.test(name)) return "temple";
  if (/植物园|公园|动物园|水族馆/.test(name)) return "park";
  if (/海滩|沙滩/.test(name)) return "beach";
  return "attraction";
}

function categoryFromWikidataType(typeLabel: string): Category | null {
  for (const [pattern, category] of WIKIDATA_TYPE_CATEGORY) {
    if (pattern.test(typeLabel)) return category;
  }
  return null;
}

function parseWktPoint(value: string): [number, number] | null {
  const match = value.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
  if (!match) return null;
  const lng = Number(match[1]);
  const lat = Number(match[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

type WikidataMapOptions = {
  defaultCategory?: Category;
  heritage?: boolean;
  popularityBase: number;
  popularityScale: number;
  exclude?: RegExp;
};

function mapWikidataBindings(
  bindings: SparqlBinding[] | undefined,
  options: WikidataMapOptions,
): Place[] {
  type ItemRow = {
    qid: string;
    name: string;
    point: [number, number];
    types: Set<string>;
    descs: Set<string>;
    sitelinks: number;
  };
  const rows = new Map<string, ItemRow>();
  for (const binding of bindings ?? []) {
    const name = binding.itemLabel?.value;
    const coord = binding.coord?.value;
    const qid = binding.item?.value.split("/").pop();
    if (!name || !coord || !qid) continue;
    const point = parseWktPoint(coord);
    if (!point) continue;
    const row =
      rows.get(qid) ??
      {
        qid,
        name,
        point,
        types: new Set<string>(),
        descs: new Set<string>(),
        sitelinks: 0,
      };
    const typeLabel = binding.typeLabel?.value;
    if (typeLabel) row.types.add(typeLabel);
    const desc = binding.desc?.value;
    if (desc) row.descs.add(desc);
    row.sitelinks = Math.max(
      row.sitelinks,
      Number(binding.sitelinks?.value ?? 0),
    );
    rows.set(qid, row);
  }

  const places: Place[] = [];
  for (const row of rows.values()) {
    const { name, point, qid, sitelinks } = row;
    const typeLabels = [...row.types];
    const desc = [...row.descs][0] ?? "";
    const text = `${name} ${desc} ${typeLabels.join(" ")}`;
    // 同一个 QID 会按语言返回多行描述，排除规则必须看合并后的整体，
    // 否则换个语言版本（如「万国之城」）就绕过了「古都」过滤。
    if (options.exclude?.test(text)) continue;
    if (/消歧义|维基媒体|藏品|词典|百科/.test(text)) continue;
    // 没有中文名的条目（QID 或纯英文）对中文用户不可读，宁可不收。
    if (!/[\u4e00-\u9fa5]/.test(name)) continue;
    let category: Category | null = null;
    for (const label of typeLabels) {
      category = categoryFromWikidataType(label);
      if (category) break;
    }
    if (!category) {
      category = options.heritage
        ? heritageCategory(name)
        : classifyPlace(name, typeLabels[0] ?? "");
    }
    if (category === "hotel" || category === "other") {
      if (!options.defaultCategory) continue;
      category = options.defaultCategory;
    }
    // 低知名度条目里的行政楼、学校、住宅，游客通常不会去。
    if (sitelinks < 2) {
      if (
        /(办公楼|政府|委员会|大学|学院|中学|小学|学校|医院|银行|公司|工厂|宿舍|小区|住宅|大厦)(?!旧址|故居|纪念馆)/.test(
          name,
        )
      ) {
        continue;
      }
    }
    // 只有秦始皇陵这种量级的陵墓才值得专程去；冷门王墓、烈士墓不进候选。
    if (/(墓|冢|陵)$/.test(name) && sitelinks < 10) continue;
    places.push({
      id: `wikidata-${qid ?? name}`,
      name,
      category,
      lat: point[1],
      lng: point[0],
      source: "wikidata",
      popularity: Math.min(
        5,
        options.popularityBase +
          Math.log10(1 + Math.max(0, sitelinks)) * options.popularityScale,
      ),
      note: desc.slice(0, 120) || undefined,
      tags: typeLabels ? typeLabels : [],
      wikidataId: /^Q\d+$/.test(qid) ? qid : undefined,
    });
  }
  return dedupePlaces(places);
}

async function runWikidataQuery(sparql: string): Promise<SparqlBinding[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
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
        12_000,
      );
      return data.results?.bindings ?? [];
    } catch {
      // 高峰期 SPARQL 会瞬时 429/502；一次重试能避免整座城市被判成空数据。
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
  return [];
}

function aroundClause(center: [number, number], radiusKm: number): string {
  return `SERVICE wikibase:around {
    ?item wdt:P625 ?coord.
    bd:serviceParam wikibase:center "Point(${center[0]} ${center[1]})"^^geo:wktLiteral.
    bd:serviceParam wikibase:radius "${Math.min(radiusKm, 80)}".
  }`;
}

export async function wikidataSearch(
  center: [number, number],
  radiusKm: number,
  limit = 90,
  exclude?: RegExp,
): Promise<Place[]> {
  const sparql = `SELECT ?item ?itemLabel ?coord ?typeLabel ?sitelinks ?desc WHERE {
  ${aroundClause(center, radiusKm)}
  ?item wdt:P31 ?type.
  VALUES ?type { ${WIKIDATA_TYPES.join(" ")} }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks. }
  OPTIONAL { ?item schema:description ?desc. FILTER(STRSTARTS(LANG(?desc), "zh")) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
} ORDER BY DESC(?sitelinks) LIMIT ${Math.max(1, Math.min(500, Math.round(limit)))}`;
  return mapWikidataBindings(await runWikidataQuery(sparql), {
    popularityBase: 3.4,
    popularityScale: 0.75,
    exclude,
  });
}

/** 文保单位/历史建筑：类型查询覆盖不到，但通常是城市里值得走到的点位。 */
export async function wikidataHeritageSearch(
  center: [number, number],
  radiusKm: number,
  limit = 400,
  exclude?: RegExp,
): Promise<Place[]> {
  const sparql = `SELECT ?item ?itemLabel ?coord ?typeLabel ?sitelinks ?desc WHERE {
  ${aroundClause(center, radiusKm)}
  ?item wdt:P1435 ?heritage.
  OPTIONAL { ?item wdt:P31 ?type. }
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks. }
  OPTIONAL { ?item schema:description ?desc. FILTER(STRSTARTS(LANG(?desc), "zh")) }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "zh-hans,zh,en". }
} ORDER BY DESC(?sitelinks) LIMIT ${Math.max(1, Math.min(600, Math.round(limit)))}`;
  return mapWikidataBindings(await runWikidataQuery(sparql), {
    defaultCategory: "attraction",
    heritage: true,
    popularityBase: 3.65,
    popularityScale: 0.6,
    exclude,
  });
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
    const landMin = estimateModeMinutes(from, to, "taxi");
    return {
      mode,
      durationMin: Math.max(mode === "taxi" ? 46 : 50, landMin + 25),
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
  const radiusKm = Math.min(50, Math.max(6, options.radiusKm));
  const box = bboxForRadius(center, radiusKm);
  const bboxText = `${box.south.toFixed(4)},${box.west.toFixed(4)},${box.north.toFixed(4)},${box.east.toFixed(4)}`;
  // 公共镜像对 around: 大圆查询会直接超时；bbox 只扫一次矩形，
  // 同样的 50 km 覆盖能稳定返回名山古寺与博物馆。
  const scenicQuery = `[out:json][timeout:30];
(
  nwr(${bboxText})[tourism~"^(attraction|museum|viewpoint|gallery)$"];
  nwr(${bboxText})[leisure=nature_reserve];
  nwr(${bboxText})[highway=pedestrian][name];
  nwr(${bboxText})[place=square][name];
  nwr(${bboxText})[shop=mall][name];
  nwr(${bboxText})[historic~"^(monument|memorial|city_gate|archaeological_site)$"][name];
);
out center tags 240;`;
  const foodBox = bboxForRadius(center, Math.min(8, radiusKm));
  const foodQuery = `[out:json][timeout:20];
nwr(${foodBox.south},${foodBox.west},${foodBox.north},${foodBox.east})[amenity~"^(restaurant|cafe|food_court|marketplace)$"];
out center tags 120;`;
  const scenicKey = `overpass:scenic:v4:${options.city}:${box.south.toFixed(2)},${box.west.toFixed(2)},${box.north.toFixed(2)},${box.east.toFixed(2)}`;

  const [scenicResult, foodResult, boundary] = await Promise.all([
    cached(
      scenicKey,
      30 * 60 * 1000,
      () => overpassQuery(scenicQuery, { allowMirror: true }),
      { cacheIf: (value) => Boolean(value?.length) },
    ),
    // 餐饮只是可选补充，主站不可达时不值得等太久。
    overpassQuery(foodQuery, { timeoutMs: 5_000 }),
    Promise.race([
      datavCityBoundary(options.city, center).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 6_000)),
    ]),
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

  // Photon 与 Wikidata 只在开源地图没兜住时补位，健康路径上不多打外部请求。
  if (sights.length < 12) {
    const photonReach = Math.min(55, Math.max(radiusKm, 40));
    const [photonSights, wikidataPlaces] = await Promise.all([
      withTimeout(
        photonCategorySearch({
          center,
          radiusKm: photonReach,
          categories: PHOTON_SIGHT_INCLUDES,
          limit: 120,
        }).catch(() => []),
        18_000,
        [],
      ),
      sights.length < 6
        ? withTimeout(wikidataSupplement(center, radiusKm), 15_000, [])
        : Promise.resolve([] as Place[]),
    ]);
    if (photonSights.length) {
      sights = dedupePlaces([...sights, ...photonSights]).filter(
        (place) => !["food", "cafe", "hotel", "other"].includes(place.category),
      );
      notes.push(
        `已用 Photon 开放地图按类别补全 ${photonSights.length} 个点位（约 ${Math.round(photonReach)} km 内）。`,
      );
    }
    if (wikidataPlaces.length) {
      sights = dedupePlaces([...sights, ...wikidataPlaces]).filter(
        (place) =>
          !["food", "cafe", "hotel", "other"].includes(place.category),
      );
      const wikidataMeals = wikidataPlaces.filter((place) =>
        ["food", "cafe"].includes(place.category),
      );
      meals = dedupePlaces([...meals, ...wikidataMeals]);
      notes.push(
        "开源点位不足时，已用 Wikidata 知名地标与文保名录补齐；餐饮以就近建议为主。",
      );
    }
  }

  if (!meals.length) {
    notes.push("该城市暂未取到餐饮点位，已按路线位置预留用餐时间。");
  }
  if (!scenicResult && !sights.length) {
    notes.push("开源点位服务暂时不可用，可配置高德 Key 后重试。");
  }

  const clipCity = (places: Place[]) =>
    places.filter((place) =>
      withinBoundary(place, options.city, boundary ?? undefined, center),
    );
  sights = collapseScenicChildren(boostByGateCount(dedupePlaces(sights)));
  meals = dedupePlaces(meals);
  const candidates = sights.length + meals.length;
  sights = clipCity(sights).sort(
    (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  );
  meals = clipCity(meals).sort(
    (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
  );
  const dropped = candidates - sights.length - meals.length;
  if (boundary && dropped > 0) {
    notes.push(
      `已按 ${boundary.name} 行政区边界裁剪，排除 ${dropped} 个相邻城市点位。`,
    );
  }
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
      if (hotelish.length) {
        return hotelish
          .slice(0, 8)
          .map((place) => ({ ...place, category: "hotel" as const }));
      }
      // 关键词搜不到时，用分类枚举补；但不要把火车站/城市结果硬标成酒店。
      const generic =
        /酒店|宾馆|住宿|民宿|旅馆|hotel/i.test(query) ||
        (options.city &&
          (query === options.city || options.city.includes(query)));
      if (options.center && generic) {
        const hotels = await photonCategorySearch({
          center: options.center,
          radiusKm: 40,
          categories: PHOTON_HOTEL_INCLUDES,
          limit: 60,
        }).catch(() => []);
        const pool = hotels.filter((place) => place.category === "hotel");
        if (pool.length) return pool.slice(0, 8);
      }
      return [];
    }
    return results.slice(0, 10);
  },
  reverse(lat: number, lng: number) {
    return photonReverse(lat, lng);
  },
  discover: discoverOpen,
  route: openRoute,
};
