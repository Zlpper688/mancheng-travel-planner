"use client";

import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  STOP_KIND_LABELS,
  TIP_ICONS,
} from "@/lib/constants";
import { clockRange } from "@/lib/format";
import { formatDateCN, formatDuration, weekdayCN } from "@/lib/geo";
import type { DayPlan, PlanResult, StopPlan } from "@/lib/types";
import { Icon } from "./Icon";
import PlacePhoto from "./PlacePhoto";
import PlanRhythmChips from "./PlanRhythmChips";
import { cn } from "./ui";

export interface GuidePanelProps {
  plan: PlanResult;
  activeDay: number | "all";
  focusPlaceId?: string | null;
  hotelName: string;
  onActiveDay: (day: number | "all") => void;
  onFocusStop: (day: number, placeId: string) => void;
}

export default function GuidePanel({
  plan,
  activeDay,
  focusPlaceId,
  hotelName,
  onActiveDay,
  onFocusStop,
}: GuidePanelProps) {
  const shown =
    activeDay === "all"
      ? plan.days
      : plan.days.filter((day) => day.index === activeDay);

  return (
    <div>
      {plan.wishlist?.length ? (
        <div className="mb-3.5 rounded-2xl border border-line/70 bg-paper/50 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="flex items-center gap-1.5 text-[10.5px] tracking-[0.12em] text-ink-faint">
              <Icon name="star" size={11} className="text-amber" />
              本城必做 · 心愿单
            </p>
            <span className="shrink-0 text-[10px] text-ink-faint">
              按体验排，不按景点堆
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {plan.wishlist.slice(0, 6).map((goal) => {
              const day = plan.days.find((item) =>
                item.stops.some((stop) => stop.place.id === goal.placeId),
              );
              const body = (
                <>
                  <span className="block text-[11.5px] leading-tight text-ink">
                    {goal.label}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[10px] leading-tight text-ink-faint">
                    <span>{goal.bandLabel}</span>
                    {goal.alternatives[0] ? (
                      <>
                        <span className="text-line">·</span>
                        <span>备选 {goal.alternatives[0].name}</span>
                      </>
                    ) : null}
                  </span>
                </>
              );
              return day ? (
                <button
                  key={goal.experience}
                  type="button"
                  onClick={() => {
                    onActiveDay(day.index);
                    onFocusStop(day.index, goal.placeId);
                  }}
                  className="max-w-full rounded-xl border border-line bg-card px-2.5 py-1.5 text-left transition hover:border-ink/25"
                >
                  {body}
                </button>
              ) : (
                <span
                  key={goal.experience}
                  className="max-w-full rounded-xl border border-dashed border-line bg-card/50 px-2.5 py-1.5"
                >
                  {body}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      <div className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
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
          全部攻略
        </button>
        {plan.days.map((day) => (
          <button
            key={day.index}
            type="button"
            onClick={() => onActiveDay(day.index)}
            className={cn(
              "inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
              activeDay === day.index
                ? "border-ink bg-ink text-paper"
                : "border-line bg-card text-ink-soft hover:border-ink/25",
            )}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: day.color }}
            />
            Day {day.index}
          </button>
        ))}
      </div>

      <div className="mt-3.5 space-y-4">
        {(shown.length ? shown : plan.days).map((day) => (
          <GuideDay
            key={day.index}
            day={day}
            city={plan.meta.city}
            focusPlaceId={focusPlaceId}
            hotelName={hotelName}
            onFocusStop={onFocusStop}
          />
        ))}
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-ink-faint">
        午餐和晚餐只安排时段与片区，具体吃哪家到现场再挑；参考店名只是同片区的首选。实景图来自高德 POI
        照片与维基共享资源，版权归原作者；没有可用实景图的点位，用漫城版式卡代替。钟点、门票与营业时间请以现场为准。
      </p>
    </div>
  );
}

function GuideDay({
  day,
  city,
  focusPlaceId,
  hotelName,
  onFocusStop,
}: {
  day: DayPlan;
  city: string;
  focusPlaceId?: string | null;
  hotelName: string;
  onFocusStop: (day: number, placeId: string) => void;
}) {
  const heroId =
    day.heroPlaceId ?? day.stops.find((stop) => stop.kind === "sight")?.place.id;
  const leadIndex = day.stops.findIndex((stop) => !stop.flexible);
  let order = 0;
  const numbers = new Map<string, number>();
  for (const stop of day.stops) {
    if (!stop.flexible) numbers.set(stop.id, ++order);
  }

  return (
    <article className="overflow-hidden rounded-2xl border border-line/70 bg-card">
      <header className="border-b border-line/50 bg-paper/45 px-3.5 py-3.5 sm:px-4">
        <div className="flex flex-wrap items-start gap-3">
          <span
            className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-full text-paper shadow-[0_8px_18px_-12px_rgba(35,42,36,0.7)]"
            style={{ background: day.color }}
          >
            <span className="text-micro tracking-[0.16em] opacity-75">DAY</span>
            <span className="text-[14px] font-semibold leading-none">
              {day.index}
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] tracking-[0.14em] text-ink-faint">
              {formatDateCN(day.date)} {weekdayCN(day.date)} · {day.area}
              {day.far ? " · 远足日" : ""}
            </p>
            <h3 className="mt-1 font-serif text-[21px] leading-tight tracking-wide text-ink">
              {day.theme}
            </h3>
          </div>
          {day.weather ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-card px-2.5 py-1 text-[11px] text-ink-soft"
              title={day.weather.label}
            >
              <Icon name={day.weather.icon} size={12} className="text-jade" />
              <span className="tabular-nums">
                {Math.round(day.weather.tMin)}°~{Math.round(day.weather.tMax)}°
              </span>
              {day.weather.precipProb !== undefined &&
              day.weather.precipProb >= 30 ? (
                <span className="text-accent-deep">
                  {Math.round(day.weather.precipProb)}%
                </span>
              ) : null}
            </span>
          ) : null}
        </div>

        {day.strategy ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-soft">
            {day.strategy}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
          <span className="inline-flex items-center gap-0.5">
            <Icon name="route" size={11} className="text-jade" />
            {day.stats.stopCount} 站
          </span>
          <span>{day.stats.distanceKm.toFixed(1)} km</span>
          <span>路上 {formatDuration(day.stats.travelMin)}</span>
          <span className="tabular-nums">
            {clockRange(day.startMin, day.endMin)}
          </span>
        </div>
        <PlanRhythmChips rhythm={day.rhythm} className="mt-2" />
      </header>

      <div className="px-3.5 py-3.5 sm:px-4">
        <div className="scroll-thin -mx-1 flex items-center gap-1 overflow-x-auto px-1 pb-1 text-[10.5px]">
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-jade-soft px-2.5 py-1 text-jade">
            <Icon name="home" size={10} />
            {hotelName}
          </span>
          {day.stops.map((stop) => (
            <span key={stop.id} className="inline-flex shrink-0 items-center gap-1">
              <Icon name="chevron-right" size={10} className="text-line" />
              <span className="inline-flex items-center gap-1 rounded-full border border-line/60 bg-card px-2.5 py-1 text-ink-soft">
                <Icon name={CATEGORY_ICONS[stop.place.category]} size={10} />
                {stop.place.name}
              </span>
            </span>
          ))}
          <span className="inline-flex shrink-0 items-center gap-1">
            <Icon name="chevron-right" size={10} className="text-line" />
            <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2.5 py-1 text-ink-faint">
              <Icon name="home" size={10} />
              回住处
            </span>
          </span>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {day.stops.map((stop, index) =>
            stop.flexible ? (
              <GuideMealCard
                key={stop.id}
                stop={stop}
                day={day}
                active={focusPlaceId === stop.place.id}
                onFocus={onFocusStop}
              />
            ) : (
              <GuideStopCard
                key={stop.id}
                stop={stop}
                day={day}
                city={city}
                number={numbers.get(stop.id) ?? stop.order}
                lead={index === leadIndex}
                hero={stop.place.id === heroId}
                active={focusPlaceId === stop.place.id}
                onFocus={onFocusStop}
              />
            ),
          )}
        </div>

        {day.tip ? (
          <p className="mt-3 rounded-xl bg-jade-soft/35 px-3 py-2.5 text-[11.5px] leading-relaxed text-ink-soft">
            <Icon
              name="sparkles"
              size={12}
              className="mr-1 inline translate-y-px text-jade"
            />
            {day.tip}
          </p>
        ) : null}

        {day.tips?.length ? (
          <div className="mt-2.5 grid gap-2 sm:grid-cols-2">
            {day.tips.map((tip) => (
              <div
                key={tip.id}
                className="rounded-xl border border-line/50 bg-paper/50 px-3 py-2.5"
              >
                <p className="flex items-center gap-1 text-[11.5px] font-medium text-ink">
                  <Icon
                    name={TIP_ICONS[tip.kind]}
                    size={12}
                    className="shrink-0 text-jade"
                  />
                  {tip.title}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">
                  {tip.body}
                </p>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function GuideMealCard({
  stop,
  day,
  active,
  onFocus,
}: {
  stop: StopPlan;
  day: DayPlan;
  active: boolean;
  onFocus: (day: number, placeId: string) => void;
}) {
  const tip = stop.tips?.[0];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onFocus(day.index, stop.place.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onFocus(day.index, stop.place.id);
        }
      }}
      className={cn(
        "flex cursor-pointer flex-col justify-center rounded-xl border border-dashed border-line/80 bg-paper/35 px-3.5 py-3 text-left transition hover:border-ink/20 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        active && "border-accent/55 bg-card ring-1 ring-accent/20",
      )}
    >
      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-ink-faint">
        <span className="font-medium tabular-nums text-ink-soft">
          {clockRange(stop.startMin, stop.endMin)}
        </span>
        <span>停留 {stop.dwellMin} 分</span>
        <span className="rounded bg-jade-soft px-1.5 py-px text-micro text-jade">
          自由选
        </span>
      </p>
      <h4 className="mt-1.5 flex items-center gap-1.5 font-serif text-[17px] leading-snug tracking-wide text-ink">
        <Icon name="utensils" size={13} className="text-jade" />
        {stop.place.name}
      </h4>
      {stop.note ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">
          {stop.note}
        </p>
      ) : null}
      {tip ? (
        <p className="mt-1.5 flex gap-1 text-[10.5px] leading-relaxed text-ink-faint">
          <Icon
            name={TIP_ICONS[tip.kind]}
            size={9}
            className="mt-0.5 shrink-0 text-jade"
          />
          <span className="min-w-0">
            <span className="font-medium text-ink-soft">{tip.title}</span> ·{" "}
            {tip.body}
          </span>
        </p>
      ) : null}
    </div>
  );
}

function GuideStopCard({
  stop,
  day,
  city,
  number,
  lead,
  hero,
  active,
  onFocus,
}: {
  stop: StopPlan;
  day: DayPlan;
  city: string;
  number: number;
  lead: boolean;
  hero: boolean;
  active: boolean;
  onFocus: (day: number, placeId: string) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onFocus(day.index, stop.place.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onFocus(day.index, stop.place.id);
        }
      }}
      className={cn(
        "group cursor-pointer overflow-hidden rounded-xl border border-line/60 bg-paper/25 text-left transition hover:border-ink/20 hover:bg-card hover:shadow-[0_14px_30px_-26px_rgba(35,42,36,0.6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        lead && "sm:col-span-2 sm:grid sm:grid-cols-[1.1fr_1fr]",
        hero && !active && "border-amber/40",
        active && "border-accent/55 bg-card ring-1 ring-accent/20",
      )}
    >
      <div className={cn("relative", lead && "sm:h-full")}>
        <PlacePhoto
          name={stop.place.name}
          city={city}
          lat={stop.place.lat}
          lng={stop.place.lng}
          qid={stop.place.wikidataId}
          image={stop.place.image}
          commons={stop.place.commons}
          category={stop.place.category}
          priority={lead}
          aspect={lead ? "aspect-[16/9] sm:aspect-auto" : "aspect-[16/10]"}
          className={lead ? "sm:h-full sm:min-h-[232px]" : undefined}
        />
        <span
          className="absolute left-2 top-2 inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold text-paper shadow-[0_6px_14px_-8px_rgba(35,42,36,0.8)]"
          style={{ background: day.color }}
        >
          {number}
        </span>
        {hero ? (
          <span className="absolute right-2 top-2 inline-flex items-center gap-0.5 rounded-full bg-amber-soft/95 px-2 py-0.5 text-micro text-amber backdrop-blur-sm">
            <Icon name="star" size={9} />
            主景
          </span>
        ) : null}
      </div>

      <div className="p-3.5">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-ink-faint">
          <span className="font-medium tabular-nums text-ink-soft">
            {clockRange(stop.startMin, stop.endMin)}
          </span>
          <span>停留 {stop.dwellMin} 分</span>
          <span className="rounded bg-paper px-1.5 py-px text-micro text-ink-soft">
            {STOP_KIND_LABELS[stop.kind]}
          </span>
        </p>
        <h4 className="mt-1.5 font-serif text-[16.5px] leading-snug tracking-wide text-ink">
          {stop.place.name}
        </h4>
        <p className="mt-0.5 text-[10.5px] tracking-wide text-ink-faint">
          {CATEGORY_LABELS[stop.place.category]}
          {stop.place.rating ? ` · ★ ${stop.place.rating.toFixed(1)}` : ""}
        </p>

        {stop.note ? (
          <p
            className={cn(
              "mt-2 text-[12px] leading-relaxed text-ink-soft",
              !lead && "line-clamp-3",
            )}
          >
            {stop.note}
          </p>
        ) : null}

        {stop.ticket || stop.place.openHours || stop.attrs?.length ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10px] text-ink-faint">
            {stop.ticket ? (
              <span className="inline-flex items-center gap-0.5">
                <Icon name="ticket" size={10} />
                门票 ¥{stop.ticket}
                {stop.estimatedTicket ? " 起" : ""}
              </span>
            ) : null}
            {stop.place.openHours ? (
              <span className="truncate">{stop.place.openHours}</span>
            ) : null}
            {stop.attrs?.slice(0, 3).map((attr) => (
              <span
                key={attr}
                className="rounded bg-jade-soft/70 px-1.5 py-px text-micro text-jade"
              >
                {attr}
              </span>
            ))}
          </div>
        ) : null}

        {stop.tips?.length ? (
          <div className="mt-2 space-y-1">
            {stop.tips.slice(0, 1).map((tip) => (
              <p
                key={tip.id}
                className="flex gap-1 text-[10.5px] leading-relaxed text-ink-soft"
              >
                <Icon
                  name={TIP_ICONS[tip.kind]}
                  size={10}
                  className="mt-0.5 shrink-0 text-jade"
                />
                <span className={cn("min-w-0", !lead && "line-clamp-2")}>
                  <span className="font-medium text-ink">{tip.title}</span>
                  <span className="text-ink-faint"> · </span>
                  {tip.body}
                </span>
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}