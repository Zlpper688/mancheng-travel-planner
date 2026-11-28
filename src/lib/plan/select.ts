import { PACES } from "../constants";
import {
  bearing,
  directionLabel,
  estimateModeMinutes,
  placeDistance,
  seededJitter,
} from "../geo";
import { cleanNameForMatch, dedupePlaces } from "../providers/normalize";
import { metroAccess, sharedMetroLine } from "../transit/metro";
import { cityHasSea } from "../water";
import type {
  Category,
  ExperienceId,
  FixedPlace,
  PaceId,
  Place,
  StyleId,
  TransportPref,
} from "../types";
import { buildWishlist, experienceAffinity } from "./experience";
import { DEFAULT_PARAMS, type PlanParams } from "./params";
import {
  NEUTRAL_PREFS,
  prefContextOf,
  prefsDelta,
  prestigeScale,
  type TripVector,
} from "./prefs";
import {
  composeDay,
  rhythmBudgetMinutes,
  rhythmOf,
  type RhythmProfile,
} from "./rhythm";
import { dayMinuteBudget, dayStopLimit, isDepartureDay } from "./policy";
import {
  decideFarDays,
  farLimitKm,
  farReachKm,
  farValueFloor,
  pickFarGroups,
} from "./select/far";
import { describeArea, describeTheme } from "./select/narrative";
import { balanceDays } from "./select/balance";
import { dedupeAcrossDays } from "./select/crossday";
import {
  closingOnly,
  farOneWayCapFor,
  isFamous,
  sunTooFar,
  type ScoredPlace,
} from "./select/shared";
import { avoidSteepFor, steepnessOf } from "./strenuous";

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
  /**
   * 城市中心。住处未定时用它做「近处 / 远郊」的划分基准——
   * 拿一个推荐片区当圆心，会把城市另一侧的招牌景点直接判成「远郊」甚至排除。
   */
  center?: [number, number];
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
  fixedSource?: "guide" | "selected" | "mixed";
  farDays?: number;
  farCap?: number;
  experiences?: ExperienceId[];
  seniors?: number;
  avoidSteep?: boolean;
  notes?: string;
  /** 软参数覆盖层；不传时与现有行为完全一致。 */
  params?: PlanParams;
  /**
   * 连续偏好向量。中性（不传）时对打分零影响；
   * 传了才会把「愿不愿意走 / 怕不怕人多 / 要不要出片」这类程度带进选点。
   */
  prefs?: TripVector;
  /**
   * 回归检查专用：把打分表一并返回，用来断言「偏好确实改变了排序」。
   * 生产路径不要打开——它只是把已经算出来的数组多带一份。
   */
  debug?: boolean;
  /** 片区聚类半径覆盖（km）：区域环线段内选点时放大，避免跨 100km 的点被当成不同片区。 */
  clusterRadiusKm?: number;
}

export interface SelectResult {
  days: DaySeed[];
  warnings: string[];
  farDays: number;
  /** 仅 debug=true 时有值：按综合分降序的选点打分表。 */
  scored?: { id: string; name: string; popularity: number; score: number }[];
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
    categories: {
      attraction: 1.6,
      viewpoint: 1.3,
      museum: 1,
      temple: 1,
      nature: 0.7,
      street: 0.7,
      park: 0.5,
    },
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
  wanted: ExperienceId[],
  goalBoost: Map<string, number>,
  seniors = 0,
  avoidSteep = false,
  coastal = false,
  prefs: TripVector = NEUTRAL_PREFS,
): number {
  const affinity = styleAffinity(place, styles);
  const wishBonus =
    experienceAffinity(city, place, wanted, coastal) +
    (goalBoost.get(place.id) ?? 0);
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
  // 「名气」这一项值多少分，由偏好决定：想小众就压到 0.44，想打卡就抬到 1.56。
  // 中性偏好下恰为 1，选点结果与旧行为逐字节一致。
  const prestige = prestigeScale(prefs);
  const fameBonus = Math.max(0, popularity - 4.1) * fameWeight * prestige;
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
  const steep = steepnessOf(city, place);
  // 爬山惩罚只对“老人同行”或“明确不爬山”生效；
  // 普通游客来驻马店就是为了嵖岈山，不能把核心爬山点一律压下去。
  const seniorPenalty = steep
    ? avoidSteep
      ? steep === "core"
        ? 9
        : 2.4
      : seniors > 0
        ? steep === "core"
          ? 4.5
          : 1.6
        : 0
    : 0;
  const jitter = seededJitter(seed, place.id, 0.28);
  // 连续偏好（愿不愿意走 / 怕不怕人多 / 要不要出片）。
  // 中性向量下这个值恒等于 0，所以「不传 prefs」与旧行为逐字节一致。
  const prefBonus = prefsDelta(prefs, prefContextOf(place, { steep }));
  return (
    affinity * 1 +
    popularity * 2 * prestige +
    fameBonus +
    mustSee +
    metroBonus +
    ratingBonus +
    jitter +
    wishBonus +
    prefBonus -
    qualityPenalty -
    reachPenalty -
    islandPenalty -
    seniorPenalty
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
  seniors = 0,
): number {
  let radius = 4.4;
  if (transport === "drive") radius += 0.8;
  if (styles.includes("family")) radius -= 0.6;
  if (styles.includes("citywalk")) radius -= 0.3;
  if (pace === "chill") radius -= 0.3;
  if (seniors > 0) radius -= 0.4;
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


/**
 * 「必去点」的排序：名气为主，但用户明确表过态之后，让综合分参与。
 *
 * 为什么非改这一步不可：名气够高的点会被直接选为当天主景，而主景决定了
 * 这一整天往哪个片区走。如果这里只按名气压人，那「我偏小众」最多只能换掉
 * 主景身边的点缀，整条行程的骨架纹丝不动——实测厦门 40 个点位，novelty
 * 从 0.05 拉到 0.95，两天排出来的东西一个点都没变。
 *
 * 中性偏好时 blend = 0，排序键退化为「名气降序 → 综合分降序」，
 * 与改动前逐字节一致（引擎的通用纪律：默认值必须等于原硬编码）。
 */
function fameOrder(pool: ScoredPlace[], prefs: TripVector): ScoredPlace[] {
  const blend = Math.min(0.65, Math.abs(prefs.novelty - 0.5) * 1.3);
  const byFame = (a: ScoredPlace, b: ScoredPlace) =>
    (b.place.popularity ?? 0) - (a.place.popularity ?? 0) || b.score - a.score;
  if (blend <= 0) return [...pool].sort(byFame);
  // 先各自归一化再加权：名气是 3.4~5.0，综合分是 5~16，两个量纲直接相加
  // 等于让综合分一票否决，那不是「参与」，是「取代」。
  const pops = pool.map((item) => item.place.popularity ?? 0);
  const scores = pool.map((item) => item.score);
  const popLo = Math.min(...pops);
  const popHi = Math.max(...pops);
  const scoreLo = Math.min(...scores);
  const scoreHi = Math.max(...scores);
  const unit = (value: number, lo: number, hi: number) =>
    hi - lo < 1e-9 ? 0.5 : (value - lo) / (hi - lo);
  const keyOf = (item: ScoredPlace) =>
    (1 - blend) * unit(item.place.popularity ?? 0, popLo, popHi) +
    blend * unit(item.score, scoreLo, scoreHi);
  return [...pool].sort((a, b) => keyOf(b) - keyOf(a) || byFame(a, b));
}

/**
 * 只在下午到夜里才进得去：日落点、夜市、以及窗口全在 13 点以后的街区。
 *
 * 这种点位不该当一天的主景。主景是一天一个，把「看日落」当天的主景，
 * 等于给这天只发了半天门票——排程最早的可用时段就是 16:00，
 * 只能把出发时间推到下午（实测厦门第 2 天 14:30 才出门，上午整块空着）。
 * 它正确的角色是白天日最后的那一站，也就是「收尾」。
 */
function eveningOnly(profile: RhythmProfile): boolean {
  if (profile.sunrise || profile.marketMorning) return false;
  if (!profile.windows.length) return false;
  return Math.min(...profile.windows.map(([start]) => start)) >= 12 * 60 + 30;
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
  prefs: TripVector = NEUTRAL_PREFS,
): ScoredPlace[] {
  const anchors: ScoredPlace[] = [];
  const profileOf = (item: ScoredPlace) => rhythmOf(city, item.place);
  const mandatory = fameOrder(pool, prefs);
  // 白天能进的点位够分给这几天时，傍晚型就不占锚点，退回顺路收尾。
  // 反过来（海边小城，全城只有日落点）仍然允许它当主景，否则一天锚点都选不出来。
  const daytimeAnchors = pool.filter((item) => !eveningOnly(profileOf(item))).length;
  const allowEveningAnchor = daytimeAnchors < count;
  // 「必去」门票只发给名气 4.4 以上的点。这个门槛平时是对的——第一次来就该去鼓浪屿。
  // 但用户把 novelty 压到 0.2 以下，说的其实是「我不是第一次来了」，
  // 这时候综合分排在前面的点也该有资格当主景，否则偏好永远只能换配角。
  // 只在明确表态时开这个口子；中性偏好下 wildcard 为空，行为与旧版一致。
  const wildcard =
    0.5 - prefs.novelty >= 0.3
      ? new Set(
          mandatory.slice(0, Math.max(3, count * 2 + 1)).map((item) => item.place.id),
        )
      : null;
  for (const item of mandatory) {
    if (anchors.length >= count) break;
    if (!isMandatoryAnchor(item.place) && !wildcard?.has(item.place.id)) continue;
    if (anchors.some((anchor) => anchor.place.id === item.place.id)) continue;
    const profile = profileOf(item);
    if (!allowEveningAnchor && eveningOnly(profile)) continue;
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
      if (anchors.some((anchor) => anchor.place.id === item.place.id)) continue;
      const profile = profileOf(item);
      if (!allowEveningAnchor && eveningOnly(profile)) continue;
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
    params = DEFAULT_PARAMS,
  } = input;
  const warnings: string[] = [];

  const fixedByDay = new Map<number, Place[]>();
  for (const fixed of fixedPlaces) {
    const day = Math.round(fixed.day);
    if (day < 1 || day > days) {
      warnings.push(`固定点位里第 ${day} 天的「${fixed.place.name}」超出本次 ${days} 天的行程，已忽略。`);
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
    // 餐饮/咖啡由排线阶段按时间轴插入，锁进景点队列会变成「一顿饭当景点逛」。
    if (["food", "cafe", "hotel", "other"].includes(locked.place.category)) {
      continue;
    }
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

  const skipSteep = avoidSteepFor({
    avoidSteep: input.avoidSteep,
    seniors: input.seniors,
    notes: input.notes,
  });

  const seenSightNames = new Set<string>();
  const baseSights = dedupePlaces(input.sights).filter((place) => {
    if (["food", "cafe", "hotel", "other"].includes(place.category)) return false;
    if (fixedIds.has(place.id)) return false;
    if (lockedIds.has(place.id)) return false;
    if (skipSteep && steepnessOf(city, place) === "core") return false;
    // OSM 常把同一景点录成节点和面两个 ID，坐标差几公里时 dedupePlaces 兜不住；
    // 同名只保留排行榜里靠前的一个，避免同一天逛两遍“观景平台”。
    const nameKey = cleanNameForMatch(place.name);
    if (nameKey && seenSightNames.has(nameKey)) return false;
    seenSightNames.add(nameKey);
    return true;
  });

  const wanted = input.experiences ?? [];
  const coastal = cityHasSea(city, baseSights);
  const goalBoost = new Map<string, number>();
  if (wanted.length) {
    for (const goal of buildWishlist(city, baseSights, 14)) {
      if (skipSteep && goal.experience === "hike") continue;
      if (wanted.includes(goal.experience)) {
        goalBoost.set(goal.placeId, 2.2);
      }
    }
  }

  // 近处 / 远郊的划分基准：住处定了就以住处为圆心（用户真实约束），
  // 没定住处时改用城市中心——否则一个偏在城西的推荐片区，会把城东的招牌景点
  // 判成「远郊」，甚至因为超出半径直接排除。
  const reference: Place = input.center
    ? { ...hotel, lat: input.center[1], lng: input.center[0] }
    : hotel;

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
        wanted,
        goalBoost,
        input.seniors ?? 0,
        skipSteep,
        coastal,
        input.prefs,
      ),
      distance: placeDistance(reference, place),
    }))
    .filter((item) => Number.isFinite(item.place.lat) && Number.isFinite(item.place.lng))
    .sort((a, b) => b.score - a.score);

  const capacity = Math.max(1, params.sightsPerDay[pace][1] - 1);
  const nearKm = input.radiusKm;
  const farKm = farLimitKm(styles, params);

  const nearCandidates = scored.filter((item) => item.distance <= nearKm);
  const farCandidates = scored.filter(
    (item) =>
      item.distance > nearKm &&
      item.distance <= farReachKm(styles, item.place, params) &&
      estimateModeMinutes(reference, item.place, "taxi") <=
        farOneWayCapFor(input.days, item.place, params),
  );
  const farAnchors = farCandidates.filter((item) => isFamous(item.place));
  // 普通 OSM attraction 不能算“主城有真景点”：一个环岛、两棵树也会被标成 attraction，
  // 否则驻马店这种点位全在城外的城市永远不会升级远足日。
  // 4.15 的底分同样不算——博物馆默认分就能达标，黄山主城只剩展馆时会被误判为“近处够玩”。
  const nearStrong = nearCandidates.filter(
    (item) =>
      (item.place.popularity ?? 0) >= 4.4 || (item.place.rating ?? 0) >= 4.5,
  ).length;
  // 只看高分点会误判开放数据城市：OSM 没有高德那套评分，灵隐寺这类真景点
  // popularity 也就 4.0 上下，全城会被判成「城里没得玩」而被塞一个远足日。
  // 所以再数一遍城区里到底有多少个可玩点，两个条件都不满足才算稀疏。
  const nearSights = nearCandidates.filter(
    (item) => !["food", "cafe", "hotel", "other"].includes(item.place.category),
  ).length;

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

  // 3 天经典路线默认只给 1 个远足日；但像驻马店这样主城几乎没有真景点、
  // 名气全在城外的城市，再死守 1 天会把嵖岈山、南海禅寺整批丢掉。
  const sparseNear =
    nearStrong < autoDays.length && nearSights < autoDays.length * 3;
  // 慢节奏也要给稀疏城市留第二个远足方向：主城只有两座馆时，
  // 硬压成 1 个远足日只会把另一座名寺塞进“就近”日、变成长途折返。
  const farCap =
    sparseNear && input.farCap !== undefined
      ? Math.min(3, input.farCap + 1)
      : input.farCap;

  let farCount = decideFarDays(
    input.farDays,
    autoDays.length,
    capacity,
    farCandidates,
    farAnchors,
    farCap,
    nearStrong,
    sparseNear,
  );
  // 主城越够玩，远足日的门槛越高：见 farValueFloor 的三档说明。
  const valueFloor = farValueFloor(nearStrong, autoDays.length, sparseNear);
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
          valueFloor,
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
      // 主城点位不够时，近处日期也要能看到城外名寺、文化园这类点位；
      // 只在 1.6 倍半径内打转，像南海禅寺这种 30 km 外的真景点会被整批丢掉。
      const widened = scored.filter(
        (item) =>
          item.distance <= Math.min(farKm, nearKm * 2.4) &&
          !farIds.has(item.place.id),
      );
      if (widened.length > nearPool.length) {
        nearPool = widened;
        warnings.push("酒店周边可选的景点不多，已把搜索范围放宽到更远一些。");
      }
    }

    const clusterRadius =
      input.clusterRadiusKm ??
      clusterRadiusFor(styles, pace, transport, input.seniors ?? 0);
    const anchors = pickNearAnchors(
      nearPool,
      nearPositions.length,
      clusterRadius,
      city,
      hotel,
      styles,
      input.prefs,
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
      const roles = bucketRoles[index];
      return dayStopLimit({
        perDayLimit,
        edge: isDepartureDay(days, day),
        closesLate: (roles.sunset ?? 0) > 0 || (roles.night ?? 0) > 0,
      });
    };
    const dayBudgetFor = (index: number) => {
      const day = autoDays[nearPositions[index]];
      const closingBonus =
        (anchorProfiles[index]?.sunset || anchorProfiles[index]?.nightStreet)
          ? 90
          : 0;
      return dayMinuteBudget({
        sights: capacity,
        edge: isDepartureDay(days, day),
        closingBonus,
      });
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
            item.distance <= nearKm * 1.2 &&
            placeDistance(anchor.place, item.place) <=
              Math.max(8, clusterRadius * 1.8)
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

  // 跨天叙事均衡：地理分片保证了「不在同一边折返」，但没管主题——
  // 三天可能全是老城+博物馆。这里只在自动日期之间做小幅交换，
  // 远足日、攻略日、锁定点一律不动。
  if (autoDays.length >= 2) {
    const slots = autoDays.filter((day) => (dayPlaces.get(day) ?? []).length > 1);
    if (slots.length >= 2) {
      const frozen = new Set<number>();
      slots.forEach((day, index) => {
        if (farDaysSet.has(day)) frozen.add(index + 1);
      });
      const balanced = balanceDays({
        days: slots.map((day) => dayPlaces.get(day) ?? []),
        city,
        clusterKm:
          input.clusterRadiusKm ??
          clusterRadiusFor(styles, pace, transport, input.seniors ?? 0),
        frozen,
      });
      slots.forEach((day, index) => {
        dayPlaces.set(day, balanced.days[index]);
      });
    }
  }

  // 跨天去重：同一处景点排进两天（尤其同一座岛被拆成两天，等于买两趟轮渡）
  // 在选点阶段就掐掉，并用同片区候补点补位。远足日整组冻结。
  if (autoDays.length >= 2) {
    const deduped = dedupeAcrossDays({
      days: autoDays.map((day) => ({
        day,
        places: dayPlaces.get(day) ?? [],
        frozen: farDaysSet.has(day),
      })),
      scored,
      clusterKm:
        input.clusterRadiusKm ??
        clusterRadiusFor(styles, pace, transport, input.seniors ?? 0),
    });
    for (const [day, places] of deduped.days) {
      dayPlaces.set(day, places);
    }
    for (const change of deduped.changes) {
      warnings.push(
        change.reason === "same-area"
          ? `「${change.name}」和${change.replacedBy ?? "另一天"}在同一片区域，第 ${change.day} 天不再重复去。`
          : change.replacedBy
            ? `「${change.name}」前一天已经去过，第 ${change.day} 天换成了「${change.replacedBy}」。`
            : `「${change.name}」前一天已经去过，第 ${change.day} 天不再重复。`,
      );
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
      const fixedLabel =
        input.fixedSource === "selected"
          ? "自选景点"
          : input.fixedSource === "mixed"
            ? "固定点位"
            : "攻略点位";
      const ordered = fixedPlacesForDay.slice(0, 12);
      if (fixedPlacesForDay.length > 12) {
        warnings.push(`第 ${day} 天的${fixedLabel}较多，仅保留前 12 个，其余建议拆到另一天。`);
      }
      if (ordered.length < 2) {
        warnings.push(
          input.fixedSource === "guide" || !input.fixedSource
            ? `第 ${day} 天只识别到 1 个攻略点位，路线会比较短。`
            : `第 ${day} 天只安排了 1 个${fixedLabel}，其余时间可自由活动。`,
        );
      }
      result.push({
        index: day,
        places: ordered,
        fixed: true,
        area: describeArea(ordered, hotel),
        theme: describeTheme(ordered, seed, day, city),
      });
      continue;
    }
    const picked = dayPlaces.get(day) ?? [];
    const far = farDaysSet.has(day);
    const anchorId = anchorByDay.get(day)?.[0];
    const anchor = anchorId
      ? picked.find((place) => place.id === anchorId) ?? picked[0]
      : picked[0];
    let oneWay = 0;
    if (anchor) {
      const ferryExtra =
        anchor.island && anchor.island !== hotel.island ? 30 : 0;
      oneWay = estimateModeMinutes(hotel, anchor, "taxi") + ferryExtra;
      if (far) {
        const dir = directionLabel(
          bearing([hotel.lng, hotel.lat], [anchor.lng, anchor.lat]),
        );
        warnings.push(
          `第 ${day} 天是远足日：往${dir}方向，单程约 ${oneWay} 分钟，${
            oneWay >= 60 ? "早点出发更从容。" : "按这条线走不用来回折返。"
          }`,
        );
      } else {
        const anchorKm = placeDistance(hotel, anchor);
        if (anchorKm > nearKm + 0.5) {
          // 主城点位不够时，近处日期也会用到城建区外的名寺、纪念馆；
          // 不标成远足日，但必须把单程时间说清楚，别让人以为就在酒店旁边。
          warnings.push(
            `第 ${day} 天主景点在城外约 ${Math.round(anchorKm)} km，单程约 ${oneWay} 分钟，按半日往返留好时间。`,
          );
        }
      }
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
      theme: describeTheme(picked, seed, day, city),
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
    // 只有回归检查会打开：把打分表原样带出来，才能断言「偏好确实改变了排序」，
    // 而不是只看最后排出来的几个名字是否碰巧不同。平时它是 undefined，不占内存。
    scored: input.debug
      ? scored.map((item) => ({
          id: item.place.id,
          name: item.place.name,
          popularity: item.place.popularity ?? 0,
          score: item.score,
        }))
      : undefined,
  };
}
