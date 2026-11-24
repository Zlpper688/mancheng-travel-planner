import { cached, fetchJson, mapLimit } from "../../cache";
import { wikidataReach } from "../../wikidata";
import { marqueePopularity } from "../fame";
import { photonCityBoundary } from "../photon";
import { classifyPlace, readOsmName } from "../normalize";
import type { Category, Place } from "../../types";
import {
  clampPopularity,
  mergePlaceLayers,
  SIGHT_CATEGORIES,
} from "./shared";
import type { SniffBoundary, SniffSourceResult, SniffStage } from "./types";

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
  remark?: string;
};

const OVERPASS_MAIN = "https://overpass-api.de/api/interpreter";
const OVERPASS_MIRROR =
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter";

const BASE_RADIUS_M = 9_000;
const BASE_LIMIT = 1_400;
const DEEP_LIMIT = 4_000;

const JUNK_NAME =
  /停车场|停车楼|公厕|公共厕所|售票处|售票厅|售票点|游客中心|游客服务中心|游客集散中心|服务中心|服务点$|管理处|管委会|出入口|入口$|出口$|检票|闸机|收费处|标识牌|标志牌|解说牌|指示牌|导览牌|导览图|全景图|景区大门|大门$|山门$|驿站$|值班室|警务室|医疗点|母婴室|寄存处|小区|社区|学校|幼儿园|大学城|培训|教育|公司|银行|营业厅|便利店|超市|加油站|充电站|医院|诊所|派出所|政府|委员会|公交站|地铁站$|轮渡站$|工程概况|工程简介|施工|项目部|古树名木|^火炮$|^大炮$|^古炮$|^雕塑$|^石碑$|^界碑$|^垃圾桶$|^座椅$|^路灯$|^监控$/;

function isJunkName(name: string): boolean {
  if (JUNK_NAME.test(name)) return true;
  // 水库本身多为水源地，不当作景点；带「公园/景区」的除外（如上李水库公园）。
  if (/水库|水庫|拦水坝|水闸|灌区|渠道/.test(name)) {
    return !/公园|景區|景区/.test(name);
  }
  return false;
}

const GENERIC_NAMES = new Set([
  "公园",
  "广场",
  "海滩",
  "沙滩",
  "观景台",
  "寺庙",
  "教堂",
  "码头",
  "老街",
  "步行街",
  "亭",
  "塔",
]);

const POPULARITY_BASE: Partial<Record<Category, number>> = {
  attraction: 3.86,
  museum: 3.82,
  beach: 3.84,
  viewpoint: 3.78,
  temple: 3.62,
  park: 3.55,
  street: 3.62,
  market: 3.55,
  nature: 3.62,
};

function tidyName(name: string): string {
  // “鼓浪屿风景名胜区-鼓浪洞照”这类前缀只是行政区/景区归属，保留后面的具体点位名。
  const match = name.match(
    /^(.+?(?:风景名胜区|景区|旅游区|游览区|公园))[-–—·:：](.+)$/,
  );
  const tail = match?.[2]?.trim();
  return tail && tail.length >= 2 ? tail : name;
}

function readName(tags: Record<string, string>): string | undefined {
  const raw = readOsmName(tags)?.trim() || tags.official_name?.trim();
  return raw ? tidyName(raw) : undefined;
}

function meaningful(tags: Record<string, string>, name: string): boolean {
  if (tags.wikidata || tags.wikipedia || tags.heritage) return true;
  if (
    tags.tourism &&
    !["hotel", "guest_house", "hostel", "information", "artwork"].includes(
      tags.tourism,
    )
  ) {
    return true;
  }
  if (
    tags.historic &&
    tags.historic !== "wayside_shrine" &&
    tags.historic !== "memorial_plaque"
  ) {
    return true;
  }
  if (
    tags.leisure &&
    ["park", "garden", "nature_reserve"].includes(tags.leisure)
  ) {
    return true;
  }
  if (
    tags.natural &&
    ["beach", "peak", "waterfall", "spring", "cave_entrance"].includes(
      tags.natural,
    )
  ) {
    return true;
  }
  if (
    tags.amenity &&
    ["marketplace", "arts_centre", "theatre"].includes(tags.amenity)
  ) {
    return true;
  }
  if (tags.man_made === "lighthouse") return true;
  if (tags.amenity === "place_of_worship") {
    return /寺|庙|宮|宫|觀|观|庵|教堂|清真寺|礼拜堂|祠堂/.test(name);
  }
  return false;
}

function popularityOf(
  name: string,
  category: Category,
  tags: Record<string, string>,
): number {
  let score = POPULARITY_BASE[category] ?? 3.4;
  if (tags.tourism === "attraction") score += 0.18;
  if (tags.wikidata) score += 0.28;
  if (tags.wikipedia) score += 0.16;
  if (tags.heritage) score += 0.22;
  if (tags["name:en"]) score += 0.04;
  if (
    /景区|风景名胜|古镇|古城|老街|步行街|文化街|博物馆|纪念馆|故居|遗址|寺|塔|楼|阁|沙滩|观景|湿地|植物园|动物园/.test(
      name,
    )
  ) {
    score += 0.18;
  }
  const marquee = marqueePopularity({
    name,
    category,
    taggedAttraction: tags.tourism === "attraction",
  });
  if (marquee !== null) score = Math.max(score, marquee);
  return clampPopularity(score);
}

function mapElement(
  element: OverpassElement,
  city: string,
): Place | null {
  const tags = element.tags ?? {};
  const name = readName(tags);
  if (!name || isJunkName(name) || GENERIC_NAMES.has(name)) return null;
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
  const tagText = Object.entries(tags)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const category = classifyPlace(name, tagText, "", tags);
  if (!SIGHT_CATEGORIES.has(category)) return null;
  if (!meaningful(tags, name)) return null;
  const address = [
    tags["addr:district"],
    tags["addr:street"],
    tags["addr:housenumber"],
    tags["addr:place"],
  ]
    .filter(Boolean)
    .join(" ");
  const note =
    tags["description:zh"] ||
    tags["description:zh-Hans"] ||
    tags["description:zh-cn"] ||
    tags.description ||
    tags["note:zh"] ||
    tags.note;
  const wikidata = tags.wikidata?.match(/^Q\d+$/)?.[0];
  const fee = osmFee(tags);
  const tagValues = [
    tags.tourism,
    tags.historic,
    tags.leisure,
    tags.natural,
    tags.amenity,
    tags.man_made,
    tags.religion,
    tags.heritage,
  ].filter((value): value is string => Boolean(value));

  return {
    id: `osm-${element.type}-${element.id}`,
    name,
    category,
    lat,
    lng,
    address: address || tags["addr:full"] || undefined,
    city: tags["addr:city"] || tags["addr:district"] || city,
    openHours: tags.opening_hours,
    cost: fee.cost,
    costNote: fee.costNote,
    popularity: popularityOf(name, category, tags),
    note: note?.slice(0, 160),
    source: "osm",
    tags: [...new Set(tagValues)].slice(0, 10),
    wikidataId: wikidata,
  };
}

// 只认免票和带人民币单位的票价，避免把 "10 EUR" 当成人均 10 元。
function osmFee(tags: Record<string, string>): {
  cost?: number;
  costNote?: string;
} {
  if (tags.fee === "no") return { cost: 0, costNote: "免费（OSM 标注）" };
  const raw = (tags.charge ?? tags["fee:amount"] ?? "").trim();
  if (!raw || !/^(?:[¥￥]\s*)?\d+(?:\.\d+)?\s*(?:元|CNY|RMB)?$/i.test(raw)) {
    return {};
  }
  const value = Number.parseFloat(raw.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(value) || value < 0 || value > 5_000) return {};
  return { cost: value, costNote: `${raw.slice(0, 40)}（OSM）` };
}

function scopeFor(
  stage: SniffStage,
  center: [number, number],
  boundary: SniffBoundary,
): { scope: string; prelude: string } {
  if (stage === "deep" && boundary.areaId) {
    return {
      scope: "(area.searchArea)",
      prelude: `area(${boundary.areaId})->.searchArea;`,
    };
  }
  if (stage === "deep") {
    return {
      scope: `(${boundary.bbox[1]},${boundary.bbox[0]},${boundary.bbox[3]},${boundary.bbox[2]})`,
      prelude: "",
    };
  }
  return {
    scope: `(around:${BASE_RADIUS_M},${center[1]},${center[0]})`,
    prelude: "",
  };
}

function buildQuery(
  stage: SniffStage,
  center: [number, number],
  boundary: SniffBoundary,
): string {
  const { scope, prelude } = scopeFor(stage, center, boundary);
  const clauses = [
    `nwr${scope}["tourism"~"^(attraction|museum|gallery|viewpoint|zoo|aquarium|theme_park)$"];`,
    stage === "deep"
      ? `nwr${scope}["historic"];`
      : `nwr${scope}["historic"~"^(monument|memorial|castle|ruins|archaeological_site|fort|citywalls|battlefield|tomb|palace|manor|yes|building)$"];`,
    `nwr${scope}["leisure"~"^(park|garden|nature_reserve)$"];`,
    `nwr${scope}["natural"~"^(beach|peak|waterfall|spring|cave_entrance)$"];`,
    `nwr${scope}["amenity"~"^(marketplace|arts_centre|theatre)$"];`,
    `nwr${scope}["man_made"="lighthouse"];`,
  ];
  if (stage === "deep") {
    clauses.push(`nwr${scope}["amenity"="place_of_worship"];`);
  }
  return `[out:json][timeout:${stage === "deep" ? 70 : 30}];\n${prelude}\n(\n  ${clauses.join("\n  ")}\n);\nout center tags ${stage === "deep" ? DEEP_LIMIT : BASE_LIMIT};`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestOverpass(
  query: string,
  timeoutMs: number,
  endpoint = OVERPASS_MAIN,
): Promise<OverpassResponse | null> {
  try {
    const data = await fetchJson<OverpassResponse>(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }).toString(),
      },
      timeoutMs,
    );
    if (data.remark && !(data.elements?.length ?? 0)) return null;
    return data;
  } catch {
    return null;
  }
}

async function fetchOverpass(
  city: string,
  stage: SniffStage,
  center: [number, number],
  boundary: SniffBoundary,
): Promise<{ data: OverpassResponse | null; requests: number }> {
  const query = buildQuery(stage, center, boundary);
  const cacheKey = `osm:sniff:${city}:${stage}`;
  let requests = 0;
  const data = await cached(
    cacheKey,
    stage === "deep" ? 30 * 60 * 1000 : 8 * 60 * 1000,
    async () => {
      requests += 1;
      let result = await requestOverpass(
        query,
        stage === "deep" ? 45_000 : 22_000,
      );
      if (!result) {
        requests += 1;
        result = await requestOverpass(
          query,
          stage === "deep" ? 65_000 : 35_000,
          OVERPASS_MIRROR,
        );
      }
      if (!result) {
        // 公共 Overpass 在高峰期会短时 502，等一轮再试，避免把失败写进缓存。
        await delay(stage === "deep" ? 1_500 : 1_000);
        requests += 1;
        result = await requestOverpass(
          query,
          stage === "deep" ? 35_000 : 18_000,
        );
      }
      return result;
    },
    { cacheIf: (value) => Boolean(value?.elements?.length) },
  );
  return { data, requests };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function enrichFromWikidata(
  places: Place[],
  city: string,
): Promise<{ requests: number; updated: number }> {
  const ids = [
    ...new Set(
      places
        .map((place) => place.wikidataId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (!ids.length) return { requests: 0, updated: 0 };

  let requests = 0;
  let updated = 0;
  const chunks = chunk(ids, 90);
  await mapLimit(chunks, 2, async (chunkIds) => {
    const cacheKey = `wikidata:sniff:${city}:${chunkIds.join(",")}`;
    const reach = await cached(
      cacheKey,
      24 * 60 * 60 * 1000,
      async () => {
        requests += 1;
        return wikidataReach(chunkIds);
      },
      { cacheIf: (value) => value.size > 0 },
    );
    for (const place of places) {
      if (!place.wikidataId) continue;
      const info = reach.get(place.wikidataId);
      if (!info) continue;
      if (info.sitelinks > 0) {
        const boost = Math.min(0.9, Math.log10(1 + info.sitelinks) * 0.42);
        place.popularity = clampPopularity((place.popularity ?? 3.4) + boost);
        updated += 1;
      }
      if (!place.note && info.description) {
        place.note = info.description.slice(0, 160);
      }
    }
  });
  return { requests, updated };
}

export async function sniffOsm(
  city: string,
  center: [number, number],
  stage: SniffStage,
  knownBoundary?: SniffBoundary,
): Promise<SniffSourceResult> {
  const notes: string[] = [];
  const photonBoundary = knownBoundary ?? (await photonCityBoundary(city, center));
  const fallbackSpan = stage === "deep" ? 0.45 : 0.3;
  const boundary: SniffBoundary = photonBoundary
    ? {
        name: photonBoundary.name,
        bbox: photonBoundary.bbox,
        areaId: photonBoundary.areaId,
        adcode: "adcode" in photonBoundary ? photonBoundary.adcode : undefined,
        rings: "rings" in photonBoundary ? photonBoundary.rings : undefined,
      }
    : {
        name: city,
        bbox: [
          center[0] - fallbackSpan,
          center[1] - fallbackSpan,
          center[0] + fallbackSpan,
          center[1] + fallbackSpan,
        ],
      };

  const overpass = await fetchOverpass(city, stage, center, boundary);
  const { data } = overpass;
  let requests = overpass.requests;
  const mapped: Place[] = data?.elements?.length
    ? mergePlaceLayers([
        data.elements
          .map((element) => mapElement(element, city))
          .filter((place): place is Place => Boolean(place)),
      ])
    : [];

  const raw = data?.elements?.length ?? 0;
  const truncated = raw >= (stage === "deep" ? DEEP_LIMIT : BASE_LIMIT);
  if (!mapped.length) {
    notes.push(
      "OpenStreetMap 全城扫描暂时不可用，已先保留快速扫描/精选结果。",
    );
  } else {
    notes.push(
      `OpenStreetMap ${stage === "deep" ? "全城" : "近场"}扫描：${raw} 个地图要素，保留 ${mapped.length} 个景点。`,
    );
    if (truncated) {
      notes.push("开放地图返回量达到本次扫描上限，仍有更多点位未纳入。");
    }
  }

  if (stage === "deep" && mapped.length) {
    const enrichment = await enrichFromWikidata(mapped, city);
    requests += enrichment.requests;
    if (enrichment.updated) {
      notes.push(
        `已用 Wikidata 为 ${enrichment.updated} 个地标补全知名度与简介。`,
      );
    }
  }

  return {
    source: "osm",
    places: mapped,
    notes,
    requests,
    truncated,
    raw,
    boundary,
  };
}