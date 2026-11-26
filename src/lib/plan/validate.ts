import { BUDGET_TIERS, PACES, STYLES } from "../constants";
import { TravelError } from "../errors";
import { todayISOLocal } from "../geo";
import type {
  BudgetTier,
  Category,
  ExperienceId,
  FixedPlace,
  PaceId,
  Place,
  StyleId,
  TransportPref,
  TripInput,
} from "../types";
import { EXPERIENCE_DEFS } from "./experience";
import { sanitizeParams } from "./params";

const CATEGORIES: Category[] = [
  "attraction",
  "museum",
  "park",
  "viewpoint",
  "beach",
  "street",
  "temple",
  "market",
  "nature",
  "food",
  "cafe",
  "hotel",
  "other",
];

const SOURCES = ["amap", "osm", "wikidata", "demo"] as const;
const STYLE_IDS = new Set(STYLES.map((style) => style.id));
const PACES_IDS = new Set(Object.keys(PACES));
const BUDGET_IDS = new Set(Object.keys(BUDGET_TIERS));
const TRANSPORT_IDS = new Set(["auto", "walk", "transit", "drive"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TravelError("请求格式不正确", "INVALID_INPUT", "请刷新页面后重试");
  }
  return value as Record<string, unknown>;
}

function readString(
  value: unknown,
  field: string,
  options: { max?: number; required?: boolean } = {},
): string {
  if (typeof value !== "string" || !value.trim()) {
    if (options.required) {
      throw new TravelError(`缺少${field}`, "INVALID_INPUT", "请补全信息后再生成行程");
    }
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length > (options.max ?? 120)) {
    return trimmed.slice(0, options.max ?? 120);
  }
  return trimmed;
}

function readNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback?: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    if (fallback !== undefined) return fallback;
    throw new TravelError(`${field}格式不正确`, "INVALID_INPUT");
  }
  return Math.min(max, Math.max(min, parsed));
}

function tryPlace(raw: unknown, forceHotel = false): Place | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name.trim().slice(0, 80) : "";
  const lat = Number(data.lat);
  const lng = Number(data.lng);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const categoryValue = typeof data.category === "string" ? data.category : "";
  const category = forceHotel
    ? "hotel"
    : (CATEGORIES.includes(categoryValue as Category) ? categoryValue : "attraction") as Category;
  const sourceValue = typeof data.source === "string" ? data.source : "demo";
  const source = (SOURCES as readonly string[]).includes(sourceValue)
    ? (sourceValue as Place["source"])
    : "demo";
  const cost = Number(data.cost);
  const rating = Number(data.rating);
  const popularity = Number(data.popularity);
  const tags = Array.isArray(data.tags)
    ? data.tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.slice(0, 24))
        .slice(0, 8)
    : undefined;
  return {
    id: typeof data.id === "string" && data.id.trim()
      ? data.id.trim().slice(0, 80)
      : `place-${name}-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    name,
    category,
    lat,
    lng,
    address:
      typeof data.address === "string" && data.address.trim()
        ? data.address.trim().slice(0, 160)
        : undefined,
    city:
      typeof data.city === "string" && data.city.trim()
        ? data.city.trim().slice(0, 30)
        : undefined,
    rating: Number.isFinite(rating) && rating > 0 && rating <= 5 ? rating : undefined,
    cost: Number.isFinite(cost) && cost >= 0 && cost <= 100000 ? cost : undefined,
    costNote:
      typeof data.costNote === "string" && data.costNote.trim()
        ? data.costNote.trim().slice(0, 80)
        : undefined,
    openHours:
      typeof data.openHours === "string" && data.openHours.trim()
        ? data.openHours.trim().slice(0, 80)
        : undefined,
    popularity:
      Number.isFinite(popularity) && popularity >= 0 && popularity <= 5
        ? popularity
        : undefined,
    note:
      typeof data.note === "string" && data.note.trim()
        ? data.note.trim().slice(0, 240)
        : undefined,
    source,
    tags,
    island:
      typeof data.island === "string" && data.island.trim()
        ? data.island.trim().slice(0, 20)
        : undefined,
  };
}

/**
 * 解析「指定某天的某个点」。攻略复刻（fixedPlaces）与单点锁定（lockedPlaces）
 * 用的是同一种结构，差别只在 select.ts 里的处理方式。
 */
function readFixedPlaces(raw: unknown, max: number): FixedPlace[] {
  if (!Array.isArray(raw)) return [];
  const result: FixedPlace[] = [];
  for (const item of raw.slice(0, max)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const place = tryPlace(record.place);
    const day = Number(record.day);
    if (
      place &&
      place.category !== "hotel" &&
      Number.isInteger(day) &&
      day >= 1 &&
      day <= 15
    ) {
      result.push({ place, day });
    }
  }
  return result;
}

export function sanitizeTripInput(raw: unknown): TripInput {
  const data = asRecord(raw);
  const city = readString(data.city, "目的地", { max: 40, required: true });
  const rawHotel = tryPlace(data.hotel, true);
  const hotelUndecided = data.hotelUndecided === true;
  const hotel = hotelUndecided ? null : rawHotel;

  let center: [number, number] | undefined;
  if (Array.isArray(data.center) && data.center.length === 2) {
    const lng = Number(data.center[0]);
    const lat = Number(data.center[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) center = [lng, lat];
  }
  if (!center && rawHotel) center = [rawHotel.lng, rawHotel.lat];
  if (!center) {
    throw new TravelError(
      "还不知道落脚方向",
      "INVALID_INPUT",
      "选择一个城市即可；住处可以之后再定，漫城会按景点分布推荐落脚片区。",
    );
  }

  const days = Math.round(readNumber(data.days, "游玩天数", 1, 15, 3));
  const rawDate = typeof data.date === "string" ? data.date : "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : todayISOLocal();
  const rawPace = typeof data.pace === "string" ? data.pace : "balanced";
  const pace = (PACES_IDS.has(rawPace) ? rawPace : "balanced") as PaceId;
  const rawStyles = Array.isArray(data.styles) ? data.styles : [];
  const styles = Array.from(
    new Set(
      rawStyles.filter(
        (style): style is StyleId =>
          typeof style === "string" && STYLE_IDS.has(style as StyleId),
      ),
    ),
  ).slice(0, 3);
  if (!styles.length) styles.push("classic");
  const rawExperiences = Array.isArray(data.experiences) ? data.experiences : [];
  const experiences = Array.from(
    new Set(
      rawExperiences.filter(
        (id): id is ExperienceId =>
          typeof id === "string" && id in EXPERIENCE_DEFS,
      ),
    ),
  ).slice(0, 6);
  const rawTransport = typeof data.transport === "string" ? data.transport : "auto";
  const transport = (TRANSPORT_IDS.has(rawTransport) ? rawTransport : "auto") as TransportPref;
  const rawBudget = typeof data.budgetTier === "string" ? data.budgetTier : "comfort";
  const budgetTier = (BUDGET_IDS.has(rawBudget) ? rawBudget : "comfort") as BudgetTier;
  const adults = Math.round(readNumber(data.adults, "成人数", 0, 10, 2));
  const children = Math.round(readNumber(data.children, "儿童数", 0, 10, 0));
  const seniors = Math.round(readNumber(data.seniors, "老人数", 0, 10, 0));
  if (adults + children + seniors < 1) {
    throw new TravelError(
      "同行人数至少 1 位",
      "INVALID_PARTY",
      "请把成人、儿童或老人数量补上再生成行程",
    );
  }
  const notes =
    typeof data.notes === "string" && data.notes.trim()
      ? data.notes.trim().slice(0, 240)
      : undefined;
  const seed = Math.floor(Math.abs(readNumber(data.seed, "随机种子", 0, 2147483646, 42)));
  const hotelPriceRaw = Number(data.hotelPrice);
  const hotelPrice =
    Number.isFinite(hotelPriceRaw) && hotelPriceRaw > 0 && hotelPriceRaw <= 50000
      ? hotelPriceRaw
      : undefined;
  let farDays: number | undefined;
  if (data.farDays !== undefined && data.farDays !== null) {
    const parsedFar = Number(data.farDays);
    if (Number.isFinite(parsedFar)) {
      farDays = Math.min(3, Math.max(0, Math.round(parsedFar)));
    }
  }

  const fixedPlaces = readFixedPlaces(data.fixedPlaces, 80);
  const lockedPlaces = readFixedPlaces(data.lockedPlaces, 30);

  const excludeIds: string[] = [];
  if (Array.isArray(data.excludeIds)) {
    for (const item of data.excludeIds.slice(0, 120)) {
      if (typeof item !== "string") continue;
      const id = item.trim().slice(0, 80);
      if (id && !excludeIds.includes(id)) excludeIds.push(id);
    }
  }

  let slimDays: Record<number, number> | undefined;
  if (data.slimDays && typeof data.slimDays === "object" && !Array.isArray(data.slimDays)) {
    const cleaned: Record<number, number> = {};
    for (const [key, value] of Object.entries(data.slimDays as Record<string, unknown>)) {
      const day = Number(key);
      const count = Number(value);
      if (!Number.isInteger(day) || day < 1 || day > 15) continue;
      if (!Number.isFinite(count) || count <= 0) continue;
      cleaned[day] = Math.min(4, Math.round(count));
    }
    if (Object.keys(cleaned).length) slimDays = cleaned;
  }

  const selectedPlaces: Place[] = [];
  if (Array.isArray(data.selectedPlaces)) {
    const seen = new Set<string>();
    for (const item of data.selectedPlaces.slice(0, 60)) {
      const place = tryPlace(item);
      if (!place || place.category === "hotel") continue;
      if (seen.has(place.id)) continue;
      seen.add(place.id);
      selectedPlaces.push(place);
      if (selectedPlaces.length >= 40) break;
    }
  }

  return {
    city,
    center,
    hotel: hotel ?? undefined,
    hotelUndecided: hotel ? undefined : true,
    days,
    date,
    pace,
    styles,
    experiences: experiences.length ? experiences : undefined,
    transport,
    budgetTier,
    adults,
    children,
    seniors,
    avoidSteep: data.avoidSteep === true,
    notes,
    seed,
    hotelPrice,
    fixedPlaces: fixedPlaces.length ? fixedPlaces : undefined,
    lockedPlaces: lockedPlaces.length ? lockedPlaces : undefined,
    excludeIds: excludeIds.length ? excludeIds : undefined,
    slimDays,
    selectedPlaces: selectedPlaces.length ? selectedPlaces : undefined,
    farDays,
    // LLM 只能改软参数，且每个值都经过范围收敛；不传时保持原有行为。
    planParams: data.planParams !== undefined
      ? sanitizeParams(data.planParams, data.avoidSteep === true)
      : undefined,
  };
}
