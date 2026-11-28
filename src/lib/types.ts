export type Category =
  | "attraction"
  | "museum"
  | "park"
  | "viewpoint"
  | "beach"
  | "street"
  | "temple"
  | "market"
  | "nature"
  | "food"
  | "cafe"
  | "hotel"
  | "other";

export type StyleId =
  | "citywalk"
  | "classic"
  | "coastal"
  | "culture"
  | "foodie"
  | "family";

export type ExperienceId =
  | "sunrise"
  | "sunset"
  | "night"
  | "coast"
  | "boat"
  | "hike"
  | "oldtown"
  | "museum"
  | "temple"
  | "food"
  | "ride"
  | "photo"
  | "soak"
  | "show";

export type PaceId = "chill" | "balanced" | "packed";
export type TransportPref = "auto" | "walk" | "transit" | "drive";
export type BudgetTier = "economy" | "comfort" | "premium";
export type TransportMode = "walk" | "transit" | "taxi";
export type DataSourceKind = "amap" | "open" | "demo";
export type WeatherIcon =
  | "sun"
  | "cloud-sun"
  | "cloud"
  | "rain"
  | "snow"
  | "storm"
  | "fog";

export interface HourlyPoint {
  hour: number;
  mm: number;
  prob?: number;
  temp?: number;
}

export interface RainWindow {
  startMin: number;
  endMin: number;
  mm: number;
  peakProb: number;
}

export interface DayWeather {
  code: number;
  label: string;
  icon: WeatherIcon;
  tMax: number;
  tMin: number;
  precipProb?: number;
  precipMm?: number;
  windKmh?: number;
  sunrise?: string;
  sunset?: string;
  tip?: string;
  estimated: boolean;
  source: "open-meteo" | "open-meteo-archive";
  backup?: { placeId: string; name: string };
  hourly?: HourlyPoint[];
  rainWindows?: RainWindow[];
}

export interface CityOption {
  name: string;
  address?: string;
  lat: number;
  lng: number;
}

export interface Place {
  id: string;
  name: string;
  category: Category;
  lat: number;
  lng: number;
  address?: string;
  city?: string;
  rating?: number;
  cost?: number;
  costNote?: string;
  openHours?: string;
  popularity?: number;
  note?: string;
  source: "amap" | "osm" | "wikidata" | "demo";
  tags?: string[];
  island?: string;
  wikidataId?: string;
  image?: string;
  commons?: string;
  wikipedia?: string;
  website?: string;
  /**
   * 从住处出发，值得为这个点单独跑的单程分钟上限。
   * 区域环线/小城大景点的必去点会带较大值，城市漫游不设（走默认收口）。
   * 由本地知识库按目的地形态写入，远足日选点与审计读它放宽硬上限。
   */
  reachMin?: number;
}

export interface FixedPlace {
  place: Place;
  day: number;
}

export interface TripInput {
  city: string;
  center?: [number, number];
  hotel?: Place;
  hotelUndecided?: boolean;
  days: number;
  date: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  budgetTier: BudgetTier;
  adults: number;
  children: number;
  seniors?: number;
  avoidSteep?: boolean;
  notes?: string;
  seed: number;
  hotelPrice?: number;
  fixedPlaces?: FixedPlace[];
  selectedPlaces?: Place[];
  /** 单点锁定：这个点必须出现在该天，其余点位仍由算法安排。 */
  lockedPlaces?: FixedPlace[];
  /** 用户手动移除或替换掉的点位，后续重排不得再次出现。 */
  excludeIds?: string[];
  /** 某天少排几个点位（移除点位后用），键是第几天。 */
  slimDays?: Record<number, number>;
  farDays?: number;
  experiences?: ExperienceId[];
  /**
   * 排线软参数覆盖层（LLM 唯一能改的部分）。不传时引擎行为与以前完全一致。
   * 硬约束不在这里：日期/天数/人数/点名必去点/已订酒店/排除点仍由用户决定。
   */
  planParams?: import("./plan/params").PlanParams;
  /**
   * 连续偏好向量（每维 0~1，0.5 = 中性）。
   * 与 styles 的分工：styles 回答「玩什么」，它回答「玩到多深」——
   * 愿不愿意走、怕不怕人多、要不要出片。不传时对打分零影响。
   */
  prefs?: import("./plan/prefs").TripVector;
}

export interface WishlistGoal {
  experience: ExperienceId;
  label: string;
  placeId: string;
  placeName: string;
  bandLabel: string;
  durationMin: number;
  reason?: string;
  alternatives: { placeId: string; name: string }[];
}

export interface DayAlternative {
  placeId: string;
  name: string;
  experience: ExperienceId;
  experienceLabel: string;
  distanceKm: number;
  reason: string;
}

export interface RouteAlternative {
  mode: TransportMode;
  durationMin: number;
  distanceKm: number;
  cost: number;
  costUnit: "person" | "vehicle";
  estimated: boolean;
  note?: string;
}

export interface RouteLeg {
  index: number;
  fromName: string;
  toName: string;
  from: [number, number];
  to: [number, number];
  mode: TransportMode;
  durationMin: number;
  distanceKm: number;
  cost: number;
  costUnit: "person" | "vehicle";
  estimated: boolean;
  departMin: number;
  arriveMin: number;
  geometry: [number, number][];
  alternatives: RouteAlternative[];
  note?: string;
}

export type StopKind = "sight" | "meal" | "cafe";

export type TipKind =
  | "booking"
  | "family"
  | "weather"
  | "crowd"
  | "ferry"
  | "island"
  | "food"
  | "photo"
  | "temple"
  | "slow"
  | "transit"
  | "city"
  | "safety";

export interface PlanTip {
  id: string;
  kind: TipKind;
  title: string;
  body: string;
  source: string;
}

export interface StopPlan {
  id: string;
  place: Place;
  kind: StopKind;
  order: number;
  startMin: number;
  endMin: number;
  dwellMin: number;
  note?: string;
  ticket?: number;
  estimatedTicket?: boolean;
  slot?: "lunch" | "dinner" | "cafe";
  flexible?: boolean;
  attrs?: string[];
  tips?: PlanTip[];
}

/**
 * 一天的六个语义时段（宪法：时段级规划单元）。
 * 时间用「早上/上午/中午/下午/晚上/夜间」这类人话，不纠结分钟；
 * 精确时间由引擎算，展示时可折叠。
 */
export type SlotPeriod =
  | "early"
  | "morning"
  | "noon"
  | "afternoon"
  | "evening"
  | "night";

export const SLOT_PERIODS: SlotPeriod[] = [
  "early",
  "morning",
  "noon",
  "afternoon",
  "evening",
  "night",
];

export const SLOT_PERIOD_LABELS: Record<SlotPeriod, string> = {
  early: "早上",
  morning: "上午",
  noon: "中午",
  afternoon: "下午",
  evening: "晚上",
  night: "夜间",
};

/** 时段是最小可编辑单元：局部替换只影响这一段，其余段锁定不变。 */
export interface DaySlot {
  period: SlotPeriod;
  /** 这一段的意图（"轻松逛逛 / 拍照 / 吃本地菜"），缺省由点位类型推断。 */
  intent?: string;
  /** 属于这一段的停靠点（引用 stops 里的对象，不复制数据）。 */
  stops: StopPlan[];
  /** 该段最早开始 / 最晚结束（分钟）。 */
  startMin?: number;
  endMin?: number;
  /** 上一段到这一段之间的路程（分钟）。 */
  legFromPrevMin?: number;
  /** 用户锁定后，重排不得改动这一段。 */
  locked?: boolean;
  /** 该段为空时给用户的话术，不静默展示空白。 */
  emptyHint?: string;
}

export interface DayStats {
  stopCount: number;
  sightCount: number;
  distanceKm: number;
  travelMin: number;
  walkKm: number;
  ticket: number;
}

export interface DayRhythm {
  sunrise?: boolean;
  sunset?: boolean;
  early?: boolean;
  night?: boolean;
  indoorMidday?: boolean;
}

export interface DayPlan {
  index: number;
  date: string;
  theme: string;
  area: string;
  color: string;
  stops: StopPlan[];
  /** 时段级视图（由 stops 投影而来；stops 仍是排线真源，保持兼容）。 */
  slots?: DaySlot[];
  legs: RouteLeg[];
  stats: DayStats;
  startMin: number;
  endMin: number;
  tip: string;
  strategy?: string;
  /** 「为什么这么排」：按主景、片区、时间轴和餐食位置给出的四条理由。 */
  why?: string[];
  heroName?: string;
  heroPlaceId?: string;
  rhythm?: DayRhythm;
  far?: boolean;
  weather?: DayWeather;
  tips?: PlanTip[];
  alternatives?: DayAlternative[];
  /**
   * 当天体力曲线：出门时 / 回到住处时的能量，以及全天最低点。
   * 纯记录，不参与排线决策——排序时用的是 energy.ts 的代价函数。
   */
  energy?: {
    start: number;
    end: number;
    low: number;
    lowPlaceId?: string;
    strained?: boolean;
  };
}

export interface BudgetItem {
  key: string;
  label: string;
  detail: string;
  min: number;
  max: number;
  note?: string;
}

export interface BudgetSummary {
  totalMin: number;
  totalMax: number;
  perPersonMin: number;
  perPersonMax: number;
  travelers: number;
  items: BudgetItem[];
}

export interface HolidayInfo {
  name: string;
  crowd: number;
  crowdPct: number;
  hotelFactor: number;
  tip: string;
}

export interface PlanMeta {
  city: string;
  title: string;
  subtitle: string;
  startDate: string;
  endDate: string;
  days: number;
  travelers: number;
  source: DataSourceKind;
  sourceNote: string;
  dataNotes: string[];
  holiday?: HolidayInfo;
  isFixed: boolean;
  fixedKind?: "guide" | "selected" | "mixed";
  archetype?: { id: string; label: string; summary: string };
  generatedAt: string;
}

export type LodgingKind =
  | "city"
  | "oldtown"
  | "gateway"
  | "inside"
  | "transit";

export interface LodgingBase {
  id: string;
  name: string;
  kind: LodgingKind;
  lat: number;
  lng: number;
  role: "main" | "optional";
  nights: number[];
  reason: string;
  tradeoff?: string;
}

export interface LodgingPlan {
  status: "fixed" | "recommended";
  strategy: "hub" | "gateway" | "multi";
  headline: string;
  summary: string;
  bases: LodgingBase[];
  notes: string[];
}

export interface PlanResult {
  meta: PlanMeta;
  days: DayPlan[];
  budget: BudgetSummary;
  warnings: string[];
  tips?: PlanTip[];
  wishlist?: WishlistGoal[];
  lodging?: LodgingPlan;
}

export interface PlanResponse {
  plan?: PlanResult;
  error?: string;
  hint?: string;
  code?: string;
  /** 生成-反驳-修订循环的透明记录（可选，老客户端忽略即可）。 */
  refine?: {
    rounds: number;
    score: number;
    adjustments: string[];
    issueCount: number;
  };
}

export interface GuideStop {
  day: number;
  query: string;
  place: Place | null;
  confidence: number;
}

export interface GuideParseResult {
  stops: GuideStop[];
  days: number;
  rawCount: number;
  unmatched: { day: number; query: string }[];
  notes: string[];
}
