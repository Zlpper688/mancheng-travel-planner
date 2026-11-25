import { PACES } from "../../constants";
import { placeDistance } from "../../geo";
import type { DayRhythm, PaceId, Place, StyleId, TransportPref } from "../../types";
import {
  LATEST_START,
  bandPenalty,
  rhythmDwell,
  rhythmOf,
  rhythmTravelMinutes,
  startForFirst,
  type RhythmProfile,
} from "./profile";

function hardPenalty(order: Entry[]): number {
  let penalty = 0;
  const n = order.length;
  const sunsets = order.filter((entry) => entry.profile.sunset).length;
  const quicks = order.filter((entry) => entry.profile.quickStop).length;
  if (sunsets > 1) penalty += (sunsets - 1) * 2.6;
  if (quicks > 1) penalty += (quicks - 1) * 2.4;
  const hasNight = order.some((entry) => entry.profile.nightStreet);
  const sunsetLast = hasNight ? n - 2 : n - 1;
  order.forEach((entry, index) => {
    if (entry.profile.sunset && index < sunsetLast) {
      penalty += (sunsetLast - index) * 2.4;
    }
    if (entry.profile.sunrise && index > 0) penalty += 4 + index * 1.5;
    if (entry.profile.marketMorning && index > 1) {
      penalty += (index - 1) * 2.2;
    }
    if (entry.profile.nightStreet && index !== n - 1) {
      penalty += (n - 1 - index) * 3.5;
    }
    if (entry.profile.quickStop && index === 0 && n > 2) penalty += 0.8;
  });
  return penalty;
}

export interface Entry {
  place: Place;
  profile: RhythmProfile;
}

interface ComposeState {
  order: Entry[];
  prev: Place;
  clock: number;
  score: number;
  used: Set<string>;
}

export interface ComposeInput {
  places: Place[];
  hotel: Place;
  city: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  dayIndex: number;
  anchorId?: string;
  fixed?: boolean;
  baseStart?: number;
  seed: number;
}

export interface ComposedDay {
  places: Place[];
  heroId?: string;
  protectedIds: string[];
  rhythm: DayRhythm;
  startMinHint?: number;
  warnings: string[];
}

function heroValue(entry: Entry): number {
  const popularity = entry.place.popularity ?? 3.4;
  return (
    popularity +
    (entry.profile.heroEligible ? 1.1 : 0) -
    (entry.profile.quickStop ? 2.2 : 0) +
    Math.min(1, entry.profile.durationMin / 150)
  );
}

export function pickHero(entries: Entry[], anchorId?: string): Entry | undefined {
  const anchor = anchorId
    ? entries.find((entry) => entry.place.id === anchorId)
    : undefined;
  // 夜市和顺路短停是收尾/过渡角色，不该顶掉真正的白天主景。
  if (anchor && !anchor.profile.nightStreet && !anchor.profile.quickStop) {
    return anchor;
  }
  const eligible = entries.filter(
    (entry) => entry.profile.heroEligible && !entry.profile.nightStreet,
  );
  // 只有日落 + 夜市的日子，也别把夜市写成当天主景；白天的海和街区才是主体。
  const daySights = entries.filter(
    (entry) =>
      !entry.profile.nightStreet &&
      !entry.profile.quickStop &&
      entry.place.category !== "food" &&
      entry.place.category !== "cafe",
  );
  return (
    [...eligible].sort((a, b) => heroValue(b) - heroValue(a))[0] ??
    [...daySights].sort((a, b) => heroValue(b) - heroValue(a))[0] ??
    anchor ??
    [...entries].sort((a, b) => heroValue(b) - heroValue(a))[0]
  );
}

function summarizeOrder(
  order: Entry[],
  input: ComposeInput,
  startMin?: number,
): Omit<ComposedDay, "places"> {
  const warnings: string[] = [];
  const quicks = order.filter((entry) => entry.profile.quickStop);
  if (quicks.length > 1) {
    warnings.push(
      `今天有 ${quicks.length} 个商业街区，时间只够认真逛一个，另一个建议换成博物馆或公园。`,
    );
  }
  const sunsets = order.filter((entry) => entry.profile.sunset);
  if (sunsets.length > 1) {
    warnings.push("一天里有两个适合看日落的地方，选一个留到傍晚就好。");
  }
  const hero = pickHero(order, input.anchorId);
  const protectedIds = Array.from(
    new Set(
      [
        hero?.place.id,
        ...order
          .filter(
            (entry) =>
              entry.profile.sunset ||
              entry.profile.sunrise ||
              entry.profile.marketMorning ||
              entry.profile.nightStreet,
          )
          .map((entry) => entry.place.id),
      ].filter(Boolean) as string[],
    ),
  );

  let clock =
    startMin ??
    startForFirst(
      order[0].profile,
      input.pace,
      input.baseStart ?? PACES[input.pace].startMin,
    );
  let prev = input.hotel;
  let indoorMidday = false;
  let sunsetTimed = false;
  let sunriseTimed = false;
  let nightTimed = false;
  let nightArrival: number | null = null;
  let sunsetArrival: number | null = null;
  let lateMorningName: string | null = null;
  for (const entry of order) {
    clock += rhythmTravelMinutes(prev, entry.place, input);
    const arrival = clock;
    if (
      entry.profile.windows.length > 0 &&
      entry.profile.windows.every(([, end]) => end <= 11 * 60) &&
      arrival >= 13 * 60
    ) {
      lateMorningName = entry.place.name;
    }
    if (
      entry.profile.indoor &&
      arrival >= 11 * 60 &&
      arrival <= 15 * 60 + 30
    ) {
      indoorMidday = true;
    }
    if (entry.profile.sunset) {
      sunsetArrival = arrival;
      if (arrival >= 15 * 60 + 30) sunsetTimed = true;
    }
    if (entry.profile.nightStreet) {
      nightArrival = arrival;
      if (arrival >= 17 * 60) nightTimed = true;
    }
    if (entry.profile.sunrise && arrival < 8 * 60 + 30) sunriseTimed = true;
    clock =
      arrival +
      rhythmDwell(entry.place, input.city, input.pace, input.styles) +
      PACES[input.pace].bufferMin;
    prev = entry.place;
  }

  const opensEarly = order.some(
    (entry) => entry.profile.sunrise || entry.profile.marketMorning,
  );
  if (opensEarly && sunsetArrival !== null && sunsetArrival > 15 * 60) {
    warnings.push(
      "今天一早一晚两头都有安排，午后回住处歇一会儿，或在附近找家店慢慢坐，别硬撑。",
    );
  }
  if (lateMorningName) {
    warnings.push(
      `「${lateMorningName}」本来更适合上午，排到了午后；如果带着老人孩子，注意放慢节奏、多补水。`,
    );
  }

  return {
    heroId: hero?.place.id,
    protectedIds,
    rhythm: {
      sunrise: sunriseTimed || undefined,
      sunset: sunsetTimed || undefined,
      early:
        Boolean(sunriseTimed) ||
        Boolean(order.some((entry) => entry.profile.marketMorning)) ||
        undefined,
      night: nightTimed || undefined,
      indoorMidday: indoorMidday || undefined,
    },
    startMinHint:
      startMin ??
      startForFirst(
        order[0].profile,
        input.pace,
        input.baseStart ?? PACES[input.pace].startMin,
      ),
    warnings,
  };
}

function plainSearch(
  entries: Entry[],
  input: ComposeInput,
  startMin: number,
): { order: Entry[]; total: number } {
  const n = entries.length;
  if (n <= 1) return { order: [...entries], total: 0 };
  const buffer = PACES[input.pace].bufferMin;

  const initial: ComposeState[] = entries.map((entry) => {
    const minutes = rhythmTravelMinutes(input.hotel, entry.place, input);
    const arrival = startMin + minutes;
    return {
      order: [entry],
      prev: entry.place,
      clock:
        arrival +
        rhythmDwell(entry.place, input.city, input.pace, input.styles) +
        buffer,
      score:
        placeDistance(input.hotel, entry.place) * 0.22 +
        minutes * 0.01 +
        bandPenalty(entry.profile, arrival),
      used: new Set([entry.place.id]),
    };
  });

  const beamLimit = n <= 7 ? Number.POSITIVE_INFINITY : 3200;
  let beams = initial;
  for (let depth = 1; depth < n; depth++) {
    const next: ComposeState[] = [];
    for (const state of beams) {
      for (const entry of entries) {
        if (state.used.has(entry.place.id)) continue;
        const minutes = rhythmTravelMinutes(state.prev, entry.place, input);
        const arrival = state.clock + minutes;
        next.push({
          order: [...state.order, entry],
          prev: entry.place,
          clock:
            arrival +
            rhythmDwell(entry.place, input.city, input.pace, input.styles) +
            buffer,
          score:
            state.score +
            placeDistance(state.prev, entry.place) * 0.22 +
            minutes * 0.01 +
            bandPenalty(entry.profile, arrival),
          used: new Set([...state.used, entry.place.id]),
        });
      }
    }
    next.sort((a, b) => a.score - b.score);
    beams = Number.isFinite(beamLimit) ? next.slice(0, beamLimit) : next;
  }

  let best: ComposeState | null = null;
  let bestTotal = Infinity;
  for (const state of beams) {
    if (state.order.length !== n) continue;
    const backMinutes = rhythmTravelMinutes(state.prev, input.hotel, input);
    const total =
      state.score +
      placeDistance(state.prev, input.hotel) * 0.22 +
      backMinutes * 0.01 +
      hardPenalty(state.order);
    if (total < bestTotal) {
      bestTotal = total;
      best = state;
    }
  }
  return { order: best?.order ?? [...entries], total: bestTotal };
}

interface DayFrame {
  opening: Entry[];
  middle: Entry[];
  closing: Entry[];
  startMin: number;
}

function takeBest(
  entries: Entry[],
  used: Set<string>,
  predicate: (entry: Entry) => boolean,
  score: (entry: Entry) => number = heroValue,
): Entry | undefined {
  let best: Entry | undefined;
  let bestScore = -Infinity;
  for (const entry of entries) {
    if (used.has(entry.place.id)) continue;
    if (!predicate(entry)) continue;
    const value = score(entry);
    if (value > bestScore) {
      bestScore = value;
      best = entry;
    }
  }
  if (best) used.add(best.place.id);
  return best;
}

function closingTarget(entry: Entry): number {
  if (entry.profile.nightStreet) return 18 * 60;
  if (entry.profile.sunset) return 16 * 60 + 40;
  return 17 * 60 + 15;
}

function advance(
  prev: Place,
  clock: number,
  score: number,
  entries: Entry[],
  input: ComposeInput,
): { prev: Place; clock: number; score: number } {
  const buffer = PACES[input.pace].bufferMin;
  let state = { prev, clock, score };
  for (const entry of entries) {
    const minutes = rhythmTravelMinutes(state.prev, entry.place, input);
    const arrival = state.clock + minutes;
    state = {
      prev: entry.place,
      clock:
        arrival +
        rhythmDwell(entry.place, input.city, input.pace, input.styles) +
        buffer,
      score:
        state.score +
        placeDistance(state.prev, entry.place) * 0.22 +
        minutes * 0.01 +
        bandPenalty(entry.profile, arrival),
    };
  }
  return state;
}

// 一天只有一条时间主轴：要么早起（日出/早市/上岛），要么傍晚收尾（日落/夜市）。
// 开场和收尾锚点先定死，中间的点只负责把一天顺路填满。
function buildFrame(entries: Entry[], input: ComposeInput): DayFrame {
  const used = new Set<string>();
  const gateway = takeBest(
    entries,
    used,
    (entry) => entry.profile.gateway,
    (entry) => entry.place.popularity ?? 3.4,
  );
  const sunrise = takeBest(
    entries,
    used,
    (entry) => entry.profile.sunrise,
  );
  const market = takeBest(
    entries,
    used,
    (entry) => entry.profile.marketMorning && !entry.profile.sunrise,
  );
  const night = takeBest(
    entries,
    used,
    (entry) => entry.profile.nightStreet,
    (entry) => entry.profile.closingScore + heroValue(entry) * 0.01,
  );
  const sunset = takeBest(
    entries,
    used,
    (entry) => entry.profile.sunset,
  );
  let late: Entry | undefined;
  if (!night && !sunset) {
    late = takeBest(
      entries,
      used,
      (entry) =>
        entry.profile.closingScore >= 60 &&
        entry.profile.windows.length > 0 &&
        Math.min(...entry.profile.windows.map(([start]) => start)) >= 16 * 60,
      (entry) => entry.profile.closingScore + heroValue(entry) * 0.01,
    );
  }
  const opening = [gateway, sunrise, market].filter(
    Boolean,
  ) as Entry[];
  const closing = [sunset, night].filter(Boolean) as Entry[];
  if (!closing.length && late) closing.push(late);
  let middle = entries.filter((entry) => !used.has(entry.place.id));
  // 上午限定型点位（寺庙后山等）当开场锚，但只有一天里另有下午内容或没有收尾锚时才用，
  // 避免出现“只逛一小时然后干等日落”的空壳日。
  const morning = takeBest(
    entries,
    used,
    (entry) =>
      entry.profile.morningOnly &&
      !entry.profile.sunrise &&
      !entry.profile.marketMorning &&
      !entry.profile.gateway,
    (entry) => heroValue(entry),
  );
  if (morning) {
    opening.push(morning);
    middle = middle.filter((entry) => entry !== morning);
  }

  return {
    opening,
    middle,
    closing,
    startMin: frameStart(opening, middle, closing, input),
  };
}

function frameStart(
  opening: Entry[],
  middle: Entry[],
  closing: Entry[],
  input: ComposeInput,
): number {
  const raw = frameStartRaw(opening, middle, closing, input);
  const baseStart = input.baseStart ?? PACES[input.pace].startMin;
  // 只要这一天还有「早上进得去」的点，出发就不该晚过 LATEST_START。
  // 原来几个分支是直接 return 的，封顶被绕过，于是仍会排出 11 点出门的一天。
  const morningPossible = [...opening, ...middle, ...closing].some((entry) =>
    entry.profile.windows.some(([start]) => start <= 10 * 60 + 30),
  );
  if (!morningPossible) return raw;
  return Math.min(raw, Math.max(baseStart, LATEST_START[input.pace]));
}

function frameStartRaw(
  opening: Entry[],
  middle: Entry[],
  closing: Entry[],
  input: ComposeInput,
): number {
  const baseStart = input.baseStart ?? PACES[input.pace].startMin;
  if (opening.some((entry) => entry.profile.sunrise)) {
    return Math.max(5 * 60, Math.min(baseStart, 6 * 60));
  }
  if (opening.some((entry) => entry.profile.marketMorning)) {
    return Math.min(
      baseStart,
      input.pace === "chill" ? 8 * 60 : 7 * 60 + 30,
    );
  }
  if (opening.some((entry) => entry.profile.gateway)) {
    return Math.min(baseStart, 7 * 60 + 30);
  }
  if (opening.some((entry) => entry.profile.morningOnly)) {
    return Math.max(7 * 60, Math.min(baseStart, 9 * 60));
  }
  const firstClosing = closing[0];
  if (!firstClosing) {
    const first = opening[0] ?? middle[0];
    return first
      ? startForFirst(first.profile, input.pace, baseStart)
      : baseStart;
  }
  // 植物园这类半天型大景，早上开门那段比午后更值钱：
  // 先走完大景再去接日落，别把四小时耗到天黑。
  const earlyLongStay = middle
    .filter((entry) => entry.profile.longStay)
    .flatMap((entry) => entry.profile.windows.map(([start]) => start))
    .filter((start) => start >= 8 * 60 && start <= 10 * 60);
  if (earlyLongStay.length) {
    return Math.max(baseStart, Math.min(...earlyLongStay));
  }
  // 收尾日如果中间有“上午十点前后才进入状态”的点（如厦大预约档），
  // 从那个窗口开始，比一律右对齐到傍晚更接近真实攻略。
  const morningish = middle
    .flatMap((entry) => entry.profile.windows.map(([start]) => start))
    .filter((start) => start >= 9 * 60 + 30 && start <= 11 * 60 + 30);
  if (morningish.length) {
    return Math.max(baseStart, Math.min(...morningish));
  }
  const prefix = advance(input.hotel, 0, 0, [...opening, ...middle], input);
  const pre =
    prefix.clock +
    rhythmTravelMinutes(prefix.prev, firstClosing.place, input);
  const aligned = Math.min(14 * 60 + 30, closingTarget(firstClosing) - pre);
  // 午饭是要花掉一小时的。围绕半天型大景（集美、植物园这类）排的收尾日，
// 右对齐出来的出发时间如果正好在饭点，得先把午饭扣出来，
// 否则午饭会把下午整体往后顶，主景一路拖到天黑，傍晚收尾就更晚了。
  const spansLunch =
    aligned >= 11 * 60 &&
    aligned < 13 * 60 &&
    middle.some((entry) => entry.profile.longStay);
  const mealReserve = spansLunch ? 60 + PACES[input.pace].bufferMin : 0;
  return Math.max(baseStart, aligned - mealReserve);
}

function orderMiddle(
  middle: Entry[],
  opening: Entry[],
  closing: Entry[],
  startMin: number,
  input: ComposeInput,
): Entry[] {
  if (middle.length <= 1) return [...middle];
  const buffer = PACES[input.pace].bufferMin;
  const prefix = advance(input.hotel, startMin, 0, opening, input);
  const n = middle.length;
  const beamLimit = n <= 7 ? Number.POSITIVE_INFINITY : 2400;

  let beams: ComposeState[] = [
    {
      order: [],
      prev: prefix.prev,
      clock: prefix.clock,
      score: prefix.score,
      used: new Set<string>(),
    },
  ];
  for (let depth = 0; depth < n; depth++) {
    const next: ComposeState[] = [];
    for (const state of beams) {
      for (const entry of middle) {
        if (state.used.has(entry.place.id)) continue;
        const minutes = rhythmTravelMinutes(state.prev, entry.place, input);
        const arrival = state.clock + minutes;
        next.push({
          order: [...state.order, entry],
          prev: entry.place,
          clock:
            arrival +
            rhythmDwell(entry.place, input.city, input.pace, input.styles) +
            buffer,
          score:
            state.score +
            placeDistance(state.prev, entry.place) * 0.22 +
            minutes * 0.01 +
            bandPenalty(entry.profile, arrival),
          used: new Set([...state.used, entry.place.id]),
        });
      }
    }
    next.sort((a, b) => a.score - b.score);
    beams = Number.isFinite(beamLimit) ? next.slice(0, beamLimit) : next;
  }

  let best: ComposeState | null = null;
  let bestTotal = Infinity;
  for (const state of beams) {
    if (state.order.length !== n) continue;
    const tail = advance(state.prev, state.clock, state.score, closing, input);
    const last = tail.prev;
    const backMinutes = rhythmTravelMinutes(last, input.hotel, input);
    const total =
      tail.score +
      placeDistance(last, input.hotel) * 0.22 +
      backMinutes * 0.01 +
      hardPenalty([...opening, ...state.order, ...closing]);
    if (total < bestTotal) {
      bestTotal = total;
      best = state;
    }
  }
  return best?.order ?? [...middle];
}

function buildOrder(
  entries: Entry[],
  input: ComposeInput,
): { order: Entry[]; startMin: number } {
  if (entries.length <= 1) {
    return {
      order: [...entries],
      startMin: entries[0]
        ? startForFirst(
            entries[0].profile,
            input.pace,
            input.baseStart ?? PACES[input.pace].startMin,
          )
        : input.baseStart ?? PACES[input.pace].startMin,
    };
  }
  const frame = buildFrame(entries, input);
  if (!frame.opening.length && !frame.closing.length) {
    const baseStart = input.baseStart ?? PACES[input.pace].startMin;
    // 原来的候选里固定带着 12:00 / 13:00 / 14:00，而评估只看「早到要等多久」，
    // 于是越晚出发分越高，最后排出一版 11 点出门的「充实」行程。
    // 只有整天都是日落/夜市型点位时，下午出门才成立。
    const lateOnly = entries.every(
      (entry) => entry.profile.sunset || entry.profile.nightStreet,
    );
    const candidates = new Set<number>([baseStart]);
    if (lateOnly) {
      candidates.add(12 * 60);
      candidates.add(13 * 60);
      candidates.add(14 * 60);
    }
    for (const entry of entries) {
      const open = entry.profile.windows[0]?.[0];
      if (open === undefined || open < 8 * 60) continue;
      // 点位开门晚可以顺着它推迟，但推到 LATEST_START 就封顶。
      if (lateOnly) {
        if (open <= 15 * 60) candidates.add(Math.max(baseStart, open));
      } else if (open <= LATEST_START[input.pace]) {
        candidates.add(open);
      }
    }
    let best: { order: Entry[]; startMin: number; total: number } | null =
      null;
    for (const startMin of candidates) {
      const result = plainSearch(entries, input, startMin);
      if (!best || result.total < best.total) {
        best = { order: result.order, startMin, total: result.total };
      }
    }
    return {
      order: best?.order ?? [...entries],
      startMin: best?.startMin ?? baseStart,
    };
  }
  const middle = orderMiddle(
    frame.middle,
    frame.opening,
    frame.closing,
    frame.startMin,
    input,
  );
  return {
    order: [...frame.opening, ...middle, ...frame.closing],
    startMin: frameStart(frame.opening, middle, frame.closing, input),
  };
}

export function composeDay(input: ComposeInput): ComposedDay {
  const entries: Entry[] = input.places.map((place) => ({
    place,
    profile: rhythmOf(input.city, place),
  }));
  if (!entries.length) {
    return {
      places: [],
      protectedIds: [],
      rhythm: {},
      warnings: [],
    };
  }
  if (input.fixed) {
    const summary = summarizeOrder(entries, input);
    return {
      places: input.places,
      ...summary,
      warnings: [],
    };
  }
  const built = buildOrder(entries, input);
  const summary = summarizeOrder(built.order, input, built.startMin);
  return {
    places: built.order.map((entry) => entry.place),
    ...summary,
  };
}
