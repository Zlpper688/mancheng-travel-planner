import { PACES } from "../../constants";
import type { DayRhythm, PaceId, StopPlan } from "../../types";
import { pickHero, type Entry } from "./compose";
import { rhythmOf } from "./profile";

export interface DayNarrative {
  strategy: string;
  heroId?: string;
  heroName?: string;
  rhythm: DayRhythm;
}

function groupLabel(
  entries: Entry[],
  band: "early" | "morning" | "noon" | "afternoon" | "evening" | "night",
): string {
  const names = entries.map((entry) => entry.place.name);
  const hasSunrise = entries.some((entry) => entry.profile.sunrise);
  const hasSunset = entries.some((entry) => entry.profile.sunset);
  const market = entries.find((entry) => entry.profile.marketMorning);
  switch (band) {
    case "early":
      return hasSunrise
        ? `天没亮就出发，去${names.join("、")}看日出`
        : `一早去${names.join("、")}`;
    case "morning": {
      if (market) {
        const rest = names.filter((name) => name !== market.place.name);
        const tail = rest.length ? `，再去${rest.join("、")}` : "";
        return `早上去${market.place.name}吃早饭${tail}`;
      }
      return `上午去${names.join("、")}`;
    }
    case "noon": {
      const indoor = entries.some((entry) => entry.profile.indoor);
      return indoor
        ? `中午去${names.join("、")}避热`
        : `中午去${names.join("、")}`;
    }
    case "afternoon":
      return `午后去${names.join("、")}`;
    case "evening":
      return hasSunset
        ? `傍晚去${names.join("、")}看日落`
        : `傍晚去${names.join("、")}`;
    default:
      return `晚上去${names.join("、")}`;
  }
}

export function describeDay(
  stops: StopPlan[],
  city: string,
  pace: PaceId,
  heroId?: string,
): DayNarrative {
  const sights = stops.filter((stop) => stop.kind === "sight");
  const entries: Entry[] = sights.map((stop) => ({
    place: stop.place,
    profile: rhythmOf(city, stop.place),
  }));
  // 与选点阶段保持一致：夜市/短停不挂“主景”，否则白天的海景会被夜街盖掉。
  const hero = pickHero(entries, heroId);

  let indoorMidday = false;
  let sunrise = false;
  let sunset = false;
  let night = false;
  const groups = new Map<
    "early" | "morning" | "noon" | "afternoon" | "evening" | "night",
    Entry[]
  >();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const start = sights[index].startMin;
    if (entry.profile.indoor && start >= 11 * 60 && start <= 15 * 60 + 30) {
      indoorMidday = true;
    }
    if (entry.profile.sunrise && start < 8 * 60 + 30) sunrise = true;
    if (entry.profile.sunset && start >= 15 * 60) sunset = true;
    if (entry.profile.nightStreet && start >= 17 * 60) night = true;
    const band =
      start < 7 * 60 + 30
        ? "early"
        : start < 11 * 60
          ? "morning"
          : start < 13 * 60 + 30
            ? "noon"
            : start < 16 * 60 + 30
              ? "afternoon"
              : start < 18 * 60 + 30
                ? "evening"
                : "night";
    const list = groups.get(band) ?? [];
    list.push(entry);
    groups.set(band, list);
  }

  const order = [
    "early",
    "morning",
    "noon",
    "afternoon",
    "evening",
    "night",
  ] as const;
  // 一句话里每个地方只该出现一次。长景点被午饭切成两段后，同一天会在两个时段
  // 各出现一次（上午逛一半、午后接着逛），照搬就成了「上午去鼓浪屿 → 中午去鼓浪屿」。
  const seen = new Set<string>();
  const segments: string[] = [];
  for (const band of order) {
    const all = groups.get(band);
    if (!all?.length) continue;
    const fresh: Entry[] = [];
    for (const entry of all) {
      if (seen.has(entry.place.id)) continue;
      if (fresh.some((item) => item.place.id === entry.place.id)) continue;
      fresh.push(entry);
      seen.add(entry.place.id);
    }
    if (fresh.length) segments.push(groupLabel(fresh, band));
  }

  const firstStart = sights[0]?.startMin;
  return {
    strategy: segments.length
      ? segments.join(" → ")
      : "今天留白，睡到自然醒，在酒店附近随意走走。",
    heroId: hero?.place.id,
    heroName: hero?.place.name,
    rhythm: {
      sunrise: sunrise || undefined,
      sunset: sunset || undefined,
      early:
        Boolean(sunrise) ||
        Boolean(
          firstStart !== undefined && firstStart < PACES[pace].startMin - 15,
        ) ||
        Boolean(entries.some((entry) => entry.profile.marketMorning)) ||
        undefined,
      night: night || undefined,
      indoorMidday: indoorMidday || undefined,
    },
  };
}