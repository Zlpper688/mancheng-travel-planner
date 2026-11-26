import { minutesToTime } from "./geo";
import type { PlanResult } from "./types";

/**
 * 旅行记录（宪法 C 闭环）：去了哪、看了什么、花了多少，可保存、可分享、
 * 别人能一键导入同款。
 *
 * 设计约束：
 * 1. 不做账号 —— 全部存 localStorage，换设备不同步（宪法第 11 节）。
 * 2. 自动归档优先 —— 存的是计划快照，不需要用户手写；`note` 只留一句可选感想。
 * 3. 分享出去的是「配方 + 摘要」，别人打开能直接重排同款（复用 share.ts 的 recipe）。
 * 4. 记录不是一次性消耗品，是可复用的模板（宪法第 9 节复利点）。
 */
const STORAGE_KEY = "mancheng.journals.v1";
const MAX_JOURNALS = 50;

export interface JournalStop {
  name: string;
  /** "09:30-10:30" */
  time: string;
  category: string;
  kind: string;
}

export interface JournalDay {
  index: number;
  date: string;
  theme: string;
  area: string;
  stops: JournalStop[];
  sightCount: number;
  distanceKm: number;
}

export interface TripJournal {
  id: string;
  savedAt: string;
  title: string;
  city: string;
  startDate: string;
  endDate: string;
  days: number;
  travelers: number;
  /** share.ts 的 encodeRecipe 输出，用于「再走一遍」。 */
  recipe: string;
  daySnapshots: JournalDay[];
  budget: {
    totalMin: number;
    totalMax: number;
    perPersonMin: number;
    perPersonMax: number;
  };
  /** 用户可选写一句感受；不写也能保存。 */
  note?: string;
  /** 预留：实际打卡过的点位 id。第一版不做 UI，字段先留着。 */
  visitedPlaceIds?: string[];
}

function safeParse(raw: string | null): TripJournal[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (item): item is TripJournal =>
        Boolean(item) && typeof item === "object" && typeof item.id === "string",
    );
  } catch {
    return [];
  }
}

export function loadJournals(): TripJournal[] {
  if (typeof window === "undefined") return [];
  return safeParse(window.localStorage.getItem(STORAGE_KEY)).sort((a, b) =>
    b.savedAt.localeCompare(a.savedAt),
  );
}

export function saveJournal(journal: TripJournal): TripJournal[] {
  if (typeof window === "undefined") return [];
  const current = loadJournals();
  // 同一天同一城市同一标题的记录覆盖，避免反复点「记下这趟」刷出一堆重复。
  const key = `${journal.city}|${journal.startDate}|${journal.title}`;
  const next = [
    journal,
    ...current.filter((j) => `${j.city}|${j.startDate}|${j.title}` !== key),
  ].slice(0, MAX_JOURNALS);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function deleteJournal(id: string): TripJournal[] {
  if (typeof window === "undefined") return [];
  const next = loadJournals().filter((j) => j.id !== id);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function updateJournalNote(id: string, note: string): TripJournal[] {
  if (typeof window === "undefined") return [];
  const next = loadJournals().map((j) =>
    j.id === id ? { ...j, note: note.slice(0, 200) || undefined } : j,
  );
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

/** 把一次排好的行程转成记录（自动归档，不需要用户填表）。 */
export function journalFromPlan(
  plan: PlanResult,
  recipe: string,
): TripJournal {
  const daySnapshots: JournalDay[] = plan.days.map((day) => ({
    index: day.index,
    date: day.date,
    theme: day.theme,
    area: day.area,
    stops: day.stops.map((stop) => ({
      name: stop.place.name,
      time: `${minutesToTime(stop.startMin)}-${minutesToTime(stop.endMin)}`,
      category: stop.place.category,
      kind: stop.kind,
    })),
    sightCount: day.stats.sightCount,
    distanceKm: Math.round(day.stats.distanceKm * 10) / 10,
  }));
  return {
    id: `j-${Date.now().toString(36)}`,
    savedAt: new Date().toISOString(),
    title: plan.meta.title,
    city: plan.meta.city,
    startDate: plan.meta.startDate,
    endDate: plan.meta.endDate,
    days: plan.meta.days,
    travelers: plan.meta.travelers,
    recipe,
    daySnapshots,
    budget: {
      totalMin: plan.budget.totalMin,
      totalMax: plan.budget.totalMax,
      perPersonMin: plan.budget.perPersonMin,
      perPersonMax: plan.budget.perPersonMax,
    },
  };
}

function monthDay(date: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) return date;
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

/**
 * 记录转成能粘进微信的纯文本。
 * 和 formatPlanText 的区别：这里是「我去过什么」，不是「接下来怎么走」，
 * 所以按天列点位、结尾给同款链接，别人点开能直接排一样的。
 */
export function formatJournalText(
  journal: TripJournal,
  shareUrl?: string,
): string {
  const lines: string[] = [];
  lines.push(`【${journal.title}】`);
  const range =
    journal.startDate === journal.endDate
      ? monthDay(journal.startDate)
      : `${monthDay(journal.startDate)}–${monthDay(journal.endDate)}`;
  lines.push(`${range} · ${journal.days} 天 · ${journal.travelers} 人`);
  lines.push("");
  for (const day of journal.daySnapshots) {
    const sights = day.stops.filter((s) => s.kind === "sight").map((s) => s.name);
    lines.push(`Day ${day.index} · ${monthDay(day.date)}${day.theme ? ` · ${day.theme}` : ""}`);
    if (sights.length) lines.push(`  ${sights.join(" → ")}`);
    else lines.push("  自由活动");
    if (day.distanceKm > 0) {
      lines.push(`  约 ${day.distanceKm} 公里 · ${day.sightCount} 个景点`);
    }
  }
  const yuan = (v: number) => Math.round(v).toLocaleString("zh-CN");
  lines.push("");
  lines.push(
    `花费：${journal.travelers} 人 ¥${yuan(journal.budget.totalMin)}–${yuan(journal.budget.totalMax)}（人均 ¥${yuan(journal.budget.perPersonMin)}–${yuan(journal.budget.perPersonMax)}）`,
  );
  if (journal.note) lines.push(`感受：${journal.note}`);
  if (shareUrl) {
    lines.push("");
    lines.push(`同款玩法：${shareUrl}`);
  }
  return lines.join("\n");
}
