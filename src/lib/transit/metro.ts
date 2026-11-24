import { estimateModeMinutes, haversine, placeDistance } from "../geo";
import type { Place } from "../types";
import type { MetroAccess, MetroStation, MetroTrip } from "./types";
import { CITY_LINES, CITY_STATIONS } from "../../content/metro-xiamen";

type Coord = Pick<Place, "lat" | "lng">;

function cityKey(city: string): string {
  return city.replace(/市$/, "").trim();
}

function cityStations(city: string): Record<string, MetroStation> | null {
  return CITY_STATIONS[cityKey(city)] ?? null;
}

function nearestStation(
  coord: Coord,
  stations: Record<string, MetroStation>,
): { station: MetroStation; km: number } | null {
  let best: { station: MetroStation; km: number } | null = null;
  for (const station of Object.values(stations)) {
    const km = haversine([coord.lng, coord.lat], [station.lng, station.lat]) * 1.22;
    if (!best || km < best.km) best = { station, km };
  }
  return best;
}

export function metroAccess(place: Coord, city: string): MetroAccess | null {
  const stations = cityStations(city);
  if (!stations) return null;
  const near = nearestStation(place, stations);
  if (!near || near.km > 1.4) return null;
  return {
    station: near.station,
    walkKm: near.km,
    walkMin: Math.max(2, Math.round((near.km / 4.8) * 60)),
  };
}

export function sharedMetroLine(
  a: Coord,
  b: Coord,
  city: string,
): string | null {
  const accessA = metroAccess(a, city);
  const accessB = metroAccess(b, city);
  if (!accessA || !accessB) return null;
  const lines = accessA.station.lines.filter((line) =>
    accessB.station.lines.includes(line),
  );
  return lines.length ? lines.sort()[0] : null;
}

interface State {
  station: string;
  line: string;
}

function stateKey(station: string, line: string): string {
  return `${station}|${line}`;
}

function edgeMinutes(km: number): number {
  return Math.max(2, (km / 32) * 60 + 0.8);
}

export function metroTrip(from: Coord, to: Coord, city: string): MetroTrip | null {
  const lines = CITY_LINES[cityKey(city)];
  const stations = cityStations(city);
  if (!lines || !stations) return null;
  const start = metroAccess(from, city);
  const end = metroAccess(to, city);
  if (!start || !end || start.station.name === end.station.name) return null;

  const adjacency = new Map<string, { next: string; cost: number; km: number }[]>();
  const addEdge = (
    a: State,
    b: State,
    cost: number,
    km: number,
  ) => {
    const key = stateKey(a.station, a.line);
    const list = adjacency.get(key) ?? [];
    list.push({ next: stateKey(b.station, b.line), cost, km });
    adjacency.set(key, list);
  };

  for (const line of lines) {
    for (let index = 0; index < line.stations.length - 1; index++) {
      const a = stations[line.stations[index]];
      const b = stations[line.stations[index + 1]];
      if (!a || !b) continue;
      const km = haversine([a.lng, a.lat], [b.lng, b.lat]) * 1.15;
      const cost = edgeMinutes(km);
      addEdge(
        { station: a.name, line: line.id },
        { station: b.name, line: line.id },
        cost,
        km,
      );
      addEdge(
        { station: b.name, line: line.id },
        { station: a.name, line: line.id },
        cost,
        km,
      );
    }
  }

  for (const station of Object.values(stations)) {
    for (const line of station.lines) {
      for (const other of station.lines) {
        if (line === other) continue;
        addEdge(
          { station: station.name, line },
          { station: station.name, line: other },
          5,
          0,
        );
      }
    }
  }

  const waitMin = 4;
  const distances = new Map<string, { cost: number; prev: string | null }>();
  const queue: { key: string; cost: number }[] = [];
  for (const line of start.station.lines) {
    const key = stateKey(start.station.name, line);
    distances.set(key, { cost: start.walkMin + waitMin, prev: null });
    queue.push({ key, cost: start.walkMin + waitMin });
  }

  let bestKey: string | null = null;
  let bestCost = Infinity;
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const current = queue.shift();
    if (!current) break;
    if (current.cost > bestCost) break;
    const known = distances.get(current.key);
    if (!known || current.cost > known.cost) continue;
    const [station] = current.key.split("|");
    if (station === end.station.name) {
      const total = current.cost + end.walkMin;
      if (total < bestCost) {
        bestCost = total;
        bestKey = current.key;
      }
      continue;
    }
    for (const edge of adjacency.get(current.key) ?? []) {
      const nextCost = current.cost + edge.cost;
      const nextKnown = distances.get(edge.next);
      if (nextKnown && nextKnown.cost <= nextCost) continue;
      distances.set(edge.next, { cost: nextCost, prev: current.key });
      queue.push({ key: edge.next, cost: nextCost });
    }
  }

  if (!bestKey) return null;
  const path: string[] = [];
  let cursor: string | null = bestKey;
  while (cursor) {
    path.push(cursor);
    cursor = distances.get(cursor)?.prev ?? null;
  }
  path.reverse();
  const usedLines = Array.from(
    new Set(path.map((key) => key.split("|")[1])),
  ).sort();
  let rideMin = 0;
  let rideKm = 0;
  for (let index = 1; index < path.length; index++) {
    const edges = adjacency.get(path[index - 1]) ?? [];
    const edge = edges.find((item) => item.next === path[index]);
    if (!edge) continue;
    rideMin += edge.cost;
    rideKm += edge.km;
  }
  const stops: { name: string; lat: number; lng: number }[] = [];
  for (const key of path) {
    const name = key.split("|")[0];
    const station = stations[name];
    if (!station) continue;
    if (stops.length && stops[stops.length - 1].name === name) continue;
    stops.push({ name, lat: station.lat, lng: station.lng });
  }
  return {
    minutes: Math.round(bestCost),
    rideMin: Math.round(rideMin),
    walkMin: start.walkMin + end.walkMin,
    walkKm: start.walkKm + end.walkKm,
    waitMin,
    rideKm,
    lines: usedLines,
    fromStation: start.station.name,
    toStation: end.station.name,
    transfers: Math.max(0, usedLines.length - 1),
    stations: stops,
  };
}

export function metroLabel(lines: string[]): string {
  if (!lines.length) return "地铁";
  return `地铁 ${lines.join("/")} 号线`;
}

// 只有当两端步行都合理、且总耗时没有被打车明显甩开时，地铁才值得写进行程。
export function usableMetroTrip(
  from: Place,
  to: Place,
  city: string,
): MetroTrip | null {
  if (!city) return null;
  const trip = metroTrip(from, to, city);
  if (!trip) return null;
  const km = placeDistance(from, to);
  if (km < 1.8) return null;
  const taxiMin = estimateModeMinutes(from, to, "taxi") + 2;
  if (trip.minutes > taxiMin + 15) return null;
  if (km <= 3.5) {
    const walkMin = estimateModeMinutes(from, to, "walk");
    if (trip.minutes > Math.max(12, walkMin * 0.75)) return null;
  }
  return trip;
}