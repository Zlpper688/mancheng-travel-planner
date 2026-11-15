import { PACES } from "../constants";
import {
  angleDistance,
  bearing,
  clamp,
  directionLabel,
  estimateModeMinutes,
  haversine,
  meanPoint,
  placeDistance,
  seededJitter,
} from "../geo";
import { dedupePlaces } from "../providers/normalize";
import type {
  Category,
  FixedPlace,
  PaceId,
  Place,
  StyleId,
} from "../types";

export interface DaySeed {
  index: number;
  places: Place[];
  fixed: boolean;
  area: string;
  theme: string;
  far?: boolean;
  anchorIds?: string[];
}

export interface SelectInput {
  sights: Place[];
  hotel: Place;
  days: number;
  pace: PaceId;
  styles: StyleId[];
  seed: number;
  radiusKm: number;
  fixedPlaces?: FixedPlace[];
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
): number {
  const affinity = styleAffinity(place, styles);
  const popularity = place.popularity ?? 3.4;
  const distance = placeDistance(hotel, place);
  const reach = 0.9 - clamp(distance / Math.max(5, radiusKm * 1.45), 0, 1) * 0.72;
  const islandPenalty =
    place.island && place.island !== hotel.island ? 0.5 : 0;
  const ratingBonus = place.rating && place.rating >= 4.6 ? 0.25 : 0;
  const fameWeight = styles.includes("classic") ? 5 : 3.4;
  const fameBonus = Math.max(0, popularity - 4.1) * fameWeight;
  const jitter = seededJitter(seed, place.id, 0.85);
  return (
    affinity * 2.1 +
    popularity * 1.2 +
    fameBonus +
    reach +
    ratingBonus +
    jitter -
    islandPenalty
  );
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
): ScoredPlace[][] {
  const remaining = [...pool].sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const groups: ScoredPlace[][] = [];
  let previousDir: number | null = null;

  for (let day = 0; day < count; day++) {
    const candidates = remaining.filter((item) => !used.has(item.place.id));
    if (!candidates.length) break;
    const famous = candidates.filter((item) => isFamous(item.place));
    const anchorPool = famous.length ? famous : candidates;
    let bestAnchor: ScoredPlace | null = null;
    let bestValue = -Infinity;
    for (const item of anchorPool.slice(0, 36)) {
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
      if (value > bestValue) {
        bestValue = value;
        bestAnchor = item;
      }
    }
    if (!bestAnchor) break;
    const anchor = bestAnchor;
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
    for (const entry of nearby) {
      if (group.length >= groupCap) break;
      group.push(entry.item);
      used.add(entry.item.place.id);
    }
    groups.push(group);
    previousDir = bearing(
      [hotel.lng, hotel.lat],
      [anchor.place.lng, anchor.place.lat],
    );
  }
  return groups;
}

function normalizeAngle(value: number): number {
  return ((value % 360) + 360) % 360;
}

function destinationPoint(
  from: [number, number],
  angleDeg: number,
  km: number,
): [number, number] {
  const radius = 6371;
  const delta = km / radius;
  const theta = (angleDeg * Math.PI) / 180;
  const phi1 = (from[1] * Math.PI) / 180;
  const lambda1 = (from[0] * Math.PI) / 180;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) +
      Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return [(lambda2 * 180) / Math.PI, (phi2 * 180) / Math.PI];
}

type ScoredPlace = { place: Place; score: number; distance: number };

function assignSectors(
  places: ScoredPlace[],
  hotel: Place,
  count: number,
  offset: number,
): ScoredPlace[][] {
  const span = 360 / count;
  const buckets: ScoredPlace[][] = Array.from({ length: count }, () => []);
  const origin: [number, number] = [hotel.lng, hotel.lat];
  for (const item of places) {
    const angle = normalizeAngle(
      bearing(origin, [item.place.lng, item.place.lat]) - offset,
    );
    const index = Math.min(count - 1, Math.floor(angle / span));
    buckets[index].push(item);
  }
  return buckets;
}

function sectorScore(
  buckets: ScoredPlace[][],
  pace: PaceId,
  hotel: Place,
): number {
  const need = PACES[pace].sights;
  let total = 0;
  for (const bucket of buckets) {
    const sorted = [...bucket].sort((a, b) => b.score - a.score);
    total += sorted
      .slice(0, need)
      .reduce((sum, item) => sum + item.score, 0);
    if (bucket.length < 2) total -= (2 - bucket.length) * 6;
    const islands = new Set(bucket.map((item) => item.place.island ?? ""));
    if (!hotel.island && islands.size > 1) total -= 2.2;
    if (bucket.length > 1) {
      const center = meanPoint(
        bucket.map((item) => [item.place.lng, item.place.lat]),
      );
      const spread =
        bucket.reduce(
          (sum, item) =>
            sum + haversine(center, [item.place.lng, item.place.lat]),
          0,
        ) / bucket.length;
      if (spread > 6) total -= (spread - 6) * 0.35;
    }
  }
  return total;
}

function legCost(a: Place, b: Place): number {
  const crossing =
    Boolean(a.island || b.island) && a.island !== b.island ? 5.5 : 0;
  return placeDistance(a, b) + crossing;
}

function twoOpt(
  tour: Place[],
  cost: (a: Place, b: Place) => number,
): Place[] {
  const route = [...tour];
  let improved = true;
  let guard = 0;
  const n = route.length;
  while (improved && guard < 8) {
    improved = false;
    guard++;
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const before = cost(route[i - 1], route[i]) + cost(route[j], route[j + 1]);
        const after = cost(route[i - 1], route[j]) + cost(route[i], route[j + 1]);
        if (after + 0.002 < before) {
          let left = i;
          let right = j;
          while (left < right) {
            const temp = route[left];
            route[left] = route[right];
            route[right] = temp;
            left++;
            right--;
          }
          improved = true;
        }
      }
    }
  }
  return route;
}

function orderLoop(
  places: Place[],
  hotel: Place,
  seed: number,
  dayIndex: number,
): Place[] {
  if (places.length <= 2) {
    return seededJitter(seed, `flip-${dayIndex}`, 1) > 0
      ? [...places].reverse()
      : places;
  }
  const remaining = [...places];
  const ordered: Place[] = [];
  let current = hotel;
  while (remaining.length) {
    let bestIndex = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cost = legCost(current, remaining[i]);
      if (cost < bestCost) {
        bestCost = cost;
        bestIndex = i;
      }
    }
    const next = remaining.splice(bestIndex, 1)[0];
    ordered.push(next);
    current = next;
  }
  const tour = [hotel, ...ordered, hotel];
  const improved = twoOpt(tour, legCost);
  const result = improved.slice(1, -1);
  if (seededJitter(seed, `flip-${dayIndex}`, 1) > 0.1) result.reverse();
  return result;
}

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
  const { hotel, days, pace, styles, seed, fixedPlaces = [] } = input;
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

  const baseSights = dedupePlaces(input.sights).filter(
    (place) =>
      !["food", "cafe", "hotel", "other"].includes(place.category) &&
      !fixedIds.has(place.id),
  );

  const scored: ScoredPlace[] = baseSights
    .map((place) => ({
      place,
      score: scorePlace(place, hotel, styles, seed, input.radiusKm),
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

    const span = 360 / nearPositions.length;
    let bestBuckets: ScoredPlace[][] | null = null;
    let bestScore = -Infinity;
    const phase = seededJitter(seed, "sector-rotation", span / 2);
    for (let step = 0; step < 12; step++) {
      const offset = normalizeAngle(phase + (step * span) / 12);
      const buckets = assignSectors(
        nearPool,
        hotel,
        nearPositions.length,
        offset,
      );
      const value = sectorScore(buckets, pace, hotel);
      if (value > bestScore) {
        bestScore = value;
        bestBuckets = buckets;
      }
    }
    const buckets = bestBuckets ?? [];
    const chosenIds = new Set<string>();

    nearPositions.forEach((position, bucketIndex) => {
      const day = autoDays[position];
      const bucket = (buckets[bucketIndex] ?? []).slice().sort((a, b) => b.score - a.score);
      const picked = bucket.slice(0, capacity).map((item) => item.place);
      picked.forEach((place) => chosenIds.add(place.id));
      dayPlaces.set(day, picked);
    });

    // 景点稀疏的方向，从邻近的剩余点位补齐，避免出现空荡的一天。
    nearPositions.forEach((position, bucketIndex) => {
      const day = autoDays[position];
      const picked = dayPlaces.get(day) ?? [];
      if (picked.length >= 2) return;
      const sectorCenter = destinationPoint(
        [hotel.lng, hotel.lat],
        normalizeAngle(phase + ((bucketIndex + 0.5) * span)),
        3,
      );
      const spare = nearPool
        .filter((item) => !chosenIds.has(item.place.id))
        .sort((a, b) => {
          const da = haversine(sectorCenter, [a.place.lng, a.place.lat]);
          const db = haversine(sectorCenter, [b.place.lng, b.place.lat]);
          return b.score - db * 0.5 - (a.score - da * 0.5);
        });
      for (let i = 0; i < spare.length && picked.length < 2; i++) {
        const candidate = spare[i];
        if (candidate.distance > nearKm * 1.8) continue;
        if (picked.some((place) => placeDistance(place, candidate.place) < 0.3)) continue;
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
    if (far && anchor) {
      const ferryExtra =
        anchor.island && anchor.island !== hotel.island ? 30 : 0;
      const oneWay = estimateModeMinutes(hotel, anchor, "taxi") + ferryExtra;
      const dir = directionLabel(
        bearing([hotel.lng, hotel.lat], [anchor.lng, anchor.lat]),
      );
      warnings.push(
        `第 ${day} 天是远足日：往${dir}方向，单程约 ${oneWay} 分钟，${
          oneWay >= 60 ? "早点出发更从容。" : "按这条线走不用来回折返。"
        }`,
      );
    }
    result.push({
      index: day,
      places: orderLoop(picked, hotel, seed, day),
      fixed: false,
      area: far ? `远足 · ${describeArea(picked, hotel)}` : describeArea(picked, hotel),
      theme: describeTheme(picked, seed, day),
      far,
      anchorIds: anchorByDay.get(day),
    });
  }

  return {
    days: result,
    warnings: Array.from(new Set(warnings)),
    farDays: farDaysSet.size,
  };
}
