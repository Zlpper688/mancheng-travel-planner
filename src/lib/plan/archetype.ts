import type { DayPlan, Place } from "../types";

export type ExperienceId =
  | "coast"
  | "culture"
  | "street"
  | "food"
  | "nature"
  | "landmark"
  | "mixed";

export type DayArchetypeId = "island" | ExperienceId;

export const EXPERIENCE_LABELS: Record<ExperienceId, string> = {
  coast: "海岸",
  culture: "人文",
  street: "街区",
  food: "吃喝",
  nature: "自然",
  landmark: "地标",
  mixed: "混合",
};

export const DAY_ARCHETYPE_LABELS: Record<DayArchetypeId, string> = {
  island: "海岛",
  ...EXPERIENCE_LABELS,
};

function textOf(place: Place): string {
  return `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")} ${place.address ?? ""}`;
}

const COAST = /coast|海岸|海滨|海湾|海景|海风|看海|海边|海浪|沙滩/i;
const CULTURE = /culture|history|历史|文化|建筑|遗产|纪念馆|故居|旧址|遗址|会馆|领事馆|公馆|洋行|海关|教堂|别墅|山庄|寺|校园|炮台|古城|古镇|园林/i;
const STREET = /citywalk|街|巷|市集|步行街/i;
const FOOD = /food|小吃|海鲜|美食|咖啡|茶|餐厅|市场|老字号/i;
const NATURE = /nature|森林|公园|植物园|湿地|山林|山野|爬山|山顶|山景/i;
const LANDMARK = /photo|地标|必去/i;
const HERITAGE = /文物保护单位|文保|heritage|历史建筑/i;

export function experienceOf(place: Place): ExperienceId {
  const text = textOf(place);
  const scores: Record<ExperienceId, number> = {
    coast: 0,
    culture: 0,
    street: 0,
    food: 0,
    nature: 0,
    landmark: 0,
    mixed: 0,
  };

  switch (place.category) {
    case "beach":
      scores.coast += 4;
      break;
    case "museum":
    case "temple":
      scores.culture += 3.2;
      break;
    case "street":
      scores.street += 3.2;
      break;
    case "market":
      scores.food += 3.2;
      break;
    case "park":
    case "nature":
      scores.nature += 3.2;
      break;
    case "food":
      scores.food += 3.2;
      break;
    case "cafe":
      scores.food += 2.6;
      break;
    case "attraction":
    case "viewpoint":
      scores.landmark += 1.2;
      break;
    default:
      scores.mixed += 1;
  }

  if (COAST.test(text)) scores.coast += 1.8;
  if (CULTURE.test(text)) scores.culture += 1.8;
  if (HERITAGE.test(text)) scores.culture += 3.2;
  if (STREET.test(text)) scores.street += 1.2;
  if (FOOD.test(text)) scores.food += 1.2;
  if (NATURE.test(text)) scores.nature += 1.2;
  if (/(山|岭|峰)$/.test(place.name)) scores.nature += 1.2;
  if (LANDMARK.test(text)) scores.landmark += 0.6;

  const order: ExperienceId[] = [
    "coast",
    "culture",
    "street",
    "food",
    "nature",
    "landmark",
    "mixed",
  ];
  let best: ExperienceId = "mixed";
  let bestScore = 0;
  for (const id of order) {
    if (scores[id] > bestScore) {
      best = id;
      bestScore = scores[id];
    }
  }
  return best;
}

export function isIndoorPlace(place: Place): boolean {
  if (["museum", "cafe", "food"].includes(place.category)) return true;
  return /博物馆|美术馆|展览|水族馆|科技馆|室内|馆$/.test(textOf(place));
}

export function isHumanitiesPlace(place: Place): boolean {
  const text = textOf(place);
  if (/海底世界|水族馆|海洋馆|科技馆|自然博物馆|植物园|森林公园|动物园/.test(text)) {
    return false;
  }
  if (place.category === "museum" || place.category === "temple") return true;
  if (place.category === "street") {
    return /老街|古镇|骑楼|历史|文化|步行街/i.test(text);
  }
  if (place.category === "park") {
    return /花园|故居|纪念|寺|园林/i.test(text);
  }
  if (place.category === "attraction") {
    return CULTURE.test(text);
  }
  return false;
}

export function dayArchetypeOf(day: DayPlan): DayArchetypeId {
  const sights = day.stops
    .filter((stop) => stop.kind === "sight")
    .map((stop) => stop.place);
  if (!sights.length) return "mixed";
  if (sights.some((place) => place.island)) return "island";

  const counts = new Map<ExperienceId, number>();
  for (const place of sights) {
    const id = experienceOf(place);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: ExperienceId = "mixed";
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  const share = bestCount / sights.length;
  return bestCount >= 2 && share >= 0.45 ? best : "mixed";
}