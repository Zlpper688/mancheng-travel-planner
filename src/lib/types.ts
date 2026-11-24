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
  farDays?: number;
  experiences?: ExperienceId[];
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
  legs: RouteLeg[];
  stats: DayStats;
  startMin: number;
  endMin: number;
  tip: string;
  strategy?: string;
  heroName?: string;
  heroPlaceId?: string;
  rhythm?: DayRhythm;
  far?: boolean;
  weather?: DayWeather;
  tips?: PlanTip[];
  alternatives?: DayAlternative[];
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
