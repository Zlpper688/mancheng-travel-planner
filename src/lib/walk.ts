import { bearing, haversine, pathLengthKm } from "./geo";
import type {
  Category,
  DayPlan,
  PlanResult,
  PlanTip,
  StopPlan,
  TransportMode,
} from "./types";

export interface WalkStop {
  index: number;
  placeId: string;
  name: string;
  category: Category;
  kind: StopPlan["kind"];
  flexible: boolean;
  slot?: StopPlan["slot"];
  startMin: number;
  endMin: number;
  dwellMin: number;
  note?: string;
  tips: PlanTip[];
  attrs: string[];
  ticket?: number;
  openHours?: string;
  lng: number;
  lat: number;
}

export interface WalkTravel {
  kind: "travel";
  stopIndex: number;
  from: [number, number];
  to: [number, number];
  points: [number, number][];
  cum: number[];
  km: number;
  seconds: number;
  mode: TransportMode;
  durationMin: number;
  startMin: number;
  arriveMin: number;
  note?: string;
  toName: string;
}

export interface WalkDwell {
  kind: "dwell";
  stopIndex: number;
  stop: WalkStop;
  seconds: number;
  lng: number;
  lat: number;
}

export type WalkSegment = WalkTravel | WalkDwell;

export interface WalkRoute {
  dayIndex: number;
  date: string;
  theme: string;
  tip: string;
  color: string;
  stops: WalkStop[];
  segments: WalkSegment[];
  totalSeconds: number;
}

export const WALK_MODE_LABELS: Record<TransportMode, string> = {
  walk: "步行",
  transit: "公交",
  taxi: "打车",
};

const MIN_TRAVEL_SECONDS = 2.6;
const MAX_TRAVEL_SECONDS = 16;
const MIN_DWELL_SECONDS = 7;
const MAX_DWELL_SECONDS = 18;

function cumulative(points: [number, number][]): number[] {
  const result = [0];
  for (let index = 1; index < points.length; index += 1) {
    result.push(result[index - 1] + haversine(points[index - 1], points[index]));
  }
  return result;
}

function cleanPoints(points: [number, number][]): [number, number][] {
  const result: [number, number][] = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) {
      result.push(point);
    }
  }
  return result;
}

function travelSeconds(points: [number, number][], durationMin: number): number {
  const km = pathLengthKm(points);
  const byDistance = 2.2 + km * 6.5;
  const byMinutes = 2.2 + Math.max(0, durationMin) * 0.32;
  return Math.min(
    MAX_TRAVEL_SECONDS,
    Math.max(MIN_TRAVEL_SECONDS, Math.min(byDistance, byMinutes)),
  );
}

function dwellSeconds(stop: WalkStop): number {
  if (stop.flexible) return 7;
  const chars =
    (stop.note?.length ?? 0) + (stop.tips[0]?.body.length ?? 0);
  return Math.min(
    MAX_DWELL_SECONDS,
    Math.max(MIN_DWELL_SECONDS, 6 + chars * 0.06),
  );
}

function travelSegment(input: {
  stopIndex: number;
  from: [number, number];
  to: [number, number];
  geometry: [number, number][];
  mode: TransportMode;
  durationMin: number;
  startMin: number;
  arriveMin: number;
  note: string | undefined;
  toName: string;
}): WalkTravel {
  const points = cleanPoints(
    input.geometry.length >= 2 ? input.geometry : [input.from, input.to],
  );
  return {
    kind: "travel",
    stopIndex: input.stopIndex,
    from: input.from,
    to: input.to,
    points,
    cum: cumulative(points),
    km: pathLengthKm(points),
    seconds: travelSeconds(points, input.durationMin),
    mode: input.mode,
    durationMin: input.durationMin,
    startMin: input.startMin,
    arriveMin: input.arriveMin,
    note: input.note,
    toName: input.toName,
  };
}

function buildStops(day: DayPlan): WalkStop[] {
  return day.stops.map((stop, index) => ({
    index,
    placeId: stop.place.id,
    name: stop.place.name,
    category: stop.place.category,
    kind: stop.kind,
    flexible: Boolean(stop.flexible),
    slot: stop.slot,
    startMin: stop.startMin,
    endMin: stop.endMin,
    dwellMin: stop.dwellMin,
    note: stop.note,
    tips: stop.tips ?? [],
    attrs: stop.attrs ?? [],
    ticket: stop.ticket,
    openHours: stop.place.openHours,
    lng: stop.place.lng,
    lat: stop.place.lat,
  }));
}

export function buildWalkRoute(
  plan: PlanResult | null,
  dayIndex: number,
): WalkRoute | null {
  if (!plan) return null;
  const day = plan.days.find((item) => item.index === dayIndex);
  if (!day || !day.stops.length) return null;

  const stops = buildStops(day);
  const segments: WalkSegment[] = [];
  let previous: [number, number] = day.legs[0]?.from ?? [
    stops[0].lng,
    stops[0].lat,
  ];

  day.stops.forEach((stop, index) => {
    const leg = day.legs[index];
    const to: [number, number] = [stop.place.lng, stop.place.lat];
    segments.push(
      travelSegment({
        stopIndex: index,
        from: previous,
        to,
        geometry: leg?.geometry ?? [],
        mode: leg?.mode ?? "walk",
        durationMin: leg?.durationMin ?? 5,
        startMin: leg?.departMin ?? stop.startMin,
        arriveMin: leg?.arriveMin ?? stop.startMin,
        note: leg?.note,
        toName: stop.place.name,
      }),
    );
    const walkStop = stops[index];
    segments.push({
      kind: "dwell",
      stopIndex: index,
      stop: walkStop,
      seconds: dwellSeconds(walkStop),
      lng: to[0],
      lat: to[1],
    });
    previous = to;
  });

  const back = day.legs[day.stops.length];
  if (back && back.distanceKm > 0.03) {
    const backSegment = travelSegment({
      stopIndex: stops.length,
      from: previous,
      to: back.to,
      geometry: back.geometry,
      mode: back.mode,
      durationMin: back.durationMin,
      startMin: back.departMin,
      arriveMin: back.arriveMin,
      note: back.note,
      toName: "酒店",
    });
    backSegment.seconds = Math.min(backSegment.seconds, 10);
    segments.push(backSegment);
  }

  return {
    dayIndex: day.index,
    date: day.date,
    theme: day.theme,
    tip: day.tip,
    color: day.color,
    stops,
    segments,
    totalSeconds: segments.reduce((sum, segment) => sum + segment.seconds, 0),
  };
}

export interface WalkPoint {
  lng: number;
  lat: number;
  bearing: number;
}

export function pointAlong(segment: WalkTravel, progress: number): WalkPoint {
  const points = segment.points;
  if (!points.length) return { lng: 0, lat: 0, bearing: 90 };
  if (points.length === 1) {
    return { lng: points[0][0], lat: points[0][1], bearing: 90 };
  }
  const total = segment.cum[segment.cum.length - 1] ?? 0;
  const target = Math.min(1, Math.max(0, progress)) * total;
  let index = 1;
  while (index < segment.cum.length - 1 && segment.cum[index] < target) {
    index += 1;
  }
  const a = points[index - 1];
  const b = points[index] ?? a;
  const span = segment.cum[index] - segment.cum[index - 1] || 1;
  const fraction = Math.min(
    1,
    Math.max(0, (target - segment.cum[index - 1]) / span),
  );
  return {
    lng: a[0] + (b[0] - a[0]) * fraction,
    lat: a[1] + (b[1] - a[1]) * fraction,
    bearing: bearing(a, b),
  };
}

export function segmentElapsed(
  route: WalkRoute,
  segmentIndex: number,
  elapsed: number,
): number {
  let total = 0;
  for (let index = 0; index < segmentIndex; index += 1) {
    total += route.segments[index]?.seconds ?? 0;
  }
  return total + elapsed;
}