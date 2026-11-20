import { crowdFactor, getHoliday } from "../holidays";
import { cityShortName } from "../providers/normalize";
import type {
  Category,
  DayPlan,
  PaceId,
  PlanTip,
  Place,
  StopKind,
  StyleId,
  TipKind,
  TransportPref,
  TripInput,
} from "../types";
import { metroAccess } from "../transit/metro";
import { TIPS, type TipDef, type TipWhen } from "./data";
import { findPlaceProfile, type PlaceProfile } from "./places";

interface TipContext {
  city: string;
  categories: Set<Category>;
  tags: Set<string>;
  names: string[];
  island: boolean;
  far: boolean;
  holiday: boolean;
  crowd: number;
  rain: boolean;
  heat: boolean;
  cold: boolean;
  children: number;
  styles: Set<StyleId>;
  pace: PaceId;
  transport: TransportPref;
  days: number;
  weekdays: Set<number>;
  hasMeal: boolean;
  sunsetNear: boolean;
}

export interface SelectedTips {
  dayTips: Map<number, PlanTip[]>;
  tripTips: PlanTip[];
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function sunsetMinute(value?: string): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isWet(day: DayPlan): boolean {
  const weather = day.weather;
  if (!weather || weather.estimated) return false;
  return (
    (weather.precipProb ?? 0) >= 50 ||
    (weather.precipMm ?? 0) >= 2 ||
    (weather.rainWindows ?? []).some((window) => window.mm >= 1)
  );
}

function isHot(day: DayPlan): boolean {
  return (day.weather?.tMax ?? 0) >= 33;
}

function isCold(day: DayPlan): boolean {
  return (day.weather?.tMin ?? 99) <= 5;
}

function sunsetNear(day: DayPlan): boolean {
  const sunset = sunsetMinute(day.weather?.sunset);
  if (sunset === null) return false;
  const lastSightEnd = Math.max(
    0,
    ...day.stops
      .filter((stop) => stop.kind === "sight")
      .map((stop) => stop.endMin),
  );
  return lastSightEnd >= sunset - 90;
}

function buildDayContext(day: DayPlan, input: TripInput): TipContext {
  const places = day.stops.map((stop) => stop.place);
  return {
    city: cityShortName(input.city),
    categories: new Set(places.map((place) => place.category)),
    tags: new Set(places.flatMap((place) => place.tags ?? [])),
    names: places.map((place) => place.name),
    island: day.stops.some(
      (stop) => stop.kind === "sight" && Boolean(stop.place.island),
    ),
    far: Boolean(day.far),
    holiday: Boolean(getHoliday(day.date)),
    crowd: crowdFactor(day.date),
    rain: isWet(day),
    heat: isHot(day),
    cold: isCold(day),
    children: input.children,
    styles: new Set(input.styles),
    pace: input.pace,
    transport: input.transport,
    days: input.days,
    weekdays: new Set([weekdayOf(day.date)]),
    hasMeal: day.stops.some((stop) => stop.kind !== "sight"),
    sunsetNear: sunsetNear(day),
  };
}

function buildTripContext(input: TripInput, days: DayPlan[]): TipContext {
  const places = days.flatMap((day) =>
    day.stops.map((stop) => stop.place),
  );
  return {
    city: cityShortName(input.city),
    categories: new Set(places.map((place) => place.category)),
    tags: new Set(places.flatMap((place) => place.tags ?? [])),
    names: places.map((place) => place.name),
    island: days.some((day) =>
      day.stops.some(
        (stop) => stop.kind === "sight" && Boolean(stop.place.island),
      ),
    ),
    far: days.some((day) => Boolean(day.far)),
    holiday: days.some((day) => Boolean(getHoliday(day.date))),
    crowd: days.reduce(
      (max, day) => Math.max(max, crowdFactor(day.date)),
      1,
    ),
    rain: days.some(isWet),
    heat: days.some(isHot),
    cold: days.some(isCold),
    children: input.children,
    styles: new Set(input.styles),
    pace: input.pace,
    transport: input.transport,
    days: input.days,
    weekdays: new Set(days.map((day) => weekdayOf(day.date))),
    hasMeal: days.some((day) =>
      day.stops.some((stop) => stop.kind !== "sight"),
    ),
    sunsetNear: days.some(sunsetNear),
  };
}

function matches(when: TipWhen, ctx: TipContext): boolean {
  if (
    when.city &&
    !when.city.some(
      (name) => ctx.city.includes(name) || name.includes(ctx.city),
    )
  ) {
    return false;
  }
  if (
    when.categories &&
    !when.categories.some((category) => ctx.categories.has(category))
  ) {
    return false;
  }
  if (when.tags && !when.tags.some((tag) => ctx.tags.has(tag))) return false;
  if (
    when.names &&
    !when.names.some((token) =>
      ctx.names.some((name) => name.includes(token)),
    )
  ) {
    return false;
  }
  if (when.island !== undefined && ctx.island !== when.island) return false;
  if (when.far !== undefined && ctx.far !== when.far) return false;
  if (when.holiday !== undefined && ctx.holiday !== when.holiday) return false;
  if (when.crowdMin !== undefined && ctx.crowd < when.crowdMin) return false;
  if (when.rain !== undefined && ctx.rain !== when.rain) return false;
  if (when.heat !== undefined && ctx.heat !== when.heat) return false;
  if (when.cold !== undefined && ctx.cold !== when.cold) return false;
  if (when.children !== undefined && Boolean(ctx.children) !== when.children) {
    return false;
  }
  if (when.styles && !when.styles.some((style) => ctx.styles.has(style))) {
    return false;
  }
  if (when.pace && !when.pace.includes(ctx.pace)) return false;
  if (when.transport && !when.transport.includes(ctx.transport)) return false;
  if (when.minDays !== undefined && ctx.days < when.minDays) return false;
  if (when.weekday !== undefined && !ctx.weekdays.has(when.weekday)) {
    return false;
  }
  if (when.hasMeal !== undefined && ctx.hasMeal !== when.hasMeal) return false;
  if (
    when.sunsetNear !== undefined &&
    ctx.sunsetNear !== when.sunsetNear
  ) {
    return false;
  }
  return true;
}

function score(def: TipDef): number {
  const when = def.when;
  let value = def.priority;
  if (when.city) value += 6;
  if (when.names) value += 5;
  if (when.children) value += 4;
  if (when.holiday || when.crowdMin !== undefined) value += 3;
  if (when.rain || when.heat || when.cold) value += 2;
  if (when.categories || when.tags) value += 2;
  if (when.island) value += 2;
  return value;
}

function toPlanTip(def: TipDef): PlanTip {
  return {
    id: def.id,
    kind: def.kind,
    title: def.title,
    body: def.body,
    source: def.source,
  };
}

interface StopGuide {
  attrs: string[];
  tips: PlanTip[];
}

interface Bullet {
  field: string;
  kind: TipKind;
  title: string;
  body: string;
  priority: number;
}

function profileGuide(
  profile: PlaceProfile,
  kind: StopKind,
  day: DayPlan,
  input: TripInput,
): StopGuide {
  const attrs: string[] = [];
  if (profile.booking) {
    attrs.push(
      profile.booking.startsWith("门票")
        ? profile.booking
        : profile.booking === "免费预约"
          ? "预约 · 免费"
          : /免费|无需/.test(profile.booking)
            ? `票务 · ${profile.booking}`
            : `预约 · ${profile.booking}`,
    );
  }
  if (profile.bestTime) attrs.push(`最佳 · ${profile.bestTime}`);
  if (profile.duration) attrs.push(`停留 · ${profile.duration}`);

  const wet = isWet(day);
  const holiday = Boolean(getHoliday(day.date));
  const crowd = crowdFactor(day.date);
  const meal = kind !== "sight";
  const bullets: Bullet[] = [];
  const add = (
    field: string,
    tipKind: TipKind,
    title: string,
    body: string | undefined,
    priority: number,
  ) => {
    if (!body) return;
    bullets.push({ field, kind: tipKind, title, body, priority });
  };

  add("booking", "booking", "预约", profile.bookingNote, 100);
  if (input.children && profile.family) {
    add("family", "family", "带娃", profile.family, 96);
  }
  if (wet && profile.rain) {
    add("rain", "weather", "雨天", profile.rain, 94);
  }
  add("highlight", "city", "怎么玩", profile.highlight, 92);
  if (sunsetNear(day) && profile.photo) {
    add("photo-sunset", "photo", "拍照时段", profile.photo, 88);
  }
  if ((holiday || crowd >= 1.25) && profile.bestTime) {
    add(
      "crowd",
      "crowd",
      "错峰",
      `最佳时段是 ${profile.bestTime}；节假日和周末提前到，能少排不少队。`,
      86,
    );
  }
  add("caution", "safety", "注意", profile.caution, 80);
  if (meal && profile.food) {
    add("food", "food", "吃什么", profile.food, 78);
  }
  add("photo", "photo", "拍照", profile.photo, 70);
  if (!meal) add("food", "food", "吃什么", profile.food, 66);

  const seen = new Set<string>();
  const seenBodies = new Set<string>();
  const tips = bullets
    .sort((a, b) => b.priority - a.priority)
    .filter((bullet) => {
      if (seen.has(bullet.field) || seenBodies.has(bullet.body)) return false;
      seen.add(bullet.field);
      seenBodies.add(bullet.body);
      return true;
    })
    .slice(0, 4)
    .map((bullet) => ({
      id: `${profile.id}-${bullet.field}`,
      kind: bullet.kind,
      title: bullet.title,
      body: bullet.body,
      source: profile.source,
    }));

  return { attrs, tips };
}

function genericGuide(
  place: Place,
  kind: StopKind,
  day: DayPlan,
  input: TripInput,
): StopGuide {
  const tips: PlanTip[] = [];
  const add = (field: string, tipKind: TipKind, title: string, body: string) => {
    tips.push({
      id: `generic-${place.id}-${field}`,
      kind: tipKind,
      title,
      body,
      source: "公开攻略整理 · 以现场为准",
    });
  };

  if (place.category === "museum") {
    add(
      "monday",
      "booking",
      weekdayOf(day.date) === 1 ? "闭馆日" : "预约与闭馆",
      weekdayOf(day.date) === 1
        ? "今天是周一，多数博物馆闭馆；出发前先看官方公告。"
        : "多数博物馆周一闭馆，热门馆要实名预约，先约再排行程。",
    );
  }
  if (place.category === "beach") {
    add(
      "tide",
      "safety",
      "海边",
      "留意潮汐和礁石，别下深水；紫外线强，防晒和替换衣物都带上。",
    );
  }
  if (place.category === "temple") {
    add(
      "dress",
      "temple",
      "礼佛",
      "着装得体，殿内不拍照；免费赠香通常够用，别买高价香。",
    );
  }
  if (place.category === "market") {
    add(
      "price",
      "food",
      "逛市场",
      "早上最新鲜、下午摊主愿意清货；先问清计价单位再买。",
    );
  }
  if (place.category === "nature") {
    add(
      "trail",
      "safety",
      "徒步",
      "穿防滑鞋、带驱蚊和足量水；雨天别走野路。",
    );
  }
  if (place.category === "viewpoint") {
    add(
      "sunset",
      "photo",
      "光线",
      "日落前 1 小时光线最好，提前占机位；风大注意帽子和手机。",
    );
  }
  if (place.category === "food") {
    add(
      "queue",
      "food",
      "吃饭",
      "错峰 11:30 前或 13:30 后；先看明码标价，海鲜问清时价和加工费。",
    );
  }
  if (place.category === "cafe") {
    add(
      "seat",
      "food",
      "歇脚",
      "靠窗位和网红位先问低消；下午人少，适合避开正午。",
    );
  }
  if (place.category === "street") {
    add(
      "walk",
      "city",
      "逛街区",
      "主街看氛围，想吃本地味道往旁边巷子走；晚上灯亮后更好拍，留意电瓶车和人群。",
    );
  }
  if (place.category === "park") {
    add(
      "green",
      "slow",
      "逛公园",
      "傍晚蚊虫多，带驱蚊液；草坪和水边注意防晒，周末停车位紧张。",
    );
  }
  if (place.island) {
    add(
      "ferry",
      "ferry",
      "离岛",
      "末班船时间先确认，提前 20–30 分钟到码头；风浪大时可能停航。",
    );
  }
  if (
    !tips.length &&
    (place.category === "attraction" || place.category === "park") &&
    (place.popularity ?? 0) >= 4.5
  ) {
    add(
      "crowd",
      "crowd",
      "错峰",
      "热门点位开门前 30 分钟到，先预约再出发；10:00–15:00 是人流高峰。",
    );
  }

  const attrs: string[] = [];
  if (input.children && place.category === "nature") {
    attrs.push("亲子 · 选平缓线路");
  }
  return { attrs, tips: tips.slice(0, 2) };
}

function selectPlaceTips(
  place: Place,
  kind: StopKind,
  day: DayPlan,
  input: TripInput,
): StopGuide {
  const profile = findPlaceProfile(cityShortName(input.city), place.name);
  if (!profile) return genericGuide(place, kind, day, input);
  const guide = profileGuide(profile, kind, day, input);
  if (guide.tips.length >= 2) return guide;
  const bodies = new Set(guide.tips.map((tip) => tip.body));
  for (const tip of genericGuide(place, kind, day, input).tips) {
    if (guide.tips.length >= 2) break;
    if (bodies.has(tip.body)) continue;
    guide.tips.push(tip);
  }
  return guide;
}

export function selectTips(input: TripInput, days: DayPlan[]): SelectedTips {
  const usedGroups = new Set<string>();
  const dayTips = new Map<number, PlanTip[]>();
  const dayCandidates: { def: TipDef; day: DayPlan; score: number }[] = [];

  for (const day of days) {
    const ctx = buildDayContext(day, input);
    for (const def of TIPS) {
      if (def.scope !== "day" || !matches(def.when, ctx)) continue;
      dayCandidates.push({ def, day, score: score(def) });
    }
  }

  dayCandidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.day.index - b.day.index ||
      a.def.id.localeCompare(b.def.id),
  );

  for (const candidate of dayCandidates) {
    if (usedGroups.has(candidate.def.group)) continue;
    const picked = dayTips.get(candidate.day.index) ?? [];
    if (picked.length >= 3) continue;
    usedGroups.add(candidate.def.group);
    picked.push(toPlanTip(candidate.def));
    dayTips.set(candidate.day.index, picked);
  }

  const tripCtx = buildTripContext(input, days);
  const tripTips: PlanTip[] = [];
  const tripCandidates = TIPS.filter(
    (def) => def.scope === "trip" && matches(def.when, tripCtx),
  ).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));

  for (const def of tripCandidates) {
    if (usedGroups.has(def.group)) continue;
    if (tripTips.length >= 5) break;
    usedGroups.add(def.group);
    tripTips.push(toPlanTip(def));
  }

  for (const day of days) {
    for (const stop of day.stops) {
      const guide = selectPlaceTips(stop.place, stop.kind, day, input);
      const metro = metroAccess(stop.place, input.city);
      if (metro) {
        const meters = Math.max(50, Math.round((metro.walkKm * 1000) / 50) * 50);
        guide.attrs.push(`地铁 · ${metro.station.name} ${meters}m`);
      }
      if (guide.attrs.length) stop.attrs = guide.attrs;
      if (guide.tips.length) stop.tips = guide.tips;
    }
  }

  return { dayTips, tripTips };
}
