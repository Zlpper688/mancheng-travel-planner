import { BUDGET_TIERS, PACES, TRANSPORT_OPTIONS } from "@/lib/constants";
import { todayISOLocal } from "@/lib/geo";
import { makeDraft } from "./draft";
import type { ChatDraft } from "./types";

/**
 * 把客户端传来的草稿安全地规范化。所有字段都要从 raw 恢复并用白名单/边界校验，
 * 不能用 base 默认值蒙混——否则前端选了「松弛/地铁/舒适/已定酒店」，
 * 服务端看到的还是初始值，模型据此生成自相矛盾的回复（前后端状态漂移）。
 * 抽成独立模块是为了可回归测试，route 里内联无法覆盖。
 */

function clip(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function coord(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(Math.min(max, Math.max(min, parsed)) * 1e6) / 1e6;
}

export function safeDraft(raw: unknown): ChatDraft {
  const base = makeDraft(todayISOLocal());
  if (!raw || typeof raw !== "object") return base;
  const record = raw as Record<string, unknown>;
  const city = (record.city ?? {}) as Record<string, unknown>;
  const hotel = (record.hotel ?? {}) as Record<string, unknown>;
  const confirmed = (record.confirmed ?? {}) as Record<string, unknown>;
  const bool = (key: string) => confirmed[key] === true;
  const places = Array.isArray(record.selectedPlaces) ? record.selectedPlaces : [];

  return {
    ...base,
    city: {
      name: clip(city.name, 30, base.city.name),
      lat: coord(city.lat, base.city.lat, -90, 90),
      lng: coord(city.lng, base.city.lng, -180, 180),
      address: clip(city.address, 80, base.city.address ?? ""),
    },
    hotel: {
      ...base.hotel,
      id: clip(hotel.id, 80, base.hotel.id),
      name: clip(hotel.name, 40, base.hotel.name),
      lat: coord(hotel.lat, base.hotel.lat, -90, 90),
      lng: coord(hotel.lng, base.hotel.lng, -180, 180),
      address: clip(hotel.address, 80, base.hotel.address ?? ""),
    },
    hotelUndecided:
      record.hotelUndecided === undefined
        ? base.hotelUndecided
        : record.hotelUndecided === true,
    pace: Object.prototype.hasOwnProperty.call(PACES, String(record.pace))
      ? (record.pace as ChatDraft["pace"])
      : base.pace,
    transport: TRANSPORT_OPTIONS.some((option) => option.id === record.transport)
      ? (record.transport as ChatDraft["transport"])
      : base.transport,
    budgetTier: Object.prototype.hasOwnProperty.call(
      BUDGET_TIERS,
      String(record.budgetTier),
    )
      ? (record.budgetTier as ChatDraft["budgetTier"])
      : base.budgetTier,
    days: number(record.days, base.days, 1, 10),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(record.date ?? ""))
      ? String(record.date)
      : base.date,
    adults: number(record.adults, base.adults, 0, 9),
    children: number(record.children, base.children, 0, 9),
    seniors: number(record.seniors, base.seniors, 0, 9),
    avoidSteep: record.avoidSteep === true,
    notes: clip(record.notes, 200, ""),
    styles: Array.isArray(record.styles)
      ? (record.styles.filter((item) => typeof item === "string") as ChatDraft["styles"]).slice(0, 3)
      : base.styles,
    experiences: Array.isArray(record.experiences)
      ? (record.experiences.filter((item) => typeof item === "string") as ChatDraft["experiences"]).slice(0, 4)
      : base.experiences,
    selectedPlaces: places
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      .slice(0, 12)
      .map((item) => ({
        ...base.hotel,
        id: clip(item.id, 80, "picked"),
        name: clip(item.name, 40, "自选点"),
        lat: coord(item.lat, base.hotel.lat, -90, 90),
        lng: coord(item.lng, base.hotel.lng, -180, 180),
        address: clip(item.address, 80, ""),
        category: "attraction" as const,
        source: "demo" as const,
      })),
    confirmed: {
      city: bool("city"),
      date: bool("date"),
      party: bool("party"),
      style: bool("style"),
      pace: bool("pace"),
      transport: bool("transport"),
      hotel: bool("hotel"),
    },
  };
}
