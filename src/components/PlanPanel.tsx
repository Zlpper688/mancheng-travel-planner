"use client";

import { useEffect, useState } from "react";
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  STOP_KIND_LABELS,
  TIP_ICONS,
  TRANSPORT_ICONS,
  TRANSPORT_LABELS,
} from "@/lib/constants";
import { clockRange, moneyRange } from "@/lib/format";
import {
  formatDateCN,
  formatDuration,
  formatKm,
  minutesToTime,
  weekdayCN,
} from "@/lib/geo";
import type {
  BudgetItem,
  DayPlan,
  PlanResult,
  PlanTip,
  RouteAlternative,
  RouteLeg,
  TransportMode,
} from "@/lib/types";
import GuidePanel from "./GuidePanel";
import { Icon } from "./Icon";
import PlanRhythmChips from "./PlanRhythmChips";
import { Spinner, cn } from "./ui";
import BookingCard from "./plan/BookingCard";
import LodgingCard from "./plan/LodgingCard";
import SlotStrip from "./plan/SlotStrip";
import StopRow from "./plan/StopRow";
import WeatherStrip from "./plan/WeatherStrip";

type Tab = "guide" | "plan" | "budget" | "notes";

export interface PlanPanelProps {
  plan: PlanResult | null;
  loading: boolean;
  error: { message: string; hint?: string } | null;
  activeDay: number | "all";
  focus?: { placeId: string; nonce: number } | null;
  hotelName: string;
  onActiveDay: (day: number | "all") => void;
  onFocusStop: (day: number, placeId: string) => void;
  onShuffle: () => void;
  /** 记下这趟：把当前行程归档成旅行记录（宪法 C 闭环）。不传则不显示按钮。 */
  onSaveJournal?: () => void;
  /** 已锁定的点位 id，重排时这些点必须留在原定的那一天。 */
  lockedIds?: string[];
  /** 单点操作是可选的：对话里的手册视图不提供编辑，就不显示按钮。 */
  onToggleLock?: (day: number, placeId: string) => void;
  onReplaceStop?: (day: number, placeId: string) => void;
  onRemoveStop?: (day: number, placeId: string) => void;
  /** 复制当前这一版的分享链接。 */
  onShare?: () => void;
  /** 把行程复制成可直接粘贴的纯文本。 */
  onCopyGuide?: () => void;
  onGenerate: () => void;
}

const SHORT_MODE: Record<TransportMode, string> = {
  walk: "步行",
  transit: "公交",
  taxi: "打车",
};

const BUDGET_COLORS: Record<string, string> = {
  hotel: "#2f6a52",
  food: "#c15a36",
  ticket: "#a97725",
  transport: "#435e8c",
  misc: "#7b4e6e",
};

const TABS: { id: Tab; label: string }[] = [
  { id: "guide", label: "图文攻略" },
  { id: "plan", label: "逐日行程" },
  { id: "budget", label: "预算" },
  { id: "notes", label: "说明" },
];

/** 「为什么这么排」：默认收起，点开才展开四条理由。
 *  放在单日视图里——这时用户正在读这一天的细节，才有耐心看解释。 */
function WhyBlock({ why }: { why?: string[] }) {
  const [open, setOpen] = useState(false);
  if (!why || !why.length) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full border border-jade/25 bg-card/70 px-2 py-0.5 text-[10px] text-jade transition hover:border-jade/50"
      >
        <Icon name="info" size={11} />
        为什么这么排
        <Icon
          name="chevron-down"
          size={11}
          className={open ? "rotate-180 transition" : "transition"}
        />
      </button>
      {open ? (
        <ul className="mt-1.5 space-y-1 rounded-xl border border-line/60 bg-card/70 px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-soft">
          {why.map((line) => (
            <li key={line} className="flex gap-1.5">
              <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-jade/60" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function StrategyStrip({ day }: { day: DayPlan }) {
  if (!day.strategy && !day.why?.length) return null;
  return (
    <div className="mb-3 rounded-xl border border-jade/25 bg-jade-soft/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] font-medium text-jade">
        <Icon name="route" size={12} />
        今日走法
        {day.heroName ? (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-card/80 px-1.5 py-0.5 text-micro font-normal text-ink-soft">
            <Icon name="star" size={8} className="text-amber" />
            主景 · {day.heroName}
          </span>
        ) : null}
      </div>
      {day.strategy ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
          {day.strategy}
        </p>
      ) : null}
      <div className="mt-1.5">
        <PlanRhythmChips rhythm={day.rhythm} />
      </div>
      <WhyBlock why={day.why} />
    </div>
  );
}

function TipCard({ tip }: { tip: PlanTip }) {
  return (
    <div className="rounded-xl border border-line/60 bg-card px-3 py-2">
      <p className="flex items-start gap-1.5 text-[11.5px] font-medium leading-snug text-ink">
        <Icon
          name={TIP_ICONS[tip.kind]}
          size={11}
          className="mt-px shrink-0 text-jade"
        />
        {tip.title}
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
        {tip.body}
      </p>
      <p className="mt-1.5 text-micro text-ink-faint">{tip.source}</p>
    </div>
  );
}

function hoursLabel(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  const h = Math.floor(value / 60);
  const m = value % 60;
  if (!h) return `${m} 分`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function legNoteKind(note?: string): "ferry" | "metro" | "bus" | null {
  if (!note) return null;
  if (/轮渡|候船|跨海/.test(note)) return "ferry";
  if (note.includes("地铁")) return "metro";
  if (note.includes("公交")) return "bus";
  return null;
}

function legLabel(leg: RouteLeg): string {
  const kind = legNoteKind(leg.note);
  if (kind === "ferry") return "轮渡";
  if (kind === "metro") return "地铁";
  if (kind === "bus") return "公交";
  return TRANSPORT_LABELS[leg.mode];
}

function legIcon(leg: RouteLeg): string {
  const kind = legNoteKind(leg.note);
  if (kind === "ferry") return "ship";
  if (kind === "metro") return "train";
  return TRANSPORT_ICONS[leg.mode];
}

function isTinyLeg(leg: RouteLeg): boolean {
  return leg.distanceKm <= 0.06 && leg.durationMin <= 2;
}

function alternativeLabel(alternative: RouteAlternative): string {
  const kind = legNoteKind(alternative.note);
  if (kind === "ferry") return "轮渡";
  if (kind === "metro") return "地铁";
  if (kind === "bus") return "公交";
  return SHORT_MODE[alternative.mode];
}

function alternativeIcon(alternative: RouteAlternative): string {
  const kind = legNoteKind(alternative.note);
  if (kind === "ferry") return "ship";
  if (kind === "metro") return "train";
  return TRANSPORT_ICONS[alternative.mode];
}

function LegRow({ leg }: { leg: RouteLeg }) {
  return (
    <div
      className="rounded-lg px-2.5 py-2 text-[11.5px] text-ink-faint"
      title={leg.note}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="inline-flex items-center gap-1 text-ink-soft">
          <Icon name={legIcon(leg)} size={11} />
          {legLabel(leg)}
        </span>
        <span>{formatDuration(leg.durationMin)}</span>
        <span>· {formatKm(leg.distanceKm)}</span>
        {leg.cost > 0 ? (
          <span>
            · ¥{Math.round(leg.cost)}
            {leg.costUnit === "person" ? "/人" : "/车"}
          </span>
        ) : null}
        {leg.estimated ? (
          <span className="rounded bg-amber-soft px-1 py-px text-micro text-amber">
            估算
          </span>
        ) : null}
        <span className="ml-auto tabular-nums">
          {minutesToTime(leg.departMin)} → {minutesToTime(leg.arriveMin)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10.5px] text-ink-faint">
        {leg.alternatives.map((alternative) => (
          <span key={alternative.mode} className="inline-flex items-center gap-0.5">
            <Icon name={alternativeIcon(alternative)} size={9} />
            {alternativeLabel(alternative)} {alternative.durationMin} 分
          </span>
        ))}
        {leg.note ? <span>· {leg.note}</span> : null}
      </div>
    </div>
  );
}

function DayTimeline({
  day,
  city,
  focusPlaceId,
  hotelName,
  lockedIds,
  onFocusStop,
  onToggleLock,
  onReplaceStop,
  onRemoveStop,
}: {
  day: DayPlan;
  city: string;
  focusPlaceId?: string | null;
  hotelName: string;
  lockedIds: string[];
  onFocusStop: (day: number, placeId: string) => void;
  onToggleLock?: (day: number, placeId: string) => void;
  onReplaceStop?: (day: number, placeId: string) => void;
  onRemoveStop?: (day: number, placeId: string) => void;
}) {
  const firstLeg = day.legs[0];
  const returnLeg = day.legs[day.legs.length - 1];
  let order = 0;
  const numbers = new Map<string, number>();
  for (const stop of day.stops) {
    if (!stop.flexible) numbers.set(stop.id, ++order);
  }

  return (
    <>
      {day.weather ? <WeatherStrip weather={day.weather} /> : null}
      <StrategyStrip day={day} />
      <SlotStrip slots={day.slots} />
      <div className="relative">
      <span
        className="absolute bottom-5 left-4 top-4 w-px bg-line/80"
        aria-hidden="true"
      />

      <div className="relative flex gap-3 pb-1">
        <span className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-jade text-paper shadow-[0_8px_18px_-10px_rgba(47,106,82,0.8)]">
          <Icon name="home" size={14} />
        </span>
        <div className="min-w-0 pt-1">
          <p className="text-[13px] font-medium text-ink">
            从 {hotelName} 出发
          </p>
          <p className="mt-0.5 text-[10.5px] text-ink-faint">
            {minutesToTime(firstLeg?.departMin ?? day.startMin)} ·
            早餐吃饱，水杯灌满
          </p>
        </div>
      </div>

      {day.stops.map((stop, index) => {
        const leg = day.legs[index];
        return (
          <div key={stop.id}>
            {leg && !isTinyLeg(leg) ? (
              <div className="relative flex gap-3">
                <span className="z-10 mb-1 ml-1 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-card text-ink-faint">
                  <Icon name={legIcon(leg)} size={11} />
                </span>
                <div className="min-w-0 flex-1 py-0.5">
                  <LegRow leg={leg} />
                </div>
              </div>
            ) : null}
            <div className="relative flex gap-3 pb-1.5">
              <span
                className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-paper shadow-[0_8px_18px_-12px_rgba(35,42,36,0.7)]"
                style={{ background: day.color }}
              >
                {stop.flexible ? (
                  <Icon name="clock" size={12} />
                ) : (
                  numbers.get(stop.id)
                )}
              </span>
              <div className="min-w-0 flex-1">
                <StopRow
                  stop={stop}
                  day={day}
                  city={city}
                  number={numbers.get(stop.id)}
                  active={focusPlaceId === stop.place.id}
                  locked={lockedIds.includes(stop.place.id)}
                  onFocus={(placeId) => onFocusStop(day.index, placeId)}
                  onToggleLock={
                    onToggleLock
                      ? () => onToggleLock(day.index, stop.place.id)
                      : undefined
                  }
                  onReplace={
                    onReplaceStop
                      ? () => onReplaceStop(day.index, stop.place.id)
                      : undefined
                  }
                  onRemove={
                    onRemoveStop
                      ? () => onRemoveStop(day.index, stop.place.id)
                      : undefined
                  }
                />
              </div>
            </div>
          </div>
        );
      })}

      {returnLeg ? (
        <div>
          {!isTinyLeg(returnLeg) ? (
            <div className="relative flex gap-3">
              <span className="z-10 mb-1 ml-1 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-card text-ink-faint">
                <Icon name={legIcon(returnLeg)} size={11} />
              </span>
              <div className="min-w-0 flex-1 py-0.5">
                <LegRow leg={returnLeg} />
              </div>
            </div>
          ) : null}
          <div className="relative flex gap-3">
            <span className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-jade text-paper">
              <Icon name="home" size={14} />
            </span>
            <div className="min-w-0 pt-1">
              <p className="text-[13px] font-medium text-ink">
                回到 {hotelName}
              </p>
              <p className="mt-0.5 text-[10.5px] text-ink-faint">
                {minutesToTime(returnLeg.arriveMin)} · 今天一共走了{" "}
                {day.stats.distanceKm.toFixed(1)} km
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {day.tip ? (
        <div className="relative mt-3 ml-11 rounded-xl bg-paper/80 px-3 py-2 text-[11.5px] leading-relaxed text-ink-soft">
          <span className="mr-1 inline-flex translate-y-px items-center text-jade">
            <Icon name="sparkles" size={11} />
          </span>
          {day.tip}
        </div>
      ) : null}

      {day.tips?.length ? (
        <div className="relative mt-2 ml-11 space-y-1.5">
          {day.tips.map((tip) => (
            <TipCard key={tip.id} tip={tip} />
          ))}
        </div>
      ) : null}

      {day.alternatives?.length ? (
        <div className="relative mt-2 ml-11 rounded-xl border border-dashed border-line bg-card/60 px-3 py-2">
          <p className="text-[10px] tracking-[0.12em] text-ink-faint">
            如果人太多或天气变了 · 同日备选
          </p>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {day.alternatives.map((alt) => (
              <span
                key={alt.placeId}
                className="inline-flex items-baseline gap-1 text-[11px] text-ink-soft"
              >
                <Icon name="map-pin" size={9} className="text-jade" />
                <span className="text-ink">{alt.name}</span>
                <span className="text-[10px] text-ink-faint">
                  {alt.reason}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      </div>
    </>
  );
}

function DayCard({
  day,
  onClick,
}: {
  day: DayPlan;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-2xl border border-line/80 bg-card p-3.5 text-left transition hover:border-ink/20 hover:shadow-[0_18px_40px_-32px_rgba(35,42,36,0.55)]"
    >
      <div className="flex gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white"
          style={{ background: day.color }}
        >
          {day.index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate font-serif text-[16px] tracking-wide text-ink">
              {day.theme}
            </h3>
            <span className="ml-auto shrink-0 text-[10.5px] text-ink-faint">
              {formatDateCN(day.date)} {weekdayCN(day.date)}
            </span>
          </div>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-faint">
            {day.far ? (
              <span className="shrink-0 rounded bg-jade-soft px-1 py-px text-micro tracking-wide text-jade">
                远足日
              </span>
            ) : null}
            {day.weather ? (
              <span
                className="inline-flex shrink-0 items-center gap-0.5 rounded bg-paper px-1 py-px text-micro text-ink-soft"
                title={`${day.weather.label}${
                  day.weather.precipProb !== undefined
                    ? ` · 降水概率 ${Math.round(day.weather.precipProb)}%`
                    : ""
                }`}
              >
                <Icon name={day.weather.icon} size={9} className="text-jade" />
                <span className="tabular-nums">
                  {Math.round(day.weather.tMin)}°~
                  {Math.round(day.weather.tMax)}°
                </span>
                {day.weather.precipProb !== undefined &&
                day.weather.precipProb >= 30 ? (
                  <span className="text-accent-deep">
                    {Math.round(day.weather.precipProb)}%
                  </span>
                ) : null}
              </span>
            ) : null}
            {day.tips?.length ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-jade-soft px-1 py-px text-micro text-jade">
                <Icon name="sparkles" size={8} />
                {day.tips.length} 条贴士
              </span>
            ) : null}
            {day.heroName ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-soft px-1 py-px text-micro text-amber">
                <Icon name="star" size={8} />
                <span className="max-w-[6.5rem] truncate">
                  主景 {day.heroName}
                </span>
              </span>
            ) : null}
            <span className="truncate">{day.area}</span>
          </p>
          {day.strategy ? (
            <p className="mt-1 line-clamp-1 text-[10.5px] leading-relaxed text-ink-faint">
              <Icon name="route" size={9} className="mr-0.5 inline text-jade" />
              {day.strategy}
            </p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-soft">
            <span>{day.stats.stopCount} 个停留</span>
            <span className="text-line">·</span>
            <span>{day.stats.distanceKm.toFixed(1)} km</span>
            <span className="text-line">·</span>
            <span>路上 {hoursLabel(day.stats.travelMin)}</span>
            <span className="text-line">·</span>
            <span className="tabular-nums">
              {clockRange(day.startMin, day.endMin)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {day.stops.map((stop) => (
              <span
                key={stop.id}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-[10.5px] text-ink-soft"
              >
                <Icon
                  name={CATEGORY_ICONS[stop.place.category]}
                  size={9}
                />
                <span className="max-w-[7.5rem] truncate">
                  {stop.place.name}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}

/** 预算一项一行：收起只给总额，展开才给人均、每天折算与算法口径。
 *  一屏塞满注释反而没人看，所以默认收起。 */
function BudgetRow({
  item,
  travelers,
  days,
  nights,
  totalMax,
  open,
  onToggle,
}: {
  item: BudgetItem;
  travelers: number;
  days: number;
  nights: number;
  totalMax: number;
  open: boolean;
  onToggle: () => void;
}) {
  const share = Math.min(
    100,
    Math.round((item.max / Math.max(1, totalMax)) * 100),
  );
  const perPerson = moneyRange(
    item.min / Math.max(1, travelers),
    item.max / Math.max(1, travelers),
  );
  // 住宿按晚摊，其余按天摊，否则「每天 ¥347」会让人以为三晚只要一千。
  const hotelUnit = item.key === "hotel" && nights > 0;
  const unitDays = hotelUnit ? nights : Math.max(1, days);
  const perDay = moneyRange(item.min / unitDays, item.max / unitDays);
  const color = BUDGET_COLORS[item.key] ?? "#8b9187";
  return (
    <div className="rounded-xl transition hover:bg-paper/40">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full rounded-xl px-1.5 py-1.5 text-left"
      >
        <span className="flex items-baseline gap-2 text-[12px]">
          <span className="shrink-0 font-medium text-ink">{item.label}</span>
          <span className="truncate text-[10.5px] text-ink-faint">
            {item.detail}
          </span>
          <span className="ml-auto shrink-0 tabular-nums text-ink-soft">
            {moneyRange(item.min, item.max)}
          </span>
          <Icon
            name="chevron-down"
            size={13}
            className={cn(
              "shrink-0 self-center text-ink-faint transition",
              open && "rotate-180",
            )}
          />
        </span>
        <span className="mt-1 block h-1 overflow-hidden rounded-full bg-paper">
          <span
            className="block h-full rounded-full"
            style={{ width: `${Math.max(4, share)}%`, background: color }}
          />
        </span>
      </button>
      {open ? (
        <div
          className="mb-1 ml-1.5 space-y-1 border-l-2 pl-2.5 text-[11px] leading-relaxed text-ink-soft"
          style={{ borderColor: color }}
        >
          <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
            <span>
              占总额约{" "}
              <span className="tabular-nums text-ink">{share}%</span>
            </span>
            <span>
              人均{" "}
              <span className="tabular-nums text-ink">{perPerson}</span>
            </span>
            <span>
              {hotelUnit ? "每晚" : "每天"}{" "}
              <span className="tabular-nums text-ink">{perDay}</span>
            </span>
          </p>
          {item.note ? <p className="text-ink-faint">{item.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export default function PlanPanel({
  plan,
  loading,
  error,
  activeDay,
  focus,
  hotelName,
  onActiveDay,
  onFocusStop,
  onShuffle,
  onSaveJournal,
  onGenerate,
  lockedIds = [],
  onToggleLock,
  onReplaceStop,
  onRemoveStop,
  onShare,
  onCopyGuide,
}: PlanPanelProps) {
  const [tab, setTab] = useState<Tab>("guide");
  /** 展开的预算条目：一次只看一项细节，避免把面板塞满。 */
  const [openBudget, setOpenBudget] = useState<string | null>(null);

  useEffect(() => {
    if (!plan) setTab("guide");
  }, [plan]);

  const day =
    plan && activeDay !== "all"
      ? plan.days.find((item) => item.index === activeDay)
      : undefined;

  const totals = plan
    ? plan.days.reduce(
        (acc, item) => ({
          stops: acc.stops + item.stats.stopCount,
          distance: acc.distance + item.stats.distanceKm,
          travel: acc.travel + item.stats.travelMin,
        }),
        { stops: 0, distance: 0, travel: 0 },
      )
    : null;

  const stayName =
    plan?.lodging?.bases.find((base) => base.role === "main")?.name ?? hotelName;

  return (
    <section className="overflow-hidden rounded-[26px] border border-line/70 bg-card/88 shadow-soft backdrop-blur-sm">
      <div className="border-b border-line/60 px-4 pt-4 sm:px-5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-serif text-[19px] leading-tight tracking-wide text-ink">
                {plan ? plan.meta.title : "把一座城，走成一个圈"}
              </h2>
              {plan?.meta.isFixed ? (
                <span className="shrink-0 rounded-full bg-jade-soft px-1.5 py-0.5 text-micro tracking-wide text-jade">
                  {plan.meta.fixedKind === "selected"
                    ? "自选景点"
                    : plan.meta.fixedKind === "mixed"
                      ? "攻略 + 自选"
                      : "攻略复刻"}
                </span>
              ) : null}
              {plan?.meta.archetype ? (
                <span
                  className="shrink-0 rounded-full bg-amber-soft px-1.5 py-0.5 text-micro tracking-wide text-amber"
                  title={plan.meta.archetype.summary}
                >
                  {plan.meta.archetype.label}
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate text-[11.5px] text-ink-faint">
              {plan
                ? plan.meta.subtitle
                : "从落脚片区出发 · 不走回头路 · 晚上回到住处"}
            </p>
          </div>
          {plan ? (
            <div className="flex shrink-0 items-center gap-1.5">
              {onSaveJournal ? (
                <button
                  type="button"
                  onClick={onSaveJournal}
                  disabled={loading}
                  className="inline-flex items-center gap-1.5 rounded-full border border-jade/40 bg-jade-soft px-3.5 py-2 text-[12px] text-jade transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="check" size={12} />
                  记下这趟
                </button>
              ) : null}
              <button
                type="button"
                onClick={onShuffle}
                disabled={loading}
                className="hidden shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-3.5 py-2 text-[12px] text-ink-soft transition hover:border-ink/25 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 sm:inline-flex"
              >
                <Icon name="shuffle" size={12} />
                换一版
              </button>
            </div>
          ) : null}
        </div>

        {plan?.meta.holiday ? (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-soft px-2.5 py-1 text-[10.5px] text-amber">
            <Icon name="calendar" size={10} />
            {plan.meta.holiday.name} · 人流约 +{plan.meta.holiday.crowdPct}% ·
            已计入路程与房价
          </div>
        ) : null}

        {plan ? <BookingCard plan={plan} city={plan.meta.city} /> : null}

        {plan?.lodging &&
        (plan.lodging.status === "recommended" ||
          plan.lodging.bases.length > 1) ? (
          <LodgingCard lodging={plan.lodging} />
        ) : null}

        {plan ? (
          <div className="mt-3 flex items-center gap-1">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  "relative px-3.5 py-2.5 text-[13px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                  tab === item.id
                    ? "text-ink"
                    : "text-ink-faint hover:text-ink-soft",
                )}
              >
                {item.label}
                {tab === item.id ? (
                  <span className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent" />
                ) : null}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1.5 pb-1.5">
              {onShare ? (
              <button
                type="button"
                onClick={onShare}
                title="复制这一版的链接，朋友打开就是同样的行程"
                className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] text-ink-faint transition hover:border-ink/25 hover:text-ink"
              >
                <Icon name="link" size={11} />
                分享
              </button>
              ) : null}
              {onCopyGuide ? (
              <button
                type="button"
                onClick={onCopyGuide}
                title="把行程复制成文字，直接粘到微信或备忘录"
                className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] text-ink-faint transition hover:border-ink/25 hover:text-ink"
              >
                <Icon name="copy" size={11} />
                复制
              </button>
              ) : null}
              {loading ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
                  <Spinner className="h-3 w-3 text-accent" />
                  重排中
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
        {error ? (
          <div
            className={cn(
              "mb-3 rounded-xl border px-3 py-2.5 text-[11.5px] leading-relaxed",
              plan
                ? "border-amber/30 bg-amber-soft/70 text-amber"
                : "border-accent/25 bg-accent-soft/70 text-accent-deep",
            )}
          >
            <p className="flex items-center gap-1.5 font-medium">
              <Icon name="alert" size={12} />
              {plan ? "这次没有重排成功，先保留上一版" : "还差一步"}
            </p>
            <p className="mt-1">
              {error.message}
              {error.hint ? ` · ${error.hint}` : ""}
            </p>
            <button
              type="button"
              onClick={onGenerate}
              className="mt-2 inline-flex items-center gap-1 rounded-full border border-current/20 px-3 py-1.5 text-[12px] transition hover:bg-card/60"
            >
              <Icon name="refresh" size={11} />
              再试一次
            </button>
          </div>
        ) : null}

        {!plan ? (
          loading ? (
            <div className="space-y-2" aria-busy="true">
              <div className="h-24 animate-pulse rounded-2xl bg-paper" />
              <div className="h-24 animate-pulse rounded-2xl bg-paper" />
              <div className="h-24 animate-pulse rounded-2xl bg-paper" />
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-line bg-paper/50 px-4 py-8 text-center">
              <p className="font-serif text-[17px] text-ink">
                定好城市和时间，就能生成第一条路线
              </p>
              <p className="mx-auto mt-1.5 max-w-xs text-[11.5px] leading-relaxed text-ink-faint">
                住处没定也没关系：漫城会先找出必去地标，按景点分布推荐落脚片区，再把顺路的点位串成一天。
              </p>
              <button
                type="button"
                onClick={onGenerate}
                className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-accent px-5 py-2.5 text-[13.5px] text-paper transition hover:bg-accent-deep"
              >
                <Icon name="sparkles" size={13} />
                生成行程
              </button>
            </div>
          )
        ) : tab === "guide" ? (
          <GuidePanel
            plan={plan}
            activeDay={activeDay}
            focusPlaceId={focus?.placeId ?? null}
            hotelName={stayName}
            onActiveDay={onActiveDay}
            onFocusStop={onFocusStop}
          />
        ) : tab === "plan" ? (
          <div>
            <div className="scroll-thin -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
              <button
                type="button"
                onClick={() => onActiveDay("all")}
                className={cn(
                  "min-h-9 shrink-0 rounded-full border px-3 py-1.5 text-[12px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                  activeDay === "all"
                    ? "border-ink bg-ink text-paper"
                    : "border-line bg-card text-ink-soft hover:border-ink/25",
                )}
              >
                全部
              </button>
              {plan.days.map((item) => (
                <button
                  key={item.index}
                  type="button"
                  onClick={() => onActiveDay(item.index)}
                  className={cn(
                    "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                    activeDay === item.index
                      ? "border-ink bg-ink text-paper"
                      : "border-line bg-card text-ink-soft hover:border-ink/25",
                  )}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: item.color }}
                  />
                  Day {item.index}
                </button>
              ))}
            </div>

            {activeDay === "all" || !day ? (
              <div className="space-y-3">
                {totals ? (
                  <div className="grid grid-cols-3 gap-2 rounded-2xl bg-paper/70 p-2.5 text-center">
                    <div>
                      <p className="font-serif text-[18px] leading-none text-ink">
                        {totals.stops}
                      </p>
                      <p className="mt-1 text-[10.5px] text-ink-faint">停留点</p>
                    </div>
                    <div className="border-x border-line/60">
                      <p className="font-serif text-[18px] leading-none text-ink">
                        {totals.distance.toFixed(1)}
                        <span className="ml-0.5 text-[10.5px] text-ink-faint">
                          km
                        </span>
                      </p>
                      <p className="mt-1 text-[10.5px] text-ink-faint">总路程</p>
                    </div>
                    <div>
                      <p className="font-serif text-[18px] leading-none text-ink">
                        {hoursLabel(totals.travel)}
                      </p>
                      <p className="mt-1 text-[10.5px] text-ink-faint">路上时间</p>
                    </div>
                  </div>
                ) : null}
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {plan.days.map((item) => (
                    <DayCard
                      key={item.index}
                      day={item}
                      onClick={() => onActiveDay(item.index)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <DayTimeline
                day={day}
                city={plan.meta.city}
                focusPlaceId={focus?.placeId ?? null}
                hotelName={stayName}
                lockedIds={lockedIds}
                onFocusStop={onFocusStop}
                onToggleLock={onToggleLock}
                onReplaceStop={onReplaceStop}
                onRemoveStop={onRemoveStop}
              />
            )}
          </div>
        ) : tab === "budget" ? (
          <div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <p className="text-[10.5px] tracking-[0.16em] text-ink-faint">
                  总预算 · {plan.budget.travelers} 人
                </p>
                <p className="mt-1 font-serif text-[30px] leading-none tabular-nums text-ink">
                  {moneyRange(plan.budget.totalMin, plan.budget.totalMax)}
                </p>
              </div>
              <span className="ml-auto rounded-full bg-paper px-2.5 py-1.5 text-[11.5px] text-ink-soft">
                人均{" "}
                {moneyRange(
                  plan.budget.perPersonMin,
                  plan.budget.perPersonMax,
                )}
              </span>
            </div>

            <p className="mt-3 text-[10.5px] text-ink-faint">
              点任意一项，展开看人均、每天折算和算法口径
            </p>

            <div className="mt-2 space-y-1">
              {plan.budget.items.map((item) => (
                <BudgetRow
                  key={item.key}
                  item={item}
                  travelers={plan.budget.travelers}
                  days={plan.meta.days}
                  nights={Math.max(0, plan.meta.days - 1)}
                  totalMax={plan.budget.totalMax}
                  open={openBudget === item.key}
                  onToggle={() =>
                    setOpenBudget((previous) =>
                      previous === item.key ? null : item.key,
                    )
                  }
                />
              ))}
            </div>

            <p className="mt-4 rounded-lg bg-paper/70 px-2.5 py-2 text-[10.5px] leading-relaxed text-ink-faint">
              预算按 {plan.meta.travelers} 人、{plan.meta.days} 天计算。住宿按出发前{" "}
              {Math.max(0, plan.meta.days - 1)} 晚计
              {plan.meta.holiday ? "，已计入假期酒店上浮" : ""}
              ；没有真实标价的餐食与门票按同档中位数补齐，因此给出区间。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {plan.warnings.length > 0 ? (
              <div className="rounded-xl bg-amber-soft/70 p-3">
                <p className="flex items-center gap-1.5 text-[12px] font-medium text-amber">
                  <Icon name="alert" size={12} />
                  出发前留意
                </p>
                <ul className="mt-1.5 space-y-1">
                  {plan.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="flex gap-1.5 text-[11.5px] leading-relaxed text-amber/90"
                    >
                      <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-amber" />
                      {warning}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {plan.tips?.length ? (
              <div className="rounded-xl bg-paper/60 p-3">
                <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                  <Icon name="sparkles" size={12} className="text-jade" />
                  场景贴士
                </p>
                <div className="mt-2 space-y-1.5">
                  {plan.tips.map((tip) => (
                    <TipCard key={tip.id} tip={tip} />
                  ))}
                </div>
                <p className="mt-2 text-[10.5px] leading-relaxed text-ink-faint">
                  由公开攻略与景区/交通公告提炼，每个停留点还会带预约、最佳时段与停留建议；规则、价格和班次可能调整，出发前以官方最新公告为准。
                </p>
              </div>
            ) : null}

            <div className="rounded-xl bg-paper/60 p-3">
              <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                <Icon name="info" size={12} className="text-ink-soft" />
                数据与算法说明
              </p>
              <ul className="mt-1.5 space-y-1">
                {plan.meta.dataNotes.map((note) => (
                  <li
                    key={note}
                    className="flex gap-1.5 text-[11.5px] leading-relaxed text-ink-soft"
                  >
                    <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-line" />
                    {note}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1 text-[10.5px] leading-relaxed text-ink-faint">
              <p>
                数据来源：
                {plan.meta.source === "amap"
                  ? "高德开放平台"
                  : plan.meta.source === "demo"
                    ? "内置厦门演示数据 + 开放地图"
                    : "OpenStreetMap / Wikidata / OSRM"}
                · {plan.meta.sourceNote}
              </p>
              <p>
                生成时间：
                {new Date(plan.meta.generatedAt).toLocaleString("zh-CN", {
                  hour12: false,
                })}
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
