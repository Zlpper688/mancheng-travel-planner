import { PACES } from "../constants";
import {
  angleDistance,
  bearing,
  directionLabel,
  estimateModeMinutes,
  meanPoint,
  placeDistance,
  seededJitter,
} from "../geo";
import { dedupePlaces } from "../providers/normalize";
import { metroAccess, sharedMetroLine } from "../transit/metro";
import type {
  Category,
  FixedPlace,
  PaceId,
  Place,
  StyleId,
  TransportPref,
} from "../types";
import {
  composeDay,
  rhythmBudgetMinutes,
  rhythmOf,
  type RhythmProfile,
} from "./rhythm";

export interface DaySeed {
  index: number;
  places: Place[];
  fixed: boolean;
  area: string;
  theme: string;
  far?: boolean;
  anchorIds?: string[];
  startMinHint?: number;
}

export interface SelectInput {
  sights: Place[];
  hotel: Place;
  days: number;
  pace: PaceId;
  styles: StyleId[];
  seed: number;
  radiusKm: number;
  transport: TransportPref;
  city: string;
  fixedPlaces?: FixedPlace[];
  /** 单点锁定：必须进入指定那天，但当天其余点位仍由算法安排。 */
  lockedPlaces?: FixedPlace[];
  /** 用户从某天移除点位后，该天要少排几个，避免「移除」被自动补位抵消。 */
  slimDays?: Record<number, number>;
  farDays?: number;
}

export interface SelectResult {
  days: DaySeed[];
  warnings: string[];
  farDays: number;
}

type StyleProfile = {
  categories: Partial<Record<Category, number>>;
  tags: Record<string, number>;
};

const STYLE_PROFILE: Record<StyleId, StyleProfile> = {
  citywalk: {
    categories: { street: 1.6, market: 1.2, cafe: 0.9, park: 0.7, temple: 0.5, attraction: 0.4 },
    tags: {
      citywalk: 1.6,
      photo: 0.5,
      老街: 0.9,
      巷: 0.7,
      骑楼: 0.8,
      文创: 0.9,
      local: 0.6,
      咖啡: 0.7,
      小店: 0.6,
    },
  },
  classic: {
    categories: { attraction: 1.6, viewpoint: 1.3, museum: 1, temple: 1, park: 0.8 },
    tags: { classic: 1.8, photo: 0.5, 地标: 1, 必去: 0.9, 历史: 0.4 },
  },
  coastal: {
    categories: { beach: 1.8, viewpoint: 1.5, park: 1, street: 0.8 },
    tags: {
      coast: 1.8,
      海: 1.1,
      beach: 1,
      日落: 1,
      photo: 0.5,
      环岛: 1,
      岛: 0.5,
      slow: 0.4,
    },
  },
  culture: {
    categories: { museum: 1.8, temple: 1.6, attraction: 1, street: 0.9, park: 0.7 },
    tags: { culture: 1.8, 历史: 1.1, 建筑: 1.1, 纪念馆: 0.9, indoor: 0.4 },
  },
  foodie: {
    categories: { market: 1.6, street: 1.2, cafe: 0.9, attraction: 0.6 },
    tags: { food: 1.8, 小吃: 1.2, local: 1, 海鲜: 0.8, cluster: 0.6, 老字号: 0.8 },
  },
  family: {
    categories: { park: 1.4, beach: 1.4, museum: 1, attraction: 0.9, nature: 0.8 },
    tags: { family: 1.8, 亲子: 1.2, indoor: 0.6, 沙滩: 0.6, 公园: 0.5, photo: 0.3 },
  },
};

function styleAffinity(place: Place, styles: StyleId[]): number {
  const text = `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")} ${place.address ?? ""}`;
  let best = 0;
  let sum = 0;
  for (const style of styles) {
    const profile = STYLE_PROFILE[style];
    let value = profile.categories[place.category] ?? 0;
    for (const [tag, weight] of Object.entries(profile.tags)) {
      if (text.includes(tag)) value += weight;
    }
    best = Math.max(best, value);
    sum += value;
  }
  const secondary = (sum - best) * 0.24;
  return best + secondary;
}

function scorePlace(
  place: Place,
  hotel: Place,
  styles: StyleId[],
  seed: number,
  radiusKm: number,
  transport: TransportPref,
  city: string,
): number {
  const affinity = styleAffinity(place, styles);
  const popularity = place.popularity ?? 3.4;
  const distance = placeDistance(hotel, place);
  const distanceScale =
    transport === "drive" ? 0.58 : transport === "walk" ? 1.05 : 0.82;
  const reachPenalty =
    Math.pow(
      Math.min(2.2, distance / Math.max(5, radiusKm * 0.5)),
      1.35,
    ) *
    1.45 *
    distanceScale;
  const qualityPenalty = Math.max(0, 4.05 - popularity) * 1.8;
  const text = `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")}`;
  const mustSee =
    popularity >= 4.5 || /classic|必去|地标/.test(text) ? 1.1 : 0;
  const ratingBonus = place.rating && place.rating >= 4.6 ? 0.3 : 0;
  const fameWeight = styles.includes("classic") ? 2.7 : 2;
  const fameBonus = Math.max(0, popularity - 4.1) * fameWeight;
  const metro =
    transport === "drive" ? null : metroAccess(place, city);
  const metroBonus = metro
    ? metro.walkMin <= 10
      ? 0.48
      : metro.walkMin <= 16
        ? 0.2
        : 0
    : 0;
  const islandPenalty =
    place.island && place.island !== hotel.island ? 0.5 : 0;
  const jitter = seededJitter(seed, place.id, 0.28);
  return (
    affinity * 1 +
    popularity * 2 +
    fameBonus +
    mustSee +
    metroBonus +
    ratingBonus +
    jitter -
    qualityPenalty -
    reachPenalty -
    islandPenalty
  );
}

function anchorSameCluster(a: Place, b: Place): boolean {
  if (a.island || b.island) {
    return Boolean(a.island && b.island && a.island === b.island);
  }
  return placeDistance(a, b) < 2.3;
}

function canCluster(anchor: Place, place: Place, radiusKm: number): boolean {
  if (anchor.island || place.island) {
    return Boolean(
      anchor.island && place.island && anchor.island === place.island,
    );
  }
  return placeDistance(anchor, place) <= radiusKm;
}

function clusterRadiusFor(
  styles: StyleId[],
  pace: PaceId,
  transport: TransportPref,
): number {
  let radius = 4.4;
  if (transport === "drive") radius += 0.8;
  if (styles.includes("family")) radius -= 0.6;
  if (styles.includes("citywalk")) radius -= 0.3;
  if (pace === "chill") radius -= 0.3;
  return Math.max(3.2, radius);
}

function isMandatoryAnchor(place: Place): boolean {
  const text = `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")}`;
  return (place.popularity ?? 0) >= 4.4 || /classic|必去|地标/.test(text);
}

function rhythmRoles(profile: RhythmProfile): string[] {
  const roles: string[] = [];
  if (profile.sunset) roles.push("sunset");
  if (profile.sunrise) roles.push("sunrise");
  if (profile.indoor) roles.push("indoor");
  if (profile.marketMorning) roles.push("market");
  if (profile.morningOnly) roles.push("morningOnly");
  if (profile.nightStreet) roles.push("night");
  if (profile.quickStop) roles.push("quick");
  if (profile.bands.includes("morning") || profile.bands.includes("dawn")) {
    roles.push("morning");
  }
  return roles;
}

function roleCount(profiles: RhythmProfile[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const profile of profiles) {
    for (const role of rhythmRoles(profile)) {
      counts[role] = (counts[role] ?? 0) + 1;
    }
  }
  return counts;
}

function sunTooFar(place: Place, hotel: Place): boolean {
  return placeDistance(hotel, place) > 6.5;
}

// 只有傍晚才进入状态的普通点位，撑不起一整天；名气不够时不该当锚点。
function closingOnly(profile: RhythmProfile): boolean {
  return (
    !profile.sunset &&
    !profile.nightStreet &&
    profile.windows.length > 0 &&
    Math.min(...profile.windows.map(([start]) => start)) >= 14 * 60
  );
}

// 锚点不再只按名气取，先保证一天里能有一个主景、一个日落/室内位，
// 并避免把两个商业街或两个日落点排进同一天。
function pickNearAnchors(
  pool: ScoredPlace[],
  count: number,
  radiusKm: number,
  city: string,
  hotel: Place,
  styles: StyleId[],
): ScoredPlace[] {
  const anchors: ScoredPlace[] = [];
  const profileOf = (item: ScoredPlace) => rhythmOf(city, item.place);
  const mandatory = [...pool].sort(
    (a, b) =>
      (b.place.popularity ?? 0) - (a.place.popularity ?? 0) ||
      b.score - a.score,
  );
  for (const item of mandatory) {
    if (anchors.length >= count) break;
    if (!isMandatoryAnchor(item.place)) continue;
    const profile = profileOf(item);
    if (profile.quickStop || !profile.heroEligible) continue;
    if (profile.sunrise && sunTooFar(item.place, hotel)) continue;
    if (
      profile.sunset &&
      anchors.some((anchor) => profileOf(anchor).sunset)
    ) {
      continue;
    }
    if (
      profile.nightStreet &&
      anchors.some((anchor) => profileOf(anchor).nightStreet)
    ) {
      continue;
    }
    // 半天型大景（植物园这类）值得单独占一天；天数够多时允许它和邻近锚点分处两天。
    const standaloneLongStay =
      count >= 5 && profile.heroEligible && profile.longStay;
    if (
      !standaloneLongStay &&
      anchors.some((anchor) => anchorSameCluster(anchor.place, item.place))
    ) {
      continue;
    }
    anchors.push(item);
  }
  while (anchors.length < count) {
    let best: ScoredPlace | null = null;
    let bestValue = -Infinity;
    const counts = roleCount(anchors.map(profileOf));
    for (const item of pool) {
      const profile = profileOf(item);
      // 为了一个黄昏点专程跑很远不值：傍晚型点位名气不够时只当顺路收尾。
      if (closingOnly(profile) && !isFamous(item.place)) continue;
      const standaloneLongStay =
        count >= 5 && profile.heroEligible && profile.longStay;
      if (
        !standaloneLongStay &&
        anchors.some((anchor) => anchorSameCluster(anchor.place, item.place))
      ) {
        continue;
      }
      const company = pool.filter(
        (other) =>
          other.place.id !== item.place.id &&
          canCluster(item.place, other.place, radiusKm),
      ).length;
      let value = item.score + Math.min(5, company) * 0.34;
      if ((item.place.popularity ?? 0) >= 4.5) value += 0.35;
      if (anchors.some((anchor) => anchor.place.category === item.place.category)) {
        value -= 0.45;
      }
      if (!profile.heroEligible) value -= 1.4;
      if (profile.quickStop) value -= 3;
      if (profile.sunset) {
        value += counts.sunset ? (styles.includes("coastal") ? -1.2 : -2.8) : 0.5;
      }
      if (profile.sunrise) {
        value += counts.sunrise ? -3 : 0.35;
        if (sunTooFar(item.place, hotel)) value -= 2.5;
      }
      if (profile.indoor) value += counts.indoor ? -0.9 : 0.35;
      if (profile.marketMorning) value += counts.market ? -1.1 : 0.3;
      if (profile.nightStreet) value += counts.night ? -0.9 : 0.25;
      if (profile.quickStop && counts.quick) value -= 2.6;
      if (!counts.morning && profile.bands.includes("morning")) value += 0.6;
      if (value > bestValue) {
        bestValue = value;
        best = item;
      }
    }
    if (!best) break;
    anchors.push(best);
  }
  return anchors;
}

const FAR_MIN_POPULARITY = 4.15;
const FAR_MAX_ONE_WAY_MIN = 110;

function isFamous(place: Place): boolean {
  return (
    (place.popularity ?? 0) >= FAR_MIN_POPULARITY ||
    (place.rating ?? 0) >= 4.6
  );
}

function farLimitKm(styles: StyleId[]): number {
  let limit = 45;
  if (styles.includes("family")) limit = 32;
  else if (styles.includes("citywalk")) limit = 38;
  return limit;
}

function decideFarDays(
  requested: number | undefined,
  autoCount: number,
  capacity: number,
  farPool: ScoredPlace[],
  anchors: ScoredPlace[],
): number {
  if (autoCount < 1) return 0;
  const hardCap = Math.min(2, autoCount >= 2 ? autoCount - 1 : 1);
  if (requested !== undefined) {
    return Math.max(0, Math.min(requested, hardCap));
  }
  if (autoCount < 2 || anchors.length === 0) return 0;
  const want =
    autoCount >= 5 && anchors.length >= 3 && farPool.length >= capacity * 1.5
      ? 2
      : 1;
  return Math.min(want, hardCap);
}

// 远足日先选“主锚点”，再收拢周边顺路点位，保证一天只去一个方向。
function pickFarGroups(
  pool: ScoredPlace[],
  count: number,
  capacity: number,
  hotel: Place,
  seed: number,
  city: string,
  styles: StyleId[],
): ScoredPlace[][] {
  const remaining = [...pool].sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const groups: ScoredPlace[][] = [];
  const usedRoles: Record<string, number> = {};
  let previousDir: number | null = null;

  for (let day = 0; day < count; day++) {
    const candidates = remaining.filter((item) => !used.has(item.place.id));
    if (!candidates.length) break;
    const famous = candidates.filter((item) => isFamous(item.place));
    const anchorPool = famous.length ? famous : candidates;
    let bestAnchor: ScoredPlace | null = null;
    let bestValue = -Infinity;
    for (const item of anchorPool.slice(0, 36)) {
      const profile = rhythmOf(city, item.place);
      if (profile.quickStop) continue;
      // 远足日要有一个白天能撑起来的点，纯傍晚的普通点位不当远足锚点。
      if (closingOnly(profile) && !isFamous(item.place)) continue;
      const dir = bearing(
        [hotel.lng, hotel.lat],
        [item.place.lng, item.place.lat],
      );
      const company = candidates.filter(
        (other) =>
          other.place.id !== item.place.id &&
          placeDistance(other.place, item.place) <= 16,
      ).length;
      let value =
        item.score +
        Math.min(3, company) * 0.45 +
        seededJitter(seed, `far-${day}-${item.place.id}`, 0.5);
      if (previousDir !== null && angleDistance(dir, previousDir) < 55) {
        value -= 2.2;
      }
      if (!profile.heroEligible) value -= 0.9;
      if (profile.sunset) {
        value += usedRoles.sunset
          ? (styles.includes("coastal") ? -1.2 : -2.6)
          : 0.45;
      }
      if (profile.sunrise && sunTooFar(item.place, hotel)) value -= 2.4;
      if (profile.sunrise && usedRoles.sunrise) value -= 3;
      if (value > bestValue) {
        bestValue = value;
        bestAnchor = item;
      }
    }
    if (!bestAnchor) break;
    const anchor = bestAnchor;
    const anchorProfile = rhythmOf(city, anchor.place);
    const group: ScoredPlace[] = [anchor];
    used.add(anchor.place.id);
    // 车程近的外围城区可以排满；真正 1–2 小时的远足日少排一个点，留出路上时间。
    const oneWay = estimateModeMinutes(hotel, anchor.place, "taxi");
    const groupCap =
      oneWay <= 45 ? capacity : Math.max(2, capacity - 1);
    const anchorDir = bearing(
      [hotel.lng, hotel.lat],
      [anchor.place.lng, anchor.place.lat],
    );
    const nearby = candidates
      .filter(
        (item) =>
          item.place.id !== anchor.place.id && !used.has(item.place.id),
      )
      .map((item) => ({
        item,
        km: placeDistance(item.place, anchor.place),
        dir: bearing(
          [hotel.lng, hotel.lat],
          [item.place.lng, item.place.lat],
        ),
      }))
      .filter(
        (entry) =>
          entry.km <= 16 &&
          (entry.km <= 6 ||
            angleDistance(entry.dir, anchorDir) <= 55) &&
          estimateModeMinutes(anchor.place, entry.item.place, "taxi") <= 30,
      )
      .sort(
        (a, b) =>
          b.item.score - b.km * 0.16 - (a.item.score - a.km * 0.16),
      );
    const groupRoles: Record<string, number> = {
      sunset: anchorProfile.sunset ? 1 : 0,
      sunrise: anchorProfile.sunrise ? 1 : 0,
      market: anchorProfile.marketMorning ? 1 : 0,
      quick: anchorProfile.quickStop ? 1 : 0,
      indoor: anchorProfile.indoor ? 1 : 0,
    };
    for (const entry of nearby) {
      if (group.length >= groupCap) break;
      const profile = rhythmOf(city, entry.item.place);
      if (profile.quickStop && groupRoles.quick >= 1) continue;
      if (profile.sunset && groupRoles.sunset >= 1) continue;
      if (profile.sunrise && groupRoles.sunrise >= 1) continue;
      if (profile.indoor && groupRoles.indoor >= 2) continue;
      const groupOpensEarly =
        (groupRoles.market ?? 0) > 0 || (groupRoles.sunrise ?? 0) > 0;
      if (profile.sunset && groupOpensEarly) continue;
      if (
        (profile.marketMorning || profile.sunrise) &&
        (groupRoles.sunset ?? 0) > 0
      ) {
        continue;
      }
      group.push(entry.item);
      used.add(entry.item.place.id);
      groupRoles.sunset += profile.sunset ? 1 : 0;
      groupRoles.sunrise += profile.sunrise ? 1 : 0;
      groupRoles.market += profile.marketMorning ? 1 : 0;
      groupRoles.quick += profile.quickStop ? 1 : 0;
      groupRoles.indoor += profile.indoor ? 1 : 0;
    }
    groups.push(group);
    usedRoles.sunset = (usedRoles.sunset ?? 0) + (groupRoles.sunset > 0 ? 1 : 0);
    usedRoles.sunrise = (usedRoles.sunrise ?? 0) + (groupRoles.sunrise > 0 ? 1 : 0);
    previousDir = bearing(
      [hotel.lng, hotel.lat],
      [anchor.place.lng, anchor.place.lat],
    );
  }
  return groups;
}

type ScoredPlace = { place: Place; score: number; distance: number };

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

function describeArea(places: Place[], hotel: Place): string {
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
  | "culture"
  | "street"
  | "nature"
  | "classic"
  | "food"
  | "mixed";

const THEME_VARIANTS: Record<ThemeKind, string[]> = {
  coast: ["沿一段海岸线", "追海风的一天", "日落与潮声"],
  culture: ["人文半日", "旧城与旧梦", "读一读这座城"],
  street: ["街巷寻味", "拐进老城", "市井散步"],
  nature: ["公园与风", "在绿荫里走", "山野呼吸"],
  classic: ["地标巡礼", "把精华走一遍", "一眼认出的城"],
  food: ["为吃而来", "从早吃到晚", "本地人的餐桌"],
  mixed: ["顺路而行", "慢慢铺开的一天", "城市拼图"],
};

function describeTheme(
  places: Place[],
  seed: number,
  dayIndex: number,
): string {
  if (!places.length) return "留白的一天";
  const counts: Record<ThemeKind, number> = {
    coast: 0,
    culture: 0,
    street: 0,
    nature: 0,
    classic: 0,
    food: 0,
    mixed: 0,
  };
  for (const place of places) {
    const tags = `${(place.tags ?? []).join(" ")} ${place.note ?? ""}`;
    if (["beach", "viewpoint"].includes(place.category) || /coast|海|日落/.test(tags)) {
      counts.coast += 1;
    }
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
  const pick = Math.min(
    variants.length - 1,
    Math.floor((jitter + 1) * 0.5 * variants.length),
  );
  return variants[pick];
}

function samePlace(a: Place, b: Place): boolean {
  if (a.id === b.id) return true;
  return (
    placeDistance(a, b) < 0.25 &&
    (a.name.includes(b.name) || b.name.includes(a.name))
  );
}

export function selectDays(input: SelectInput): SelectResult {
  const {
    hotel,
    days,
    pace,
    styles,
    seed,
    transport,
    city,
    fixedPlaces = [],
    lockedPlaces = [],
  } = input;
  const warnings: string[] = [];

  const fixedByDay = new Map<number, Place[]>();
  for (const fixed of fixedPlaces) {
    const day = Math.round(fixed.day);
    if (day < 1 || day > days) {
      warnings.push(`攻略里第 ${day} 天的「${fixed.place.name}」超出本次 ${days} 天的行程，已忽略。`);
      continue;
    }
    if (fixed.place.category === "hotel") continue;
    const list = fixedByDay.get(day) ?? [];
    if (!list.some((item) => samePlace(item, fixed.place))) {
      list.push(fixed.place);
      fixedByDay.set(day, list);
    }
  }

  const fixedIds = new Set<string>();
  for (const list of fixedByDay.values()) {
    for (const place of list) fixedIds.add(place.id);
  }

  const fixedDays = new Set(
    [...fixedByDay.entries()]
      .filter(([, list]) => list.length > 0)
      .map(([day]) => day),
  );
  const autoDays = Array.from({ length: days }, (_, index) => index + 1).filter(
    (day) => !fixedDays.has(day),
  );

  // 单点锁定：这个点必须出现在指定那天，但当天其余点位照常由算法安排。
  // 必须与 fixedPlaces 分开处理——fixedPlaces 的语义是「整天按给定顺序走」，
  // 若把单点锁定塞进去，锁一个点会让那一天只剩这一个点。
  const lockedByDay = new Map<number, Place[]>();
  for (const locked of lockedPlaces) {
    const day = Math.round(locked.day);
    if (day < 1 || day > days) {
      warnings.push(
        `锁定的「${locked.place.name}」超出本次 ${days} 天的行程，已忽略。`,
      );
      continue;
    }
    if (locked.place.category === "hotel") continue;
    // 攻略日整日顺序已锁定，再叠加单点锁定没有意义。
    if (fixedDays.has(day)) continue;
    const list = lockedByDay.get(day) ?? [];
    if (!list.some((item) => samePlace(item, locked.place))) {
      list.push(locked.place);
      lockedByDay.set(day, list);
    }
  }
  const lockedIds = new Set<string>();
  for (const list of lockedByDay.values()) {
    for (const place of list) lockedIds.add(place.id);
  }

  // 「移除」不该被自动补位抵消：用户删掉几个点，当天就少排几个。
  const slimFor = (day: number) => {
    const raw = input.slimDays?.[day];
    if (!raw || !Number.isFinite(raw)) return 0;
    return Math.max(0, Math.min(4, Math.round(raw)));
  };

  const baseSights = dedupePlaces(input.sights).filter(
    (place) =>
      !["food", "cafe", "hotel", "other"].includes(place.category) &&
      !fixedIds.has(place.id) &&
      !lockedIds.has(place.id),
  );

  const scored: ScoredPlace[] = baseSights
    .map((place) => ({
      place,
      score: scorePlace(
        place,
        hotel,
        styles,
        seed,
        input.radiusKm,
        transport,
        city,
      ),
      distance: placeDistance(hotel, place),
    }))
    .filter((item) => Number.isFinite(item.place.lat) && Number.isFinite(item.place.lng))
    .sort((a, b) => b.score - a.score);

  const capacity = PACES[pace].sights;
  const nearKm = input.radiusKm;
  const farKm = farLimitKm(styles);

  const nearCandidates = scored.filter((item) => item.distance <= nearKm);
  const farCandidates = scored.filter(
    (item) =>
      item.distance > nearKm &&
      item.distance <= farKm &&
      estimateModeMinutes(hotel, item.place, "taxi") <= FAR_MAX_ONE_WAY_MIN,
  );
  const farAnchors = farCandidates.filter((item) => isFamous(item.place));

  // 用户手动指定远足日时，把“同城外围、车程够远”的著名点位也纳入锚点，
  // 例如住在市中心却想专程去另一片城区的集美学村，而不是凑数的近郊点位。
  const fringeFloorKm = Math.max(8, nearKm * 0.55);
  const fringeCandidates =
    input.farDays !== undefined && input.farDays > 0
      ? scored.filter(
          (item) =>
            item.distance > fringeFloorKm &&
            item.distance <= nearKm &&
            estimateModeMinutes(hotel, item.place, "taxi") >= 22,
        )
      : [];
  const farPool = [...farCandidates, ...fringeCandidates];

  let farCount = decideFarDays(
    input.farDays,
    autoDays.length,
    capacity,
    farCandidates,
    farAnchors,
  );
  const farGroups =
    farCount > 0
      ? pickFarGroups(
          farPool,
          farCount,
          capacity,
          hotel,
          seed,
          city,
          styles,
        )
      : [];
  farCount = farGroups.length;

  if (
    input.farDays !== undefined &&
    input.farDays > 0 &&
    farCount < input.farDays
  ) {
    if (farPool.length === 0) {
      warnings.push("酒店远一些的方向没有找到合适点位，这次先按就近安排。");
    } else if (autoDays.length <= 1) {
      warnings.push("整趟只有 1 天，先把一个远足日走扎实，其余留给下次。");
    } else {
      warnings.push(`远足只排出了 ${farCount} 天，其余日期先就近安排。`);
    }
  }

  if (farGroups.some((group) => group[0] && !isFamous(group[0].place))) {
    warnings.push("较远方向特别出名的景点不多，远足日已按口碑挑了几处顺路的点位。");
  }

  const farIds = new Set<string>();
  for (const group of farGroups) {
    for (const item of group) farIds.add(item.place.id);
  }

  const dayPlaces = new Map<number, Place[]>();
  const farDaysSet = new Set<number>();
  const anchorByDay = new Map<number, string[]>();

  const farStart = Math.max(
    0,
    Math.round((autoDays.length - farCount) / 2),
  );
  const farPositions = new Set<number>();
  for (let index = 0; index < farCount; index++) {
    farPositions.add(farStart + index);
  }
  const nearPositions = autoDays
    .map((_, index) => index)
    .filter((index) => !farPositions.has(index));

  [...farPositions].forEach((position, index) => {
    const group = farGroups[index];
    const day = autoDays[position];
    if (!group || day === undefined) return;
    dayPlaces.set(day, group.map((item) => item.place));
    farDaysSet.add(day);
    anchorByDay.set(day, [group[0].place.id]);
  });

  if (nearPositions.length > 0) {
    let nearPool = nearCandidates.filter((item) => !farIds.has(item.place.id));
    const need = nearPositions.length * capacity + 2;
    if (nearPool.length < need) {
      const widened = scored.filter(
        (item) =>
          item.distance <= Math.min(farKm, nearKm * 1.6) &&
          !farIds.has(item.place.id),
      );
      if (widened.length > nearPool.length) {
        nearPool = widened;
        warnings.push("酒店周边可选的景点不多，已把搜索范围放宽到更远一些。");
      }
    }

    const clusterRadius = clusterRadiusFor(styles, pace, transport);
    const anchors = pickNearAnchors(
      nearPool,
      nearPositions.length,
      clusterRadius,
      city,
      hotel,
      styles,
    );
    const anchorProfiles = anchors.map((item) =>
      rhythmOf(city, item.place),
    );
    const dayBuckets = anchors.map(() => [] as ScoredPlace[]);
    const chosenIds = new Set(anchors.map((item) => item.place.id));
    const perDayLimit = Math.max(1, capacity - 1);
    const bucketRoles = anchorProfiles.map((profile) => roleCount([profile]));
    const dayLimitFor = (index: number) => {
      const day = autoDays[nearPositions[index]];
      const edge = days >= 3 && (day === 1 || day === days);
      const roles = bucketRoles[index];
      const closesLate = (roles.sunset ?? 0) > 0 || (roles.night ?? 0) > 0;
      // 傍晚/夜市收尾的日子多留一个白天的支撑位，避免午后空一大段。
      return Math.max(1, perDayLimit - (edge ? 1 : 0) + (closesLate ? 1 : 0));
    };
    const dayBudgetFor = (index: number) => {
      const day = autoDays[nearPositions[index]];
      const edge = days >= 3 && (day === 1 || day === days);
      // 有日落/夜市收尾的日子本来就玩到晚上，多给一个支撑位的时长，
      // 否则中午到傍晚会空出一大段，行程看着“又远又不好玩”。
      const closingBonus =
        (anchorProfiles[index]?.sunset || anchorProfiles[index]?.nightStreet)
          ? 90
          : 0;
      return (
        PACES[pace].sights * 80 * (edge ? 0.88 : 1) + closingBonus
      );
    };
    const usedMinutes = anchors.map((item) =>
      rhythmBudgetMinutes(city, item.place),
    );
    const assignable = nearPool
      .filter((item) => !chosenIds.has(item.place.id))
      .slice()
      .sort((a, b) => b.score - a.score);

    for (const item of assignable) {
      const profile = rhythmOf(city, item.place);
      const duration = rhythmBudgetMinutes(city, item.place);
      let bestIndex = -1;
      let bestValue = -Infinity;
      for (let index = 0; index < anchors.length; index++) {
        if (dayBuckets[index].length >= dayLimitFor(index)) continue;
        if (!canCluster(anchors[index].place, item.place, clusterRadius)) continue;
        if (profile.quickStop && (bucketRoles[index].quick ?? 0) >= 1) continue;
        if (usedMinutes[index] + duration > dayBudgetFor(index)) continue;
        const roles = bucketRoles[index];
        const dayOpensEarly =
          (roles.market ?? 0) > 0 || (roles.sunrise ?? 0) > 0;
        const dayEndsEvening =
          (roles.sunset ?? 0) > 0 || (roles.night ?? 0) > 0;
        if (profile.sunset && dayOpensEarly) continue;
        // 早市和日落/夜市排在同一天，排程会在午后留下大段空档；
        // 除非用户手动固定，否则宁可把早市留给白天日。
        if (profile.marketMorning && dayEndsEvening) continue;
        if (
          (profile.marketMorning || profile.sunrise) &&
          (roles.sunset ?? 0) > 0
        ) {
          continue;
        }
        const km = placeDistance(anchors[index].place, item.place);
        let value =
          item.score -
          km * 0.3 -
          (dayBuckets[index].length / Math.max(1, dayLimitFor(index))) * 1.7;
        if (transport !== "drive") {
          const line = sharedMetroLine(anchors[index].place, item.place, city);
          if (line) value += 0.35;
        }
        const lateOnly =
          !profile.sunset &&
          !profile.nightStreet &&
          profile.windows.length > 0 &&
          profile.windows.every(([start]) => start >= 14 * 60);
        // 上午型点位优先去白天日，下午型点位优先接日落/夜市日：
        // 用软偏好代替硬隔离，避免把南普陀这类大点直接挤掉。
        if (profile.morningOnly) value += dayEndsEvening ? -0.9 : 0.35;
        if (lateOnly) value += dayEndsEvening ? 0.55 : -0.25;
        if (profile.quickStop) value -= 2.8;
        if (!profile.heroEligible) value -= 0.7;
        if (profile.sunset) {
          value += roles.sunset
            ? styles.includes("coastal")
              ? -1.1
              : -2.6
            : 0.55;
        }
        if (profile.sunrise) {
          value += roles.sunrise ? -3 : 0.35;
          if (sunTooFar(item.place, hotel)) value -= 2.5;
        }
        if (profile.indoor) value += roles.indoor ? -0.8 : 0.4;
        if (profile.marketMorning) value += roles.market ? -1 : 0.35;
        if (profile.nightStreet) value += roles.night ? -0.8 : 0.3;
        if (!roles.morning && profile.bands.includes("morning")) {
          value += 0.5;
        }
        if (value > bestValue) {
          bestValue = value;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0) {
        dayBuckets[bestIndex].push(item);
        chosenIds.add(item.place.id);
        usedMinutes[bestIndex] += duration;
        for (const role of rhythmRoles(profile)) {
          bucketRoles[bestIndex][role] =
            (bucketRoles[bestIndex][role] ?? 0) + 1;
        }
      }
    }

    nearPositions.forEach((position, index) => {
      const day = autoDays[position];
      const anchor = anchors[index];
      if (!anchor) {
        dayPlaces.set(day, []);
        return;
      }
      dayPlaces.set(day, [
        anchor.place,
        ...dayBuckets[index].map((item) => item.place),
      ]);
    });

    // 孤立的锚点用最近的高分点位补齐，至少凑成半天的路线。
    nearPositions.forEach((position, index) => {
      const day = autoDays[position];
      const picked = dayPlaces.get(day) ?? [];
      if (picked.length >= 2) return;
      const anchor = anchors[index];
      const spare = nearPool
        .filter((item) => !chosenIds.has(item.place.id))
        .filter((item) => {
          if (!anchor) return item.distance <= nearKm;
          if (canCluster(anchor.place, item.place, clusterRadius * 1.7)) {
            return true;
          }
          return (
            !anchor.place.island &&
            !item.place.island &&
            item.distance <= nearKm * 1.2
          );
        })
        .sort((a, b) => {
          const da = anchor ? placeDistance(anchor.place, a.place) : a.distance;
          const db = anchor ? placeDistance(anchor.place, b.place) : b.distance;
          return b.score - db * 0.5 - (a.score - da * 0.5);
        });
      for (let i = 0; i < spare.length && picked.length < 2; i++) {
        const candidate = spare[i];
        if (picked.some((place) => place.id === candidate.place.id)) continue;
        const candidateProfile = rhythmOf(city, candidate.place);
        const pickedRoles = roleCount(
          picked.map((place) => rhythmOf(city, place)),
        );
        const opensEarly =
          (pickedRoles.market ?? 0) > 0 || (pickedRoles.sunrise ?? 0) > 0;
        if (candidateProfile.sunset && opensEarly) continue;
        if (
          (candidateProfile.marketMorning || candidateProfile.sunrise) &&
          (pickedRoles.sunset ?? 0) > 0
        ) {
          continue;
        }
        picked.push(candidate.place);
        chosenIds.add(candidate.place.id);
      }
      dayPlaces.set(day, picked);
    });

    for (const position of nearPositions) {
      const day = autoDays[position];
      const picked = dayPlaces.get(day) ?? [];
      if (!picked.length) {
        warnings.push(`第 ${day} 天附近可选地点不足，留作自由活动或临时加点多好。`);
      }
    }
    if (nearPool.length < need) {
      warnings.push("这个城市的点位偏少，部分日期会安排得更松一些。");
    }
  }

  // 把锁定的点位放到当天队列最前面：composeDay 若因时间不够删减，
  // 删的是队尾的自动点位，锁定的点不会被顺手丢掉。
  for (const [day, places] of lockedByDay) {
    const current = dayPlaces.get(day) ?? [];
    const merged = [...places];
    for (const place of current) {
      if (!merged.some((item) => samePlace(item, place))) merged.push(place);
    }
    dayPlaces.set(day, merged);
    if (merged.length > capacity + places.length) {
      warnings.push(
        `第 ${day} 天锁定了 ${places.length} 个点位，当天会比较满，想轻松点可以解除一两个。`,
      );
    }
  }

  // 「移除」的最终收口：上面的「至少凑 2 站」「补齐空荡的一天」等兜底
  // 会无视用户意图把人删掉的量补回来，这里按天统一削掉。
  // 锁定点位在合并时已放在队首，因此截尾不会误伤它们。
  for (const [day, places] of dayPlaces) {
    const slim = slimFor(day);
    if (!slim) continue;
    const lockedCount = (lockedByDay.get(day) ?? []).length;
    const keep = Math.max(lockedCount || 1, places.length - slim);
    if (keep < places.length) {
      dayPlaces.set(day, places.slice(0, keep));
    }
  }

  const result: DaySeed[] = [];
  for (let day = 1; day <= days; day++) {
    const fixedPlacesForDay = fixedByDay.get(day);
    if (fixedPlacesForDay && fixedPlacesForDay.length) {
      const ordered = fixedPlacesForDay.slice(0, 12);
      if (fixedPlacesForDay.length > 12) {
        warnings.push(`第 ${day} 天的攻略点位较多，仅保留前 12 个，其余建议拆到另一天。`);
      }
      if (ordered.length < 2) {
        warnings.push(`第 ${day} 天只识别到 1 个攻略点位，路线会比较短。`);
      }
      result.push({
        index: day,
        places: ordered,
        fixed: true,
        area: describeArea(ordered, hotel),
        theme: describeTheme(ordered, seed, day),
      });
      continue;
    }
    const picked = dayPlaces.get(day) ?? [];
    const far = farDaysSet.has(day);
    const anchorId = anchorByDay.get(day)?.[0];
    const anchor = anchorId
      ? picked.find((place) => place.id === anchorId) ?? picked[0]
      : undefined;
    let oneWay = 0;
    if (far && anchor) {
      const ferryExtra =
        anchor.island && anchor.island !== hotel.island ? 30 : 0;
      oneWay = estimateModeMinutes(hotel, anchor, "taxi") + ferryExtra;
      const dir = directionLabel(
        bearing([hotel.lng, hotel.lat], [anchor.lng, anchor.lat]),
      );
      warnings.push(
        `第 ${day} 天是远足日：往${dir}方向，单程约 ${oneWay} 分钟，${
          oneWay >= 60 ? "早点出发更从容。" : "按这条线走不用来回折返。"
        }`,
      );
    }
    const composed = picked.length
      ? composeDay({
          places: picked,
          hotel,
          city,
          pace,
          styles,
          transport,
          dayIndex: day,
          anchorId,
          baseStart:
            PACES[pace].startMin - (far && oneWay >= 60 ? 30 : 0),
          seed,
        })
      : null;
    if (composed?.warnings.length) warnings.push(...composed.warnings);
    result.push({
      index: day,
      places: composed?.places ?? picked,
      fixed: false,
      area: far ? `远足 · ${describeArea(picked, hotel)}` : describeArea(picked, hotel),
      theme: describeTheme(picked, seed, day),
      far,
      anchorIds: composed?.protectedIds.length
        ? composed.protectedIds
        : anchorByDay.get(day),
      startMinHint: composed?.startMinHint,
    });
  }

  return {
    days: result,
    warnings: Array.from(new Set(warnings)),
    farDays: farDaysSet.size,
  };
}
