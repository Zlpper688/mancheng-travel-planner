import { bearing, directionLabel, meanPoint, seededJitter } from "../../geo";
import type { Place } from "../../types";
import { placeWaterKind } from "../../water";
import { rhythmOf } from "../rhythm/profile";

const AREA_HINTS = [
  "鼓浪屿",
  "集美",
  "同安",
  "翔安",
  "海沧",
  "湖里",
  "思明",
  "曾厝垵",
  "中山路",
  "沙坡尾",
  "五缘湾",
  "环岛路",
  "厦大",
  "莲花",
  "五通",
];

export function describeArea(places: Place[], hotel: Place): string {
  if (!places.length) return "自由活动";
  const text = places
    .map((place) => `${place.name} ${place.address ?? ""} ${place.island ?? ""}`)
    .join(" ");
  const counts = AREA_HINTS.map((hint) => ({
    hint,
    count: text.split(hint).length - 1,
  })).sort((a, b) => b.count - a.count);
  if (counts[0] && counts[0].count >= 2) return counts[0].hint;
  const island = places.find((place) => place.island);
  if (island) {
    const sameIsland = places.filter(
      (place) => place.island === island.island,
    ).length;
    if (sameIsland >= 2) return island.island as string;
  }
  const center = meanPoint(places.map((place) => [place.lng, place.lat]));
  const dir = directionLabel(bearing([hotel.lng, hotel.lat], center));
  return `${dir}方向`;
}

type ThemeKind =
  | "coast"
  | "sunset"
  | "culture"
  | "street"
  | "nature"
  | "classic"
  | "food"
  | "mixed";

const THEME_VARIANTS: Record<ThemeKind, string[]> = {
  coast: ["沿一段海岸线", "追海风的一天", "日落与潮声"],
  sunset: ["等一场日落", "天光落下之前", "把傍晚留给天色"],
  culture: ["人文半日", "旧城与旧梦", "读一读这座城"],
  street: ["街巷寻味", "拐进老城", "市井散步"],
  nature: ["公园与风", "在绿荫里走", "山野呼吸"],
  classic: ["地标巡礼", "把精华走一遍", "一眼认出的城"],
  food: ["为吃而来", "从早吃到晚", "本地人的餐桌"],
  mixed: ["顺路而行", "慢慢铺开的一天", "城市拼图"],
};

export function describeTheme(
  places: Place[],
  seed: number,
  dayIndex: number,
  city = "",
): string {
  if (!places.length) return "留白的一天";
  const counts: Record<ThemeKind, number> = {
    coast: 0,
    sunset: 0,
    culture: 0,
    street: 0,
    nature: 0,
    classic: 0,
    food: 0,
    mixed: 0,
  };
  for (const place of places) {
    const tags = `${(place.tags ?? []).join(" ")} ${place.note ?? ""}`;
    if (placeWaterKind(city, place) === "sea") counts.coast += 1;
    if (city && rhythmOf(city, place).sunset) counts.sunset += 1;
    if (["museum", "temple"].includes(place.category) || /culture|历史|建筑/.test(tags)) {
      counts.culture += 1;
    }
    if (["street", "market"].includes(place.category) || /citywalk|街|巷/.test(tags)) {
      counts.street += 1;
    }
    if (["park", "nature"].includes(place.category) || /family|亲子/.test(tags)) {
      counts.nature += 1;
    }
    if (place.category === "attraction") counts.classic += 1;
    if (place.category === "food") counts.food += 1;
  }
  const order: ThemeKind[] = [
    "coast",
    "sunset",
    "culture",
    "street",
    "food",
    "nature",
    "classic",
    "mixed",
  ];
  let winner: ThemeKind = "mixed";
  let winnerScore = -1;
  for (const kind of order) {
    if (counts[kind] > winnerScore) {
      winnerScore = counts[kind];
      winner = kind;
    }
  }
  const variants = THEME_VARIANTS[winner];
  const jitter = seededJitter(seed, `theme-${dayIndex}-${winner}`, 1);
  const base = Math.floor((jitter + 1) * 0.5 * variants.length);
  // 叠加日期偏移，保证连续两天的同主题永远不会落到同一个说法。
  const pick = (base + Math.max(0, dayIndex - 1)) % variants.length;
  return variants[pick];
}
