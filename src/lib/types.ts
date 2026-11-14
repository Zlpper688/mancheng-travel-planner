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

export type PaceId = "chill" | "balanced" | "packed";
export type TransportPref = "auto" | "walk" | "transit" | "drive";
export type BudgetTier = "economy" | "comfort" | "premium";
export type TransportMode = "walk" | "transit" | "taxi";
export type DataSourceKind = "amap" | "open" | "demo";

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
}

export interface FixedPlace {
  place: Place;
  day: number;
}

export interface TripInput {
  city: string;
  center?: [number, number];
  hotel: Place;
  days: number;
  date: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  budgetTier: BudgetTier;
  adults: number;
  children: number;
  seed: number;
  hotelPrice?: number;
  fixedPlaces?: FixedPlace[];
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
}

export interface DayStats {
  stopCount: number;
  sightCount: number;
  distanceKm: number;
  travelMin: number;
  walkKm: number;
  ticket: number;
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
  generatedAt: string;
}

export interface PlanResult {
  meta: PlanMeta;
  days: DayPlan[];
  budget: BudgetSummary;
  warnings: string[];
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
