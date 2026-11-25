import { BUDGET_TIERS, PACES, STYLES, TRANSPORT_OPTIONS } from "./constants";
import { minutesToTime } from "./geo";
import type {
  BudgetTier,
  CityOption,
  PaceId,
  Place,
  PlanResult,
  StyleId,
  TransportPref,
} from "./types";

/**
 * 行程的「配方」：足够复现同一版结果的最小信息集合。
 *
 * 刻意不含 lockedPlaces / excludeIds / fixedPlaces —— 那是用户在这一次
 * 会话里的微调，不是他要分享的东西；而且锁定点需要完整 Place 对象，
 * 塞进 URL 会长到没法看。分享的是「城市 + 落脚点 + 偏好 + seed」。
 */
export type TripRecipe = {
  city: CityOption;
  hotel: Place;
  days: number;
  date: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  budgetTier: BudgetTier;
  adults: number;
  children: number;
  seed: number;
  farDays: number | null;
};

const PACE_IDS = Object.keys(PACES) as PaceId[];
const STYLE_IDS = STYLES.map((item) => item.id);
const TRANSPORT_IDS = TRANSPORT_OPTIONS.map((item) => item.id);
const BUDGET_IDS = Object.keys(BUDGET_TIERS) as BudgetTier[];

const MAX_SEED = 2_147_483_646;

function encodeNum(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4).replace(/\.?0+$/, "") : "";
}

function readNum(raw: string | null): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function readInt(
  raw: string | null,
  min: number,
  max: number,
): number | null {
  const value = readNum(raw);
  if (value === null) return null;
  const rounded = Math.round(value);
  return rounded >= min && rounded <= max ? rounded : null;
}

function readCoord(
  raw: string | null,
  limit: number,
): number | null {
  const value = readNum(raw);
  if (value === null || Math.abs(value) > limit) return null;
  return value;
}

function readText(raw: string | null, maxLength: number): string | null {
  if (!raw) return null;
  const text = raw.trim().slice(0, maxLength);
  return text || null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function encodeRecipe(recipe: TripRecipe): string {
  const params = new URLSearchParams();
  params.set("q", recipe.city.name);
  params.set("qx", encodeNum(recipe.city.lng));
  params.set("qy", encodeNum(recipe.city.lat));
  // 不带上地址的话，解出来的城市会退回默认城市（厦门）的地址。
  if (recipe.city.address) params.set("qa", recipe.city.address.slice(0, 60));
  params.set("h", recipe.hotel.name);
  params.set("hx", encodeNum(recipe.hotel.lng));
  params.set("hy", encodeNum(recipe.hotel.lat));
  if (recipe.hotel.address) params.set("ha", recipe.hotel.address.slice(0, 60));
  if (typeof recipe.hotel.cost === "number" && recipe.hotel.cost > 0) {
    params.set("hc", String(Math.round(recipe.hotel.cost)));
  }
  params.set("d", String(recipe.days));
  params.set("dt", recipe.date);
  params.set("p", recipe.pace);
  params.set("s", recipe.styles.join(","));
  params.set("tr", recipe.transport);
  params.set("b", recipe.budgetTier);
  params.set("a", String(recipe.adults));
  params.set("k", String(recipe.children));
  params.set("sd", String(recipe.seed));
  if (recipe.farDays) params.set("f", String(recipe.farDays));
  return params.toString();
}

/**
 * 从查询串还原配方。所有字段单独校验，坏的那个丢掉、退回默认值，
 * 不让一条被别人手改过的链接把整个页面打崩。
 */
export function decodeRecipe(
  search: string,
  fallback: TripRecipe,
): TripRecipe | null {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  );
  const cityName = readText(params.get("q"), 20);
  const hotelName = readText(params.get("h"), 40);
  if (!cityName && !hotelName) return null;

  const next: TripRecipe = { ...fallback, styles: [...fallback.styles] };

  const cityLng = readCoord(params.get("qx"), 180);
  const cityLat = readCoord(params.get("qy"), 90);
  if (cityName && cityLng !== null && cityLat !== null) {
    next.city = {
      name: cityName,
      address: readText(params.get("qa"), 60) ?? fallback.city.address,
      lng: cityLng,
      lat: cityLat,
    };
  }

  const hotelLng = readCoord(params.get("hx"), 180);
  const hotelLat = readCoord(params.get("hy"), 90);
  if (hotelName && hotelLng !== null && hotelLat !== null) {
    const address = readText(params.get("ha"), 60);
    const cost = readNum(params.get("hc"));
    next.hotel = {
      id: `shared-${hotelLng.toFixed(4)}-${hotelLat.toFixed(4)}`,
      name: hotelName,
      category: "hotel",
      lat: hotelLat,
      lng: hotelLng,
      address: address ?? undefined,
      cost: cost !== null && cost > 0 ? cost : undefined,
      source: "demo",
    };
  }

  // 我方上限是 15 天（组员版是 7），链接要让 10 天的行程也能原样恢复。
  const days = readInt(params.get("d"), 1, 15);
  if (days !== null) next.days = days;

  const date = params.get("dt");
  if (date && DATE_PATTERN.test(date)) next.date = date;

  const pace = params.get("p") as PaceId | null;
  if (pace && PACE_IDS.includes(pace)) next.pace = pace;

  const styles = params
    .get("s")
    ?.split(",")
    .map((item) => item.trim())
    .filter((item): item is StyleId => STYLE_IDS.includes(item as StyleId));
  if (styles && styles.length) next.styles = styles.slice(0, 3);

  const transport = params.get("tr") as TransportPref | null;
  if (transport && TRANSPORT_IDS.includes(transport)) {
    next.transport = transport;
  }

  const budget = params.get("b") as BudgetTier | null;
  if (budget && BUDGET_IDS.includes(budget)) next.budgetTier = budget;

  const adults = readInt(params.get("a"), 1, 9);
  if (adults !== null) next.adults = adults;

  const children = readInt(params.get("k"), 0, 6);
  if (children !== null) next.children = children;

  const seed = readInt(params.get("sd"), 1, MAX_SEED);
  if (seed !== null) next.seed = seed;

  const farDays = readInt(params.get("f"), 1, 15);
  next.farDays = farDays;

  return next;
}

/** 只取路径，丢掉旧查询串，保证分享出去的是干净地址。 */
export function buildShareUrl(recipe: TripRecipe, base?: string): string {
  const origin =
    base ??
    (typeof window === "undefined"
      ? ""
      : `${window.location.origin}${window.location.pathname}`);
  return `${origin}?${encodeRecipe(recipe)}`;
}

/**
 * 复制到剪贴板。navigator.clipboard 需要安全上下文（https 或 localhost），
 * 用 http 访问局域网 IP 时会不可用，所以留一条 textarea + execCommand 的退路。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到下面的兜底
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function monthDay(date: string): string {
  const parts = date.split("-");
  if (parts.length !== 3) return date;
  return `${Number(parts[1])}月${Number(parts[2])}日`;
}

function duration(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  if (value < 60) return `${value} 分钟`;
  const hours = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

function km(distance: number): string {
  return distance < 1
    ? `${Math.max(10, Math.round(distance * 1000))} 米`
    : `${distance.toFixed(1)} 公里`;
}

const MODE_TEXT: Record<string, string> = {
  walk: "步行",
  transit: "公交/地铁",
  taxi: "打车",
  drive: "自驾",
};

/**
 * 把行程转成能直接粘进微信的纯文本。刻意不用表格和符号装饰，
 * 因为微信、备忘录、短信里都会被压平，留着反而乱。
 */
export function formatPlanText(
  plan: PlanResult,
  hotelName: string,
  shareUrl?: string,
): string {
  const lines: string[] = [];
  lines.push(`【${plan.meta.title}】`);
  const range =
    plan.meta.startDate === plan.meta.endDate
      ? monthDay(plan.meta.startDate)
      : `${monthDay(plan.meta.startDate)}–${monthDay(plan.meta.endDate)}`;
  const summary = [`${range}`, `${plan.meta.days} 天`, `${plan.meta.travelers} 人`];
  if (plan.meta.holiday) summary.push(plan.meta.holiday.name);
  lines.push(summary.join(" · "));
  lines.push(`落脚：${hotelName}`);
  lines.push("");

  for (const day of plan.days) {
    const head = [`Day ${day.index}`, monthDay(day.date)];
    if (day.theme) head.push(day.theme);
    lines.push(head.join(" · "));
    const departLeg = day.legs[0];
    lines.push(
      `  ${minutesToTime(departLeg?.departMin ?? day.startMin)} 从酒店出发`,
    );

    day.stops.forEach((stop, index) => {
      const leg = day.legs[index];
      if (leg && index > 0) {
        const mode = MODE_TEXT[leg.mode] ?? "前往";
        const cost =
          leg.cost > 0
            ? ` · ¥${Math.round(leg.cost)}${leg.costUnit === "person" ? "/人" : "/车"}`
            : "";
        lines.push(
          `    ↓ ${mode} ${duration(leg.durationMin)} ${km(leg.distanceKm)}${cost}`,
        );
      }
      const rating = stop.place.rating
        ? `（${stop.place.rating.toFixed(1)} 分）`
        : "";
      lines.push(
        `  ${minutesToTime(stop.startMin)}–${minutesToTime(stop.endMin)} ${stop.place.name}${rating}`,
      );
    });

    const returnLeg = day.legs[day.legs.length - 1];
    if (returnLeg && day.stops.length) {
      lines.push(
        `    ↓ 回酒店 ${duration(returnLeg.durationMin)} ${km(returnLeg.distanceKm)}`,
      );
      lines.push(
        `  ${minutesToTime(returnLeg.arriveMin)} 回到酒店 · 当天 ${day.stats.stopCount} 站 · ${day.stats.distanceKm.toFixed(1)} 公里`,
      );
    }
    if (day.tip) lines.push(`  提醒：${day.tip}`);
    lines.push("");
  }

  const budget = plan.budget;
  const yuan = (value: number) => Math.round(value).toLocaleString("zh-CN");
  // items 是整单金额，perPerson 才是人均。两个数字并排写清楚，
  // 否则只看「/ 人」再对着下面几千块的餐饮会以为算错了。
  lines.push(
    `预算：${budget.travelers} 人合计 ¥${yuan(budget.totalMin)}–${yuan(budget.totalMax)}（人均 ¥${yuan(budget.perPersonMin)}–${yuan(budget.perPersonMax)}）`,
  );
  for (const item of budget.items) {
    const rangeText =
      Math.abs(item.max - item.min) < 1
        ? `¥${yuan(item.min)}`
        : `¥${yuan(item.min)}–${yuan(item.max)}`;
    lines.push(`  · ${item.label} ${rangeText}`);
  }
  if (plan.meta.dataNotes.length) {
    lines.push(`说明：${plan.meta.dataNotes[0]}`);
  }
  lines.push("时间与价格请以现场为准。");
  if (shareUrl) {
    lines.push("");
    lines.push(`同款行程：${shareUrl}`);
  }
  return lines.join("\n");
}
