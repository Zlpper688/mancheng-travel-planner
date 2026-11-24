import { findPlaceProfile } from "../tips/lookup";
import type { Place } from "../types";

// 主卖点就是爬山/登顶的点位：老人或明确说“不爬山”时不再自动入线。
const CORE = /爬山|登山|登顶|制高点|石阶|长台阶|台阶多|陡坡|山道|攀岩|徒步|山顶/;
// 只是部分区域有台阶/坡道，保留点位，靠评分降权。
const SOFT = /台阶|坡道|爬坡|上坡|斜坡/;

export type Steepness = "core" | "soft" | null;

// OSM 里没有攻略文案，山峰/山岳型自然保护区只能靠标签判断；
// 老人或明确说“不爬山”时，这类点位按核心爬山点处理。
const PEAK_TAG = /natural[= ]peak|nature[_ ]reserve|\bpeak\b/;
const MOUNTAIN_SUFFIX = /(?:山|峰)$/;
// 峡谷、山沟、河谷型景区同样以石阶和起伏山路为主，老人同行时不能当平路景点。
const GORGE_SUFFIX = /(?:峡谷|峡|沟|涧|河谷)$/;
const TERRAIN_CATEGORY = new Set(["nature", "park", "viewpoint", "attraction"]);

export function steepnessOf(city: string, place: Place): Steepness {
  const profile = findPlaceProfile(city || place.city || "", place.name);
  const primary = [
    place.name,
    place.note ?? "",
    (place.tags ?? []).join(" "),
    profile?.highlight ?? "",
    profile?.photo ?? "",
  ].join(" ");
  const secondary = [profile?.caution ?? "", profile?.family ?? ""].join(" ");
  if (CORE.test(primary)) return "core";
  const bareName = place.name
    .replace(/(?:风景名胜区|风景区|景区|国家森林公园|森林公园|自然保护区)/g, "")
    .trim();
  if (
    MOUNTAIN_SUFFIX.test(bareName) &&
    (PEAK_TAG.test(primary) || place.category === "nature")
  ) {
    return "core";
  }
  if (
    GORGE_SUFFIX.test(bareName) &&
    (TERRAIN_CATEGORY.has(place.category) || PEAK_TAG.test(primary))
  ) {
    return "core";
  }
  if (SOFT.test(primary) || CORE.test(secondary) || SOFT.test(secondary)) {
    return "soft";
  }
  return null;
}

const NOTE_AVOID =
  /不(?:想|要|用|能|去|排|安排|愿意|喜欢)?(?:爬山|登山|爬坡|爬台阶|上台阶|登高)|别(?:安排|去|爬)?(?:爬山|登山|登高|爬坡)|避开(?:爬山|登山|爬坡|台阶)|避免(?:爬山|登山|爬坡|台阶)|(?:腿脚|膝盖|关节)(?:不便|不好|不行|有伤|疼)|爬不动|走不了(?:山路|台阶|坡)/;

export function notesAvoidSteep(notes?: string): boolean {
  return Boolean(notes && NOTE_AVOID.test(notes));
}

export function avoidSteepFor(input: {
  avoidSteep?: boolean;
  seniors?: number;
  notes?: string;
}): boolean {
  return Boolean(
    input.avoidSteep ||
      (input.seniors ?? 0) > 0 ||
      notesAvoidSteep(input.notes),
  );
}
