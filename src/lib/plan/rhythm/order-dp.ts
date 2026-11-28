/**
 * 带时间窗的日内排序（精确 DP）。
 *
 * 原来的顺序是 beam search 贪出来的：一路挑「当前最省」的下一个点，
 * 于是日落点经常被挤到天黑之后，再由 scheduleDay 事后剔除补救——
 * 那是补丁，不是排线。这里从源头算：把一天的 N 个点位当成
 * 「带时间窗的路径问题」，N ≤ 10 时用 bitmask DP 求全局最优。
 *
 * 为什么是 DP 而不是别的：
 *   N=8 时状态空间是 2^8 × 8 = 2048 个 (已访问集合, 当前点)，
 *   每个状态再枚举下一个点，总共约 1.6 万次转移，亚毫秒完成。
 *   这个规模下没理由用启发式——它给出的是全局最优，不是「看起来还行」。
 *
 * 目标函数（统一到分钟量级，方便和体力、人流放在一起比较）：
 *   路程 ×1 + 等待 ×1.6 + 时段不符 ×6 + 人流 ×5 + 体力不支 ×1
 * 权重有依据：等 10 分钟比坐 10 分钟车更难受（×1.6）；
 * 把日落排到 20 点是这一天最严重的错误（bandPenalty 本身是小时量级，×6 足以压过任何路程优化）。
 */
import { PACES } from "../../constants";
import type { PaceId, Place, StyleId, TransportPref } from "../../types";
import { crowdOf, crowdPenaltyAt, type CrowdWindow } from "../crowd";
import { energyDelta, energyPenalty, initialEnergy, timeDrain } from "../energy";
import { steepnessOf } from "../strenuous";
import {
  bandPenalty,
  rhythmDwell,
  rhythmOf,
  rhythmTravelMinutes,
  type RhythmProfile,
  type TravelContext,
} from "./profile";

export interface DpStop {
  place: Place;
  profile: RhythmProfile;
  dwellMin: number;
  crowd: CrowdWindow;
  /** 访问一次的能量变化（负数 = 消耗） */
  energy: number;
}

export interface OrderInput {
  hotel: Place;
  stops: DpStop[];
  startMin: number;
  city: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  dayIndex: number;
  /** 全天收尾锚点（日落/夜市）；只用于算「最后一个中间点去那儿」的路程。 */
  tail?: Place;
  /** 出行人的起点体力，不传按 dayIndex/startMin 推。 */
  energyStart?: number;
}

export interface OrderResult {
  order: DpStop[];
  /** 归一化后的总代价（分钟量级），只用于比较不同起点，不对外展示 */
  cost: number;
  waitMin: number;
}

const WEIGHT = {
  travel: 1,
  wait: 1.6,
  band: 6,
  crowd: 5,
  energy: 1,
  /** 收尾路程权重略低：顺路回去是常态，不该为少坐 10 分钟车把顺序拧坏。 */
  tailTravel: 0.8,
} as const;

/** 最多 10 个点用精确解；再多交给上游启发式，避免 2^n 爆掉。 */
export const DP_MAX_STOPS = 10;

export function dpStopsOf(
  places: Place[],
  input: {
    city: string;
    pace: PaceId;
    styles: StyleId[];
    transport: TransportPref;
  },
): DpStop[] {
  return places.map((place) => {
    const profile = rhythmOf(input.city, place);
    const dwellMin = rhythmDwell(place, input.city, input.pace, input.styles);
    return {
      place,
      profile,
      dwellMin,
      crowd: crowdOf(place),
      // 体力在排序阶段就要参与，否则「把爬山放上午」只是句口号。
      energy: energyDelta(
        place,
        input.city,
        dwellMin,
        steepnessOf(input.city, place),
      ),
    };
  });
}

/** 只为「开门还差一会儿」等：最多 45 分钟。更长的空等交给 bandPenalty 去罚。 */
function waitsFor(profile: RhythmProfile, arrivalMin: number): number {
  let best = 0;
  for (const [start] of profile.windows) {
    const gap = start - arrivalMin;
    if (gap > 0 && gap <= 45) best = best === 0 ? gap : Math.min(best, gap);
  }
  return best;
}

interface State {
  cost: number;
  clock: number;
  wait: number;
  /** 从哪个状态走过来（用于还原顺序），起点为 null。 */
  parent: State | null;
  /** 当前状态停在第几个点位（-1 表示还没出门）。 */
  index: number;
}

interface Bucket {
  /** 代价最低 */
  cheapest?: State;
  /** 结束最早 */
  earliest?: State;
}

/**
 * 精确求解。返回的 order 一定是 stops 的一个排列。
 *
 * 每个 (已访问集合, 当前点) 只留两条 Pareto 路径：代价最低 + 结束最早。
 * 只留代价最低会漏掉「多花 5 分钟、早到 40 分钟」的解，
 * 而那 40 分钟恰恰是能不能赶上日落的关键。
 */
export function orderWithTimeWindows(input: OrderInput): OrderResult {
  const stops = input.stops;
  const n = stops.length;
  if (n === 0) return { order: [], cost: 0, waitMin: 0 };
  if (n === 1) return { order: [...stops], cost: 0, waitMin: 0 };
  if (n > DP_MAX_STOPS) return { order: [...stops], cost: 0, waitMin: 0 };

  const travelCtx: TravelContext = {
    city: input.city,
    styles: input.styles,
    transport: input.transport,
  };
  const buffer = PACES[input.pace].bufferMin;
  const energyStart =
    input.energyStart ??
    initialEnergy({
      startMin: input.startMin,
      dayIndex: input.dayIndex,
      pace: input.pace,
    });

  // 路程矩阵：0 = 酒店，1..n = 各点位，n+1 = 收尾点（如有）。
  const points: Place[] = [input.hotel, ...stops.map((stop) => stop.place)];
  if (input.tail) points.push(input.tail);
  const tailIndex = n + 1;
  const travel: number[][] = points.map((from) =>
    points.map((to) => (from === to ? 0 : rhythmTravelMinutes(from, to, travelCtx))),
  );

  // 体力对同一访问集合是确定的（delta 只与点位和停留有关），可以直接由 mask 推出，
  // 不必把体力塞进 DP 状态——那会让状态数量翻几十倍。
  const energyOfMask = new Float64Array(1 << n);
  for (let mask = 1; mask < 1 << n; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    energyOfMask[mask] = energyOfMask[mask & (mask - 1)] + stops[low].energy;
  }
  const energyAt = (mask: number) =>
    Math.max(0, Math.min(100, energyStart + energyOfMask[mask]));

  const full = (1 << n) - 1;
  const table: Bucket[][] = Array.from({ length: 1 << n }, () =>
    Array.from({ length: n }, () => ({}) as Bucket),
  );

  const costOfArrival = (
    stop: DpStop,
    arrivalMin: number,
    wait: number,
    minutes: number,
    energy: number,
  ) => {
    // 到得越晚，实际体力越低：除了点位消耗，一直待在外面本身也在耗。
    // 不扣这一项，DP 会认为「下午两点和上午九点体力一样」，
    // 于是把爬山往下午推——正是要避免的那种排法。
    const spent = Math.max(0, energy - timeDrain(input.startMin, arrivalMin + wait));
    return (
      minutes * WEIGHT.travel +
      wait * WEIGHT.wait +
      bandPenalty(stop.profile, arrivalMin + wait) * WEIGHT.band +
      crowdPenaltyAt(stop.crowd, arrivalMin + wait, stop.dwellMin) * WEIGHT.crowd +
      energyPenalty(spent, stop.place, input.city) * WEIGHT.energy
    );
  };

  const push = (mask: number, index: number, state: State) => {
    const bucket = table[mask][index];
    const cheapest = bucket.cheapest;
    const earliest = bucket.earliest;
    // 被已有解完全支配（又贵又不早）就直接丢掉。
    if (
      cheapest &&
      earliest &&
      cheapest.cost <= state.cost &&
      earliest.clock <= state.clock
    ) {
      return;
    }
    if (!cheapest || state.cost < cheapest.cost) bucket.cheapest = state;
    if (!bucket.earliest || state.clock < bucket.earliest.clock) {
      bucket.earliest = state;
    }
  };

  // 第一步：从酒店出发。
  for (let index = 0; index < n; index++) {
    const stop = stops[index];
    const minutes = travel[0][index + 1];
    const arrival = input.startMin + minutes;
    const wait = waitsFor(stop.profile, arrival);
    push(1 << index, index, {
      cost: costOfArrival(stop, arrival, wait, minutes, energyStart),
      clock: arrival + wait + stop.dwellMin + buffer,
      wait,
      parent: null,
      index,
    });
  }

  for (let mask = 1; mask < 1 << n; mask++) {
    const energyAfter = energyAt(mask);
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const bucket = table[mask][last];
      const sources = new Set<State>();
      if (bucket.cheapest) sources.add(bucket.cheapest);
      if (bucket.earliest) sources.add(bucket.earliest);
      for (const state of sources) {
        for (let next = 0; next < n; next++) {
          if (mask & (1 << next)) continue;
          const stop = stops[next];
          const minutes = travel[last + 1][next + 1];
          const arrival = state.clock + minutes;
          const wait = waitsFor(stop.profile, arrival);
          push(mask | (1 << next), next, {
            cost:
              state.cost +
              costOfArrival(stop, arrival, wait, minutes, energyAfter),
            clock: arrival + wait + stop.dwellMin + buffer,
            wait: state.wait + wait,
            parent: state,
            index: next,
          });
        }
      }
    }
  }

  let best: State | null = null;
  for (let last = 0; last < n; last++) {
    const bucket = table[full][last];
    const target = input.tail ? tailIndex : 0;
    for (const state of [bucket.cheapest, bucket.earliest]) {
      if (!state) continue;
      const back = travel[last + 1][target];
      const total = state.cost + back * WEIGHT.tailTravel;
      if (!best || total < best.cost) best = { ...state, cost: total };
    }
  }
  if (!best) return { order: [...stops], cost: 0, waitMin: 0 };

  const order: DpStop[] = [];
  let cursor: State | null = best;
  while (cursor) {
    order.push(stops[cursor.index]);
    cursor = cursor.parent;
  }
  return { order: order.reverse(), cost: best.cost, waitMin: best.wait };
}
