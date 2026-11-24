import { estimateModeMinutes, placeDistance } from "../geo";
import { findPlaceProfile } from "../tips/lookup";
import { placeWaterKind, cityHasSea, hasStrongSeaEvidence } from "../water";
import type {
  DayAlternative,
  ExperienceId,
  Place,
  WishlistGoal,
} from "../types";
import { BAND_LABELS, rhythmOf, type TimeBand } from "./rhythm/profile";

export interface ExperienceDef {
  id: ExperienceId;
  label: string;
  phrase: string;
  band: TimeBand;
  durationMin: number;
  weather: "clear" | "dry" | "any";
}

export const EXPERIENCE_DEFS: Record<ExperienceId, ExperienceDef> = {
  sunrise: {
    id: "sunrise",
    label: "看日出",
    phrase: "在{place}看一场日出",
    band: "dawn",
    durationMin: 90,
    weather: "clear",
  },
  sunset: {
    id: "sunset",
    label: "看日落",
    phrase: "在{place}等一场日落",
    band: "golden",
    durationMin: 90,
    weather: "clear",
  },
  night: {
    id: "night",
    label: "夜景夜市",
    phrase: "在{place}看夜景、逛夜市",
    band: "evening",
    durationMin: 120,
    weather: "dry",
  },
  coast: {
    id: "coast",
    label: "海边",
    phrase: "去{place}踩沙滩、吹海风",
    band: "golden",
    durationMin: 150,
    weather: "dry",
  },
  boat: {
    id: "boat",
    label: "坐船",
    phrase: "从{place}坐船看水上风景",
    band: "morning",
    durationMin: 120,
    weather: "dry",
  },
  hike: {
    id: "hike",
    label: "登山徒步",
    phrase: "走一趟{place}的登山步道",
    band: "morning",
    durationMin: 240,
    weather: "dry",
  },
  oldtown: {
    id: "oldtown",
    label: "老街古城",
    phrase: "在{place}慢慢逛老街",
    band: "afternoon",
    durationMin: 150,
    weather: "any",
  },
  museum: {
    id: "museum",
    label: "博物馆",
    phrase: "去{place}看一场展览",
    band: "midday",
    durationMin: 120,
    weather: "any",
  },
  temple: {
    id: "temple",
    label: "古寺",
    phrase: "到{place}上炷香、看看古建",
    band: "morning",
    durationMin: 60,
    weather: "any",
  },
  food: {
    id: "food",
    label: "当地小吃",
    phrase: "在{place}吃一轮当地小吃",
    band: "midday",
    durationMin: 90,
    weather: "any",
  },
  ride: {
    id: "ride",
    label: "骑行",
    phrase: "沿{place}骑行一段",
    band: "morning",
    durationMin: 150,
    weather: "dry",
  },
  photo: {
    id: "photo",
    label: "拍照",
    phrase: "在{place}拍一张代表作",
    band: "golden",
    durationMin: 60,
    weather: "clear",
  },
  soak: {
    id: "soak",
    label: "温泉",
    phrase: "在{place}泡个温泉",
    band: "afternoon",
    durationMin: 150,
    weather: "any",
  },
  show: {
    id: "show",
    label: "看演出",
    phrase: "在{place}看一场演出",
    band: "evening",
    durationMin: 120,
    weather: "any",
  },
};

export interface ExperienceHit {
  id: ExperienceId;
  weight: number;
}

const hitCache = new Map<string, ExperienceHit[]>();

function textOf(place: Place): string {
  const profile = findPlaceProfile(place.city ?? "", place.name);
  return [
    place.name,
    place.note ?? "",
    (place.tags ?? []).join(" "),
    profile?.bestTime ?? "",
    profile?.highlight ?? "",
    profile?.photo ?? "",
    profile?.booking ?? "",
  ].join(" ");
}

export function experiencesOf(
  city: string,
  place: Place,
  coastalCity = false,
): ExperienceHit[] {
  const key = `${city}|${place.id}|${coastalCity ? "sea" : "inland"}`;
  const cached = hitCache.get(key);
  if (cached) return cached;

  const rhythm = rhythmOf(city, place);
  const profile = findPlaceProfile(city, place.name);
  const text = textOf({ ...place, city });
  const weights = new Map<ExperienceId, number>();
  const add = (id: ExperienceId, weight: number) => {
    if (weight <= 0) return;
    weights.set(id, Math.max(weights.get(id) ?? 0, weight));
  };

  if (rhythm.sunrise) add("sunrise", 1.6);
  if (rhythm.sunset) add("sunset", 1.6);
  if (rhythm.nightStreet) add("night", 1.6);
  else if (rhythm.bands.includes("night")) add("night", 0.9);

  // 湖滩、河边沙滩不能当成海岸；内陆城市的「沙滩」还要有城市层面的临海证据。
  const coastalSight = [
    "beach",
    "viewpoint",
    "attraction",
    "park",
    "nature",
    "street",
  ].includes(place.category);
  if (
    coastalSight &&
    placeWaterKind(city, place) === "sea" &&
    (coastalCity || hasStrongSeaEvidence(city, place))
  ) {
    add("coast", place.category === "beach" ? 1.8 : 1.2);
  }

  if (/船|轮渡|游船|竹筏|漂流|帆船|游艇|上岛|夜游/.test(text)) add("boat", 1.5);
  else if (place.island) add("boat", 0.9);

  if (place.category === "nature") add("hike", 1.5);
  if (/登山|徒步|爬山|步道|峡谷|山峰|山顶|森林|山野|栈道/.test(text)) {
    add("hike", 1.3);
  }

  if (place.category === "museum") add("museum", 1.8);
  if (place.category === "temple") add("temple", 1.8);

  if (place.category === "market" || place.category === "food") add("food", 1.5);
  if (/小吃|美食|海鲜|夜市|市场|老字号|鱼丸|沙茶|小吃街/.test(text)) {
    add("food", 1.1);
  }

  if (/骑行|骑车|自行车|单车|骑游|环岛路|环湖骑/.test(text)) add("ride", 1.3);

  if (place.category === "street") add("oldtown", 1.2);
  if (/古城|古镇|老街|古街|骑楼|历史街区|老巷|文创/.test(text)) {
    add("oldtown", 1.2);
  }

  if (/温泉|汤池|泡汤/.test(text)) add("soak", 1.7);
  if (/演出|表演|剧场|音乐|灯光秀|实景|戏剧/.test(text)) add("show", 1.4);

  if (profile?.photo) add("photo", 1.1);
  if (/拍照|摄影|机位|取景|打卡|最美|出片/.test(text)) add("photo", 1.0);
  if (
    (place.popularity ?? 0) >= 4.6 &&
    ["attraction", "viewpoint", "beach", "nature"].includes(place.category)
  ) {
    add("photo", 0.7);
  }

  const hits = [...weights.entries()]
    .map(([id, weight]) => ({ id, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4);
  hitCache.set(key, hits);
  return hits;
}

function goalScore(city: string, place: Place, weight: number): number {
  const profile = findPlaceProfile(city, place.name);
  const rhythm = rhythmOf(city, place);
  return (
    (place.popularity ?? 3.4) * 1.1 +
    weight * 1.5 +
    (rhythm.heroEligible ? 0.6 : 0) +
    (profile?.highlight ? 0.35 : 0)
  );
}

// 同一类体验落到不同类型点位上时，说法要跟现场一致，避免把炮台说成沙滩。
function phraseFor(id: ExperienceId, place: Place): string {
  if (id === "coast") {
    return place.category === "beach"
      ? "去{place}踩沙滩、吹海风"
      : "沿{place}的海边走一段";
  }
  if (id === "museum" && /海底|水族|海洋/.test(place.name)) {
    return "去{place}看海洋生物";
  }
  if (id === "boat") {
    return place.island
      ? "坐船去{place}，从水上看看这座城"
      : "在{place}坐船游一段";
  }
  return EXPERIENCE_DEFS[id].phrase;
}

/** 把一个城市的供给翻译成攻略式的「心愿单」：每类体验挑一个最值得去的点。 */
export function buildWishlist(
  city: string,
  places: Place[],
  limit = 8,
): WishlistGoal[] {
  const coastal = cityHasSea(city, places);
  const best = new Map<
    ExperienceId,
    { place: Place; weight: number; score: number }
  >();
  for (const place of places) {
    if (place.category === "hotel") continue;
    const hits = experiencesOf(city, place, coastal);
    // 看日落、看夜景这类体验本身就发生在短暂停留的点位上，
    // 不能因为点位是 quickStop 就把整类体验从心愿单里删掉。
    if (rhythmOf(city, place).quickStop && !hits.some((hit) => hit.weight >= 1.5)) {
      continue;
    }
    for (const hit of hits) {
      if (hit.weight < 0.9) continue;
      const score = goalScore(city, place, hit.weight);
      const current = best.get(hit.id);
      if (!current || score > current.score) {
        best.set(hit.id, { place, weight: hit.weight, score });
      }
    }
  }

  const ranked = [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  return ranked.map(([id, item]) => {
    const def = EXPERIENCE_DEFS[id];
    const alternatives = places
      .filter(
        (place) =>
          place.id !== item.place.id &&
          place.category !== "hotel" &&
          experiencesOf(city, place, coastal).some(
            (hit) => hit.id === id && hit.weight >= 1.1,
          ),
      )
      .sort((a, b) => {
        const kind = (place: Place) =>
          (place.category === item.place.category ? 2 : 0) +
          (place.island === item.place.island ? 1 : 0);
        return kind(b) - kind(a) || (b.popularity ?? 0) - (a.popularity ?? 0);
      })
      .slice(0, 2)
      .map((place) => ({ placeId: place.id, name: place.name }));
    return {
      experience: id,
      label: phraseFor(id, item.place).replace("{place}", item.place.name),
      placeId: item.place.id,
      placeName: item.place.name,
      bandLabel: BAND_LABELS[def.band],
      durationMin: def.durationMin,
      reason: findPlaceProfile(city, item.place.name)?.highlight?.split(
        /[，。；]/,
      )[0],
      alternatives,
    };
  });
}

/** 选点加权：用户勾选的心愿，落到具体点位上时给明显加成。 */
export function experienceAffinity(
  city: string,
  place: Place,
  wanted: ExperienceId[] | undefined,
  coastal = false,
): number {
  if (!wanted?.length) return 0;
  let bonus = 0;
  const hits = experiencesOf(city, place, coastal);
  for (const id of wanted) {
    const hit = hits.find((item) => item.id === id);
    if (hit) bonus = Math.max(bonus, hit.weight * 2.6);
  }
  return bonus;
}

/** 同一天的备选：同一种体验、在附近、名气不弱，临时换点不用重做整条线。 */
export function alternativesFor(
  city: string,
  place: Place,
  pool: Place[],
  limit = 2,
): DayAlternative[] {
  const coastal = cityHasSea(city, pool);
  const primary = experiencesOf(city, place, coastal)[0];
  if (!primary) return [];
  return pool
    .filter((candidate) => candidate.id !== place.id)
    .map((candidate) => {
      const hit = experiencesOf(city, candidate, coastal).find(
        (item) => item.id === primary.id && item.weight >= 1.1,
      );
      if (!hit) return null;
      if (rhythmOf(city, candidate).quickStop) return null;
      const km = placeDistance(place, candidate);
      // 同日备选要能在原时段内换过去，太远就变成重做一天。
      if (km > 10) return null;
      if (estimateModeMinutes(place, candidate, "taxi") > 25) return null;
      return { candidate, km, weight: hit.weight };
    })
    .filter(
      (
        item,
      ): item is { candidate: Place; km: number; weight: number } =>
        Boolean(item),
    )
    .sort(
      (a, b) =>
        (b.candidate.popularity ?? 0) -
        (a.candidate.popularity ?? 0) -
        (b.km - a.km) * 0.08,
    )
    .slice(0, limit)
    .map(({ candidate, km }) => ({
      placeId: candidate.id,
      name: candidate.name,
      experience: primary.id,
      experienceLabel: EXPERIENCE_DEFS[primary.id].label,
      distanceKm: Math.round(km * 10) / 10,
      reason: `${EXPERIENCE_DEFS[primary.id].label} · ${km.toFixed(1)} km`,
    }));
}
