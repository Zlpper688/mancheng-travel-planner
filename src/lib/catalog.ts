import { CATEGORY_LABELS } from "./constants";
import {
  EXPERIENCE_LABELS,
  experienceOf,
  type ExperienceId,
} from "./plan/archetype";
import { hasDirectPhoto } from "./photo-hints";
import { dedupePlaces } from "./providers/normalize";
import { findPlaceProfile } from "./tips/lookup";
import type { Category, DataSourceKind, Place } from "./types";

export type PopularityTier = "icon" | "must" | "recommend" | "hidden";

export type CatalogThemeId = ExperienceId | "island";

export interface PopularityTierMeta {
  id: PopularityTier;
  label: string;
  min: number;
  hint: string;
}

export const POPULARITY_TIERS: PopularityTierMeta[] = [
  { id: "icon", label: "城市名片", min: 4.7, hint: "第一次来可以优先安排" },
  { id: "must", label: "热门必去", min: 4.3, hint: "口碑稳定，值得专程" },
  { id: "recommend", label: "口碑不错", min: 3.9, hint: "顺路加进行程" },
  { id: "hidden", label: "小众顺路", min: 0, hint: "人少，适合慢慢逛" },
];

export const TIER_BY_ID: Record<PopularityTier, PopularityTierMeta> =
  Object.fromEntries(POPULARITY_TIERS.map((tier) => [tier.id, tier])) as Record<
    PopularityTier,
    PopularityTierMeta
  >;

export const CATALOG_THEME_LABELS: Record<CatalogThemeId, string> = {
  ...EXPERIENCE_LABELS,
  island: "海岛",
};

export const CATALOG_THEME_ORDER: CatalogThemeId[] = [
  "landmark",
  "culture",
  "coast",
  "nature",
  "street",
  "food",
  "island",
  "mixed",
];

export const CATALOG_THEME_COLORS: Record<CatalogThemeId, string> = {
  landmark: "#435E8C",
  culture: "#A97725",
  coast: "#3E7E95",
  nature: "#2F6A52",
  street: "#C25A36",
  food: "#B65C3A",
  island: "#7B4E6E",
  mixed: "#6F766D",
};

const SIGHT_CATEGORIES: ReadonlySet<Category> = new Set<Category>([
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

const CATEGORY_HINTS: Record<Category, string> = {
  attraction: "第一次来可以优先安排",
  museum: "适合留一段室内时间",
  park: "适合散步和歇脚",
  viewpoint: "天气好时视野最佳",
  beach: "傍晚来吹海风更舒服",
  street: "适合边走边吃",
  temple: "记得着装得体",
  market: "早上去最有烟火气",
  nature: "留半天慢慢走",
  food: "顺路吃一顿",
  cafe: "走累了进来坐坐",
  hotel: "今晚的落脚点",
  other: "顺路看看",
};

const RAW_TAG_LABELS: Record<string, string> = {
  classic: "经典必看",
  photo: "出片",
  island: "海岛",
  garden: "园林",
  coast: "看海",
  culture: "人文",
  architecture: "老建筑",
  indoor: "室内",
  family: "亲子",
  citywalk: "适合漫步",
  food: "周边好吃",
  local: "本地味",
  slow: "慢逛",
  nature: "自然",
  history: "历史",
  cafe: "咖啡",
  seafood: "海鲜",
  cluster: "吃喝集中",
  souvenir: "伴手礼",
  breakfast: "早餐",
};

function firstSentence(text: string, limit = 52): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^[^。！？；;]+[。！？]?/);
  const sentence = (match?.[0] ?? cleaned).trim();
  return sentence.length > limit
    ? `${sentence.slice(0, limit - 1)}…`
    : sentence;
}

export function popularityOf(place: Place): number {
  const value =
    place.popularity ??
    (place.rating ? Math.min(5, 2.6 + place.rating * 0.48) : 3.4);
  return Math.min(5, Math.max(0, value));
}

export function tierOf(popularity: number): PopularityTier {
  for (const tier of POPULARITY_TIERS) {
    if (popularity >= tier.min) return tier.id;
  }
  return "hidden";
}

export function catalogThemeOf(place: Place): CatalogThemeId {
  if (place.island) return "island";
  const experience = experienceOf(place);
  return experience === "mixed" ? "landmark" : experience;
}

function derivedTags(place: Place): string[] {
  const profile = findPlaceProfile(place.city ?? "", place.name);
  const tags: string[] = [];
  const push = (tag: string) => {
    if (tag && !tags.includes(tag)) tags.push(tag);
  };

  if (profile?.booking && /预约|放票|摇号|实名/.test(profile.booking)) {
    push("需预约");
  }
  if (profile?.family) push("亲子友好");
  if (profile?.rain) push("雨天备选");
  if (profile?.photo) push("出片");
  if (profile?.bestTime && /日落|傍晚|16:00 后|17:00 后/.test(profile.bestTime)) {
    push("适合傍晚");
  }
  if (profile?.bestTime && /清晨|日出|7:30 前/.test(profile.bestTime)) {
    push("适合清晨");
  }
  if (profile?.duration && /半天|1 天/.test(profile.duration)) {
    push("值得半天");
  }
  if (profile?.food) push("附近有吃");
  if (profile?.caution && /台阶|坡|步行|走路|暴走/.test(profile.caution)) {
    push("步行较多");
  }
  if (
    place.cost === 0 &&
    !/含在|包含/.test(place.costNote ?? "") &&
    !/门票|票/.test(profile?.booking ?? "")
  ) {
    push("免费");
  }

  for (const raw of place.tags ?? []) {
    const label = RAW_TAG_LABELS[raw.toLowerCase()];
    if (label) push(label);
  }

  return tags.slice(0, 5);
}

function introOf(place: Place, theme: CatalogThemeId, tier: PopularityTier): string {
  if (place.note?.trim()) return firstSentence(place.note);
  const profile = findPlaceProfile(place.city ?? "", place.name);
  if (profile?.highlight?.trim()) return firstSentence(profile.highlight);
  const tierMeta = TIER_BY_ID[tier];
  const hint = CATEGORY_HINTS[place.category] ?? "顺路看看";
  return `${tierMeta.label}级${CATALOG_THEME_LABELS[theme]}点，${hint}。`;
}

export interface CatalogEntry {
  place: Place;
  popularity: number;
  tier: PopularityTier;
  theme: CatalogThemeId;
  tags: string[];
  intro: string;
  booking?: string;
  bestTime?: string;
  duration?: string;
  photo?: boolean;
}

export interface CatalogSniffInfo {
  stage: "base" | "deep";
  raw: number;
  kept: number;
  bySource: {
    amap: number;
    osm: number;
    wikidata: number;
    demo: number;
  };
  requests: number;
  truncated: boolean;
  elapsedMs: number;
  hasMore: boolean;
  boundary?: {
    name: string;
    bbox: [number, number, number, number];
    areaId?: number;
    adcode?: string;
  };
}

export interface CatalogResult {
  city: string;
  entries: CatalogEntry[];
  total: number;
  tierCounts: Record<PopularityTier, number>;
  themeCounts: Record<CatalogThemeId, number>;
  source: DataSourceKind;
  sourceNote: string;
  notes: string[];
  updatedAt: string;
  sniff?: CatalogSniffInfo;
}

export function buildCatalog(
  places: Place[],
  city: string,
  source: DataSourceKind,
  sourceNote: string,
  notes: string[] = [],
): CatalogResult {
  const sights = dedupePlaces(places).filter((place) =>
    SIGHT_CATEGORIES.has(place.category),
  );
  const cityName = city.replace(/市$/, "").trim();

  const entries: CatalogEntry[] = sights.map((place) => {
    const popularity = popularityOf(place);
    const tier = tierOf(popularity);
    const theme = catalogThemeOf(place);
    const profile = findPlaceProfile(cityName, place.name);
    return {
      place,
      popularity,
      tier,
      theme,
      tags: derivedTags({ ...place, city: place.city ?? cityName }),
      intro: introOf(
        { ...place, city: place.city ?? cityName },
        theme,
        tier,
      ),
      booking: profile?.booking,
      bestTime: profile?.bestTime,
      duration: profile?.duration,
      photo: hasDirectPhoto(place.name, cityName, {
        image: place.image,
        commons: place.commons,
      }),
    };
  });

  const tierRank = new Map(
    POPULARITY_TIERS.map((tier, index) => [tier.id, index]),
  );
  entries.sort(
    (a, b) =>
      (tierRank.get(a.tier) ?? 9) - (tierRank.get(b.tier) ?? 9) ||
      b.popularity - a.popularity ||
      a.place.name.localeCompare(b.place.name, "zh-Hans-CN"),
  );

  const tierCounts = Object.fromEntries(
    POPULARITY_TIERS.map((tier) => [
      tier.id,
      entries.filter((entry) => entry.tier === tier.id).length,
    ]),
  ) as Record<PopularityTier, number>;

  const themeCounts = Object.fromEntries(
    CATALOG_THEME_ORDER.map((theme) => [
      theme,
      entries.filter((entry) => entry.theme === theme).length,
    ]),
  ) as Record<CatalogThemeId, number>;

  return {
    city: cityName,
    entries,
    total: entries.length,
    tierCounts,
    themeCounts,
    source,
    sourceNote,
    notes,
    updatedAt: new Date().toISOString(),
  };
}