import type {
  DataSourceKind,
  Place,
  StyleId,
  TransportMode,
} from "../types";

export interface RawRoute {
  mode: TransportMode;
  durationMin: number;
  distanceKm: number;
  cost: number;
  costUnit: "person" | "vehicle";
  estimated: boolean;
  geometry: [number, number][];
  note?: string;
}

export interface DiscoverResult {
  sights: Place[];
  meals: Place[];
  notes: string[];
  source: DataSourceKind;
  sourceNote: string;
  isDemo?: boolean;
}

export interface SearchOptions {
  city?: string;
  center?: [number, number];
  kind?: "city" | "hotel" | "any";
}

export interface DiscoverOptions {
  city: string;
  center?: [number, number];
  hotel: Place;
  radiusKm: number;
  days: number;
  styles: StyleId[];
}

export interface PlaceProvider {
  source: DataSourceKind;
  sourceNote: string;
  search(query: string, options?: SearchOptions): Promise<Place[]>;
  reverse(lat: number, lng: number): Promise<Place | null>;
  discover(options: DiscoverOptions): Promise<DiscoverResult>;
  route(
    from: Place,
    to: Place,
    mode: TransportMode,
    city: string,
  ): Promise<RawRoute>;
}
