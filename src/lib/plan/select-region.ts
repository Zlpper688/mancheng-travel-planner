import type { Place } from "../types";
import { segmentPlaces, type RouteSegment } from "./segments";
import { selectDays, type DaySeed, type SelectInput, type SelectResult } from "./select";
import type { PlanParams } from "./params";

/**
 * 区域环线选点：把景点按地理分段，每段独立跑一次 selectDays，
 * 每段的 hotel/center 用段中心，半径覆盖段内跨度。
 *
 * 这样喀纳斯、禾木不再是"离乌鲁木齐 545km 的远足点"（会被 farReachKm 裁掉），
 * 而是"阿勒泰段自己的近处景点"，远足规则在段内正常工作。
 *
 * 返回结构与 selectDays 完全一致，engine 侧只需按 form 切换调用。
 */
export function selectRegionDays(
  input: SelectInput,
  params: PlanParams,
): SelectResult {
  const days = Math.max(1, input.days);
  // 只取有坐标的景点；餐食/酒店不参与分段（它们由各天的 schedule 就近补）。
  const sights = input.sights.filter(
    (p) =>
      Number.isFinite(p.lng) &&
      Number.isFinite(p.lat) &&
      !["food", "cafe", "hotel", "other"].includes(p.category),
  );

  // 用户点名的必去点/锁定点强制进候选，避免被分段挤掉。
  const mustIds = new Set<string>([
    ...(input.fixedPlaces ?? []).map((f) => f.place.id),
    ...(input.lockedPlaces ?? []).map((l) => l.place.id),
  ]);
  const baseList = mustIds.size
    ? [...sights, ...input.sights.filter((p) => mustIds.has(p.id))]
    : sights;
  const deduped = [...new Map(baseList.map((p) => [p.id, p])).values()];

  const segments: RouteSegment[] = segmentPlaces(
    deduped,
    days,
    input.center,
  );

  const warnings: string[] = [];
  const allDays: DaySeed[] = [];
  let farDays = 0;

  // 区域游一天走一个片区，景点本来就少而分散，城市尺度的「每天 3-4 个点」会
  // 让喀纳斯这种一整片只排 1-2 个点。段内放宽到 6-8，让段内代表性景点都进得来。
  const regionParams: PlanParams = {
    ...params,
    sightsPerDay: {
      chill: [Math.max(3, params.sightsPerDay.chill[0]), 8],
      balanced: [Math.max(4, params.sightsPerDay.balanced[0]), 8],
      packed: [Math.max(5, params.sightsPerDay.packed[0]), 10],
    },
    maxDaySpanKm: Math.max(params.maxDaySpanKm, 200),
  };

  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    const dayIndex = i + 1;
    // 段内跨度决定这一段要多大半径：至少 30km，最多 200km。
    const segmentRadius = Math.max(30, Math.min(200, seg.spanKm + 20));
    // 这一段的固定点/锁定点：只保留属于本段的。
    const segIds = new Set(seg.places.map((p) => p.id));
    const segFixed = (input.fixedPlaces ?? []).filter(
      (f) => segIds.has(f.place.id),
    );
    const segLocked = (input.lockedPlaces ?? []).filter((l) =>
      segIds.has(l.place.id),
    );

    // 段内就是「这一天在这一带」，不需要再走 selectDays 的按 anchor 分天逻辑
    // （那是为单城多天设计的，days=1 时只取 1 个 anchor，会把同段其他点判成别的片区）。
    // 直接取段内热度最高的若干点；排程时间由后面的 scheduleDay 负责。
    const perDay = Math.max(2, regionParams.sightsPerDay[input.pace][1] - 2);
    const mustFirst = [
      ...segFixed.map((f) => f.place),
      ...segLocked.map((l) => l.place),
    ];
    // 段内取样按「离段中心的距离」排序、均匀取：中心点 + 各方向远端。
    // 纯按 popularity 会全挤在段内热度最高的一个角落（白哈巴/五彩滩），
    // 把喀纳斯、禾木这类招牌晾在外面。
    const withDist = seg.places.map((p) => ({
      p,
      d: Math.hypot(p.lng - seg.center[0], p.lat - seg.center[1]),
    }));
    const spread = withDist.sort((a, b) => a.d - b.d);
    const spaced: typeof spread = [];
    for (const item of spread) {
      if (spaced.length >= perDay) break;
      // 与已选点地理上太近的跳过，保证覆盖段内不同片区
      if (spaced.some((s) => Math.hypot(s.p.lng - item.p.lng, s.p.lat - item.p.lat) < 0.25)) {
        continue;
      }
      spaced.push(item);
    }
    const ranked = spaced.map((s) => s.p);
    const picked = [...new Map(
      [...mustFirst, ...ranked].map((p) => [p.id, p]),
    ).values()].slice(0, perDay);

    const seed: DaySeed = {
      index: dayIndex,
      places: picked,
      fixed: segFixed.length > 0,
      area: seg.label,
      theme: `${seg.label}一带`,
      far: false,
      anchorIds: picked.slice(0, 1).map((p) => p.id),
    };
    allDays.push(seed);
    if (!picked.length) {
      warnings.push(`第 ${dayIndex} 段「${seg.label}」没有可用景点，留作自由活动。`);
    }
  }

  // 天数补齐：段数少于天数时，剩下的天留空（由 engine 的补位逻辑处理），
  // 不硬塞点，避免"为了填满而折返"。
  while (allDays.length < days) {
    const blank = segments[allDays.length % segments.length];
    allDays.push({
      index: allDays.length + 1,
      places: [],
      fixed: false,
      area: blank?.label ?? input.city,
      theme: "自由安排",
    });
  }

  return {
    days: allDays.slice(0, days),
    warnings: warnings.slice(0, 10),
    farDays,
  };
}
