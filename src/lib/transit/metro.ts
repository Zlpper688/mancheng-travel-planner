import { estimateModeMinutes, haversine, placeDistance } from "../geo";
import type { Place } from "../types";

export interface MetroStation {
  name: string;
  lat: number;
  lng: number;
  lines: string[];
}

export interface MetroAccess {
  station: MetroStation;
  walkKm: number;
  walkMin: number;
}

export interface MetroTrip {
  minutes: number;
  rideMin: number;
  walkMin: number;
  walkKm: number;
  waitMin: number;
  rideKm: number;
  lines: string[];
  fromStation: string;
  toStation: string;
  transfers: number;
  stations: { name: string; lat: number; lng: number }[];
}

type Coord = Pick<Place, "lat" | "lng">;

// 厦门地铁 1/2/3 号线 2026 年运营站点，坐标来自 Wikidata / OSM。
const XIAMEN_LINES: { id: string; label: string; stations: string[] }[] = [
  {
    id: "1",
    label: "1 号线",
    stations: [
      "镇海路",
      "中山公园",
      "将军祠",
      "文灶",
      "湖滨东路",
      "莲坂",
      "莲花路口",
      "吕厝",
      "乌石浦",
      "塘边",
      "火炬园",
      "殿前",
      "高崎",
      "集美学村",
      "园博苑",
    ],
  },
  {
    id: "2",
    label: "2 号线",
    stations: [
      "邮轮中心",
      "建业路",
      "湖滨中路",
      "体育中心",
      "育秀东路",
      "吕厝",
      "江头",
      "蔡塘",
      "软件园二期",
      "何厝",
      "五通",
      "湿地公园",
      "钟宅",
      "五缘湾",
    ],
  },
  {
    id: "3",
    label: "3 号线",
    stations: [
      "厦门火车站",
      "湖滨东路",
      "体育中心",
      "人才中心",
      "湖里公园",
      "华荣路",
      "火炬园",
      "五缘湾",
    ],
  },
];

const XIAMEN_STATION_COORDS: Record<string, [number, number]> = {
  镇海路: [118.077841, 24.453377],
  中山公园: [118.084804, 24.458182],
  将军祠: [118.095125, 24.463666],
  文灶: [118.0985, 24.469],
  湖滨东路: [118.105521, 24.476605],
  莲坂: [118.113203, 24.478665],
  莲花路口: [118.118117, 24.486481],
  吕厝: [118.123235, 24.492593],
  乌石浦: [118.121564, 24.501463],
  塘边: [118.117745, 24.508932],
  火炬园: [118.113716, 24.514791],
  殿前: [118.111207, 24.527691],
  高崎: [118.11168, 24.540624],
  集美学村: [118.087452, 24.566552],
  园博苑: [118.061546, 24.572578],
  邮轮中心: [118.072173, 24.487586],
  建业路: [118.079116, 24.480751],
  湖滨中路: [118.090059, 24.483336],
  体育中心: [118.101399, 24.486459],
  育秀东路: [118.110336, 24.488656],
  江头: [118.133494, 24.49518],
  蔡塘: [118.148958, 24.489919],
  软件园二期: [118.179597, 24.483814],
  何厝: [118.187987, 24.487983],
  五通: [118.184575, 24.51467],
  湿地公园: [118.1774365, 24.5199888],
  钟宅: [118.1675205, 24.5274642],
  五缘湾: [118.1600734, 24.5366413],
  厦门火车站: [118.10971, 24.47187],
  人才中心: [118.09831, 24.49185],
  湖里公园: [118.10053, 24.50937],
  华荣路: [118.10463, 24.51417],
};

const XIAMEN_STATIONS: Record<string, MetroStation> = Object.fromEntries(
  Object.entries(XIAMEN_STATION_COORDS).map(([name, [lng, lat]]) => [
    name,
    {
      name,
      lat,
      lng,
      lines: XIAMEN_LINES.filter((line) => line.stations.includes(name)).map(
        (line) => line.id,
      ),
    },
  ]),
);

const CITY_LINES: Record<string, typeof XIAMEN_LINES> = {
  厦门: XIAMEN_LINES,
};

const CITY_STATIONS: Record<string, Record<string, MetroStation>> = {
  厦门: XIAMEN_STATIONS,
};

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