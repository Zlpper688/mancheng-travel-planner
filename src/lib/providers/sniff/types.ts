import type { DataSourceKind, Place } from "../../types";

export type SniffStage = "base" | "deep";
export type SniffSourceKind = "amap" | "osm" | "wikidata" | "demo";

export interface SniffOptions {
  city: string;
  center: [number, number];
  stage: SniffStage;
}

export interface SniffBoundary {
  name: string;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
  areaId?: number;
  adcode?: string;
  /** WGS-84 边界环；有值时优先用点在多边形内裁剪 */
  rings?: [number, number][][];
}

export interface SniffSourceResult {
  source: SniffSourceKind;
  places: Place[];
  notes: string[];
  requests: number;
  truncated: boolean;
  raw: number;
  boundary?: SniffBoundary;
}

export interface SniffSourceBreakdown {
  amap: number;
  osm: number;
  wikidata: number;
  demo: number;
}

export interface SniffStats {
  stage: SniffStage;
  raw: number;
  kept: number;
  bySource: SniffSourceBreakdown;
  requests: number;
  truncated: boolean;
  elapsedMs: number;
  hasMore: boolean;
  boundary?: {
    name: string;
    bbox: [number, number, number, number];
    areaId?: number;
    adcode?: string;
  };
}

export interface SniffResult {
  sights: Place[];
  source: DataSourceKind;
  sourceNote: string;
  notes: string[];
  stats: SniffStats;
}