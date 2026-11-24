export type GuideStopKind = "sight" | "meal" | "stay";

export interface GuideRouteStop {
  name: string;
  kind: GuideStopKind;
}

export interface GuideRouteDay {
  day: number;
  stops: GuideRouteStop[];
  raw?: string;
  title?: string | null;
}

export interface GuideRoute {
  id: string;
  title: string | null;
  days: GuideRouteDay[];
  stopCount: number;
  source: "day-headers" | "fallback";
  needsReview: boolean;
}

export interface GuideEntry {
  id: string;
  city: string;
  cityAliases: string[];
  region: string;
  title: string;
  source: string;
  encoding: "clean" | "repaired" | "suspect";
  status: "ok" | "partial" | "none";
  canonicalRouteId: string | null;
  routes: GuideRoute[];
}

export interface GuideRouteSummary {
  id: string;
  title: string | null;
  days: number;
  stops: number;
  needsReview: boolean;
}

export interface GuideIndexItem {
  id: string;
  city: string;
  cityAliases: string[];
  region: string;
  title: string;
  status: "ok" | "partial" | "none";
  encoding: "clean" | "repaired" | "suspect";
  routeCount: number;
  canonicalRouteId: string | null;
  canonicalTitle: string | null;
  days: number;
  stops: number;
  needsReview: boolean;
  routes: GuideRouteSummary[];
}

export interface GuideIndex {
  version: number;
  count: number;
  statusCount: Record<string, number>;
  encodingCount: Record<string, number>;
  guides: GuideIndexItem[];
}