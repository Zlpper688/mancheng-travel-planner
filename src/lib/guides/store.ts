import { promises as fs } from "node:fs";
import path from "node:path";
import type { GuideEntry, GuideIndex, GuideIndexItem, GuideRoute } from "./types";

const GUIDE_DIR = path.join(process.cwd(), "data", "guides");
const ID_PATTERN = /^g-[0-9a-f]{8}$/;

export async function readGuideIndex(): Promise<GuideIndex> {
  const raw = await fs.readFile(path.join(GUIDE_DIR, "index.json"), "utf8");
  const parsed = JSON.parse(raw) as GuideIndex;
  if (!parsed || !Array.isArray(parsed.guides)) {
    throw new Error("攻略库索引格式不正确");
  }
  return parsed;
}

export async function readGuide(id: string): Promise<GuideEntry | null> {
  if (!ID_PATTERN.test(id)) return null;
  try {
    const raw = await fs.readFile(path.join(GUIDE_DIR, `${id}.json`), "utf8");
    return JSON.parse(raw) as GuideEntry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s·•\-—_]/g, "");
}

export function matchesCity(item: GuideIndexItem, city: string): boolean {
  const query = normalize(city);
  if (!query) return true;
  return [item.city, ...item.cityAliases, item.title].some((name) => {
    const value = normalize(name);
    return value.length >= 2 && (value.includes(query) || query.includes(value));
  });
}

export function pickRoute(guide: GuideEntry, routeId?: string | null): GuideRoute | null {
  if (routeId) {
    const picked = guide.routes.find((route) => route.id === routeId);
    if (picked) return picked;
  }
  return (
    guide.routes.find((route) => route.id === guide.canonicalRouteId) ??
    guide.routes[0] ??
    null
  );
}

export function routeToText(route: GuideRoute): string {
  return route.days
    .map((day) => `D${day.day} ${day.stops.map((stop) => stop.name).join("，")}`)
    .join("\n");
}