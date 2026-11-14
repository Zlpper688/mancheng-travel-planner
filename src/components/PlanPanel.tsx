"use client";

import { useEffect, useState } from "react";
import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
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
  DayPlan,
  PlanResult,
  RouteLeg,
  StopKind,
  StopPlan,
  TransportMode,
} from "@/lib/types";
import { Icon } from "./Icon";
import { Spinner, cn } from "./ui";

type Tab = "plan" | "budget" | "notes";

export interface PlanPanelProps {
  plan: PlanResult | null;
  loading: boolean;
  error: { message: string; hint?: string } | null;
  activeDay: number | "all";
  hotelName: string;
  onActiveDay: (day: number | "all") => void;
  onFocusStop: (day: number, placeId: string) => void;
  onShuffle: () => void;
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
  { id: "plan", label: "逐日行程" },
  { id: "budget", label: "预算" },
  { id: "notes", label: "说明" },
];

function kindLabel(kind: StopKind): string {
  if (kind === "meal") return "正餐";
  if (kind === "cafe") return "咖啡 / 茶歇";
  return "景点";
}

function hoursLabel(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  const h = Math.floor(value / 60);
  const m = value % 60;
  if (!h) return `${m} 分`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function legLabel(leg: RouteLeg): string {
  if (leg.note?.includes("轮渡")) return "轮渡";
  return TRANSPORT_LABELS[leg.mode];
}

function LegRow({ leg }: { leg: RouteLeg }) {
  return (
    <div
      className="rounded-lg px-2 py-1.5 text-[10px] text-ink-faint"
      title={leg.note}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="inline-flex items-center gap-1 text-ink-soft">
          <Icon name={TRANSPORT_ICONS[leg.mode]} size={11} />
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
          <span className="rounded bg-amber-soft px-1 py-px text-[8px] text-amber">
            估算
          </span>
        ) : null}
        <span className="ml-auto tabular-nums">
          {minutesToTime(leg.departMin)} → {minutesToTime(leg.arriveMin)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[9px] text-ink-faint/85">
        {leg.alternatives.map((alternative) => (
          <span key={alternative.mode} className="inline-flex items-center gap-0.5">
            <Icon name={TRANSPORT_ICONS[alternative.mode]} size={9} />
            {SHORT_MODE[alternative.mode]} {alternative.durationMin} 分
          </span>
        ))}
        {leg.note ? <span>· {leg.note}</span> : null}
      </div>
    </div>
  );
}

function StopRow({
  stop,
  day,
  onFocus,
}: {
  stop: StopPlan;
  day: DayPlan;
  onFocus: (placeId: string) => void;
}) {
  const meal = stop.kind !== "sight";
  return (
    <button
      type="button"
      onClick={() => onFocus(stop.place.id)}
      className="group w-full rounded-xl border border-line/60 bg-card px-3 py-2.5 text-left transition hover:border-ink/20 hover:shadow-[0_10px_24px_-20px_rgba(35,42,36,0.5)]"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center text-[10px] font-semibold text-paper",
            meal ? "rotate-45 rounded-[6px]" : "rounded-full",
          )}
          style={{ background: day.color }}
        >
          <span className={meal ? "-rotate-45" : undefined}>{stop.order}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[12.5px] font-medium text-ink">
              {stop.place.name}
            </span>
            <span className="shrink-0 text-[9px] text-ink-faint">
              {kindLabel(stop.kind)}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[9px] text-ink-faint">
            {clockRange(stop.startMin, stop.endMin)} · 停留 {stop.dwellMin} 分 ·{" "}
            {CATEGORY_LABELS[stop.place.category]}
          </span>
        </span>
        <Icon
          name="chevron-right"
          size={12}
          className="shrink-0 text-ink-faint transition group-hover:translate-x-0.5 group-hover:text-ink"
        />
      </div>
      {stop.note ? (
        <p className="mt-1.5 pl-8 text-[10px] leading-relaxed text-ink-soft">
          {stop.note}
        </p>
      ) : null}
      {stop.ticket || stop.place.rating || stop.place.openHours ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-8 text-[9px] text-ink-faint">
          {stop.ticket ? (
            <span className="inline-flex items-center gap-0.5">
              <Icon name="ticket" size={9} />
              门票 ¥{stop.ticket}
              {stop.estimatedTicket ? " 起" : ""}
            </span>
          ) : null}
          {stop.place.rating ? <span>★ {stop.place.rating.toFixed(1)}</span> : null}
          {stop.place.openHours ? (
            <span className="truncate">· {stop.place.openHours}</span>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function DayTimeline({
  day,
  hotelName,
  onFocusStop,
}: {
  day: DayPlan;
  hotelName: string;
  onFocusStop: (day: number, placeId: string) => void;
}) {
  const firstLeg = day.legs[0];
  const returnLeg = day.legs[day.legs.length - 1];

  return (
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
          <p className="text-[12px] font-medium text-ink">
            从 {hotelName} 出发
          </p>
          <p className="mt-0.5 text-[9px] text-ink-faint">
            {minutesToTime(firstLeg?.departMin ?? day.startMin)} ·
            早餐吃饱，水杯灌满
          </p>
        </div>
      </div>

      {day.stops.map((stop, index) => {
        const leg = day.legs[index];
        return (
          <div key={stop.id}>
            {leg ? (
              <div className="relative flex gap-3">
                <span className="z-10 mb-1 ml-1 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-card text-ink-faint">
                  <Icon name={TRANSPORT_ICONS[leg.mode]} size={11} />
                </span>
                <div className="min-w-0 flex-1 py-0.5">
                  <LegRow leg={leg} />
                </div>
              </div>
            ) : null}
            <div className="relative flex gap-3 pb-1.5">
              <span
                className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-paper shadow-[0_8px_18px_-12px_rgba(35,42,36,0.7)]"
                style={{ background: day.color }}
              >
                {stop.order}
              </span>
              <div className="min-w-0 flex-1">
                <StopRow
                  stop={stop}
                  day={day}
                  onFocus={(placeId) => onFocusStop(day.index, placeId)}
                />
              </div>
            </div>
          </div>
        );
      })}

      {returnLeg ? (
        <div>
          <div className="relative flex gap-3">
            <span className="z-10 mb-1 ml-1 mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-card text-ink-faint">
              <Icon name={TRANSPORT_ICONS[returnLeg.mode]} size={11} />
            </span>
            <div className="min-w-0 flex-1 py-0.5">
              <LegRow leg={returnLeg} />
            </div>
          </div>
          <div className="relative flex gap-3">
            <span className="z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-jade text-paper">
              <Icon name="home" size={14} />
            </span>
            <div className="min-w-0 pt-1">
              <p className="text-[12px] font-medium text-ink">
                回到 {hotelName}
              </p>
              <p className="mt-0.5 text-[9px] text-ink-faint">
                {minutesToTime(returnLeg.arriveMin)} · 今天一共走了{" "}
                {day.stats.distanceKm.toFixed(1)} km
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {day.tip ? (
        <div className="relative mt-3 ml-11 rounded-xl bg-paper/80 px-3 py-2 text-[10px] leading-relaxed text-ink-soft">
          <span className="mr-1 inline-flex translate-y-px items-center text-jade">
            <Icon name="sparkles" size={11} />
          </span>
          {day.tip}
        </div>
      ) : null}
    </div>
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
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold text-white"
          style={{ background: day.color }}
        >
          {day.index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate font-serif text-[15px] tracking-wide text-ink">
              {day.theme}
            </h3>
            <span className="ml-auto shrink-0 text-[9px] text-ink-faint">
              {formatDateCN(day.date)} {weekdayCN(day.date)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[10px] text-ink-faint">
            {day.area}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-ink-soft">
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
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-[9px] text-ink-soft"
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

export default function PlanPanel({
  plan,
  loading,
  error,
  activeDay,
  hotelName,
  onActiveDay,
  onFocusStop,
  onShuffle,
  onGenerate,
}: PlanPanelProps) {
  const [tab, setTab] = useState<Tab>("plan");

  useEffect(() => {
    if (!plan) setTab("plan");
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
                <span className="shrink-0 rounded-full bg-jade-soft px-1.5 py-0.5 text-[8px] tracking-wide text-jade">
                  攻略复刻
                </span>
              ) : null}
            </div>
            <p className="mt-1 truncate text-[10px] text-ink-faint">
              {plan
                ? plan.meta.subtitle
                : "从酒店出发 · 不走回头路 · 最后回到酒店"}
            </p>
          </div>
          {plan ? (
            <button
              type="button"
              onClick={onShuffle}
              disabled={loading}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5 text-[10px] text-ink-soft transition hover:border-ink/25 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Icon name="shuffle" size={12} />
              换一版
            </button>
          ) : null}
        </div>

        {plan?.meta.holiday ? (
          <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber-soft px-2.5 py-1 text-[9px] text-amber">
            <Icon name="calendar" size={10} />
            {plan.meta.holiday.name} · 人流约 +{plan.meta.holiday.crowdPct}% ·
            已计入路程与房价
          </div>
        ) : null}

        {plan ? (
          <div className="mt-3 flex gap-1">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={cn(
                  "relative px-3 py-2 text-[11px] transition",
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
            {loading ? (
              <span className="ml-auto inline-flex items-center gap-1.5 pb-2 text-[10px] text-ink-faint">
                <Spinner className="h-3 w-3 text-accent" />
                重排中
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
        {error ? (
          <div
            className={cn(
              "mb-3 rounded-xl border px-3 py-2.5 text-[10px] leading-relaxed",
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
              className="mt-2 inline-flex items-center gap-1 rounded-full border border-current/20 px-2.5 py-1 text-[10px] transition hover:bg-card/60"
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
              <p className="font-serif text-[16px] text-ink">
                选好落脚点，就能生成第一条路线
              </p>
              <p className="mx-auto mt-1.5 max-w-xs text-[10px] leading-relaxed text-ink-faint">
                漫城会按极坐标把景点分成不同的方向，每天走一个方向，最后回到酒店，尽量避免回头路。
              </p>
              <button
                type="button"
                onClick={onGenerate}
                className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[11px] text-paper transition hover:bg-accent-deep"
              >
                <Icon name="sparkles" size={13} />
                生成行程
              </button>
            </div>
          )
        ) : tab === "plan" ? (
          <div>
            <div className="scroll-thin -mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
              <button
                type="button"
                onClick={() => onActiveDay("all")}
                className={cn(
                  "shrink-0 rounded-full border px-2.5 py-1 text-[10px] transition",
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
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] transition",
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
                      <p className="mt-1 text-[9px] text-ink-faint">停留点</p>
                    </div>
                    <div className="border-x border-line/60">
                      <p className="font-serif text-[18px] leading-none text-ink">
                        {totals.distance.toFixed(1)}
                        <span className="ml-0.5 text-[9px] text-ink-faint">
                          km
                        </span>
                      </p>
                      <p className="mt-1 text-[9px] text-ink-faint">总路程</p>
                    </div>
                    <div>
                      <p className="font-serif text-[18px] leading-none text-ink">
                        {hoursLabel(totals.travel)}
                      </p>
                      <p className="mt-1 text-[9px] text-ink-faint">路上时间</p>
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
                hotelName={hotelName}
                onFocusStop={onFocusStop}
              />
            )}
          </div>
        ) : tab === "budget" ? (
          <div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <p className="text-[9px] tracking-[0.16em] text-ink-faint">
                  总预算 · {plan.budget.travelers} 人
                </p>
                <p className="mt-1 font-serif text-[30px] leading-none tabular-nums text-ink">
                  {moneyRange(plan.budget.totalMin, plan.budget.totalMax)}
                </p>
              </div>
              <span className="ml-auto rounded-full bg-paper px-2.5 py-1 text-[10px] text-ink-soft">
                人均{" "}
                {moneyRange(
                  plan.budget.perPersonMin,
                  plan.budget.perPersonMax,
                )}
              </span>
            </div>

            <div className="mt-4 space-y-3">
              {plan.budget.items.map((item) => (
                <div key={item.key}>
                  <div className="flex items-baseline gap-2 text-[11px]">
                    <span className="shrink-0 font-medium text-ink">
                      {item.label}
                    </span>
                    <span className="truncate text-[9px] text-ink-faint">
                      {item.detail}
                    </span>
                    <span className="ml-auto shrink-0 tabular-nums text-ink-soft">
                      {moneyRange(item.min, item.max)}
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-paper">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.max(
                          4,
                          Math.round((item.max / Math.max(1, plan.budget.totalMax)) * 100),
                        )}%`,
                        background: BUDGET_COLORS[item.key] ?? "#8b9187",
                      }}
                    />
                  </div>
                  {item.note ? (
                    <p className="mt-1 text-[9px] leading-relaxed text-ink-faint">
                      {item.note}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>

            <p className="mt-4 rounded-lg bg-paper/70 px-2.5 py-2 text-[9px] leading-relaxed text-ink-faint">
              预算按{plan.meta.travelers} 人、{plan.meta.days} 天计算。住宿按出发前
              {Math.max(0, plan.meta.days - 1)} 晚计
              {plan.meta.holiday ? "，已计入假期酒店上浮" : ""}
              ；没有真实标价的餐食与门票按同档中位数补齐，因此给出区间。
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {plan.warnings.length > 0 ? (
              <div className="rounded-xl bg-amber-soft/70 p-3">
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-amber">
                  <Icon name="alert" size={12} />
                  出发前留意
                </p>
                <ul className="mt-1.5 space-y-1">
                  {plan.warnings.map((warning) => (
                    <li
                      key={warning}
                      className="flex gap-1.5 text-[10px] leading-relaxed text-amber/90"
                    >
                      <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-amber" />
                      {warning}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="rounded-xl bg-paper/60 p-3">
              <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink">
                <Icon name="info" size={12} className="text-ink-soft" />
                数据与算法说明
              </p>
              <ul className="mt-1.5 space-y-1">
                {plan.meta.dataNotes.map((note) => (
                  <li
                    key={note}
                    className="flex gap-1.5 text-[10px] leading-relaxed text-ink-soft"
                  >
                    <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-line" />
                    {note}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-1 text-[9px] leading-relaxed text-ink-faint">
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
