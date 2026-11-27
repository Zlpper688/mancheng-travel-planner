"use client";

import { useState } from "react";
import { hasTicketInfo, navUrl, ticketSearchUrl } from "@/lib/booking";
import { CATEGORY_LABELS, STOP_KIND_LABELS, TIP_ICONS } from "@/lib/constants";
import { clockRange } from "@/lib/format";
import type { DayPlan, StopPlan } from "@/lib/types";
import { Icon } from "../Icon";
import { cn } from "../ui";

/**
 * 一个点位卡：时刻、停留、门票、导航/查票、贴士、锁定/替换/移除。
 *
 * 从 PlanPanel 里拆出来——它不依赖父组件任何状态，只吃 props，
 * 单独放一个文件后，PlanPanel 的主干（日卡、时间轴、预算）读起来才连贯。
 */

export default function StopRow({
  stop,
  day,
  city,
  number,
  active,
  locked,
  onFocus,
  onToggleLock,
  onReplace,
  onRemove,
}: {
  stop: StopPlan;
  day: DayPlan;
  city: string;
  number?: number;
  active: boolean;
  locked: boolean;
  onFocus: (placeId: string) => void;
  onToggleLock?: () => void;
  onReplace?: () => void;
  onRemove?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meal = stop.kind !== "sight";
  const tips = stop.tips ?? [];
  const visibleTips = expanded ? tips : tips.slice(0, 2);
  const hero = stop.kind === "sight" && day.heroPlaceId === stop.place.id;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onFocus(stop.place.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onFocus(stop.place.id);
        }
      }}
      className={cn(
        "group w-full cursor-pointer rounded-xl border border-line/60 bg-card px-3.5 py-3 text-left transition hover:border-ink/20 hover:shadow-[0_10px_24px_-20px_rgba(35,42,36,0.5)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        hero && !active && "border-amber/40 bg-amber-soft/15",
        locked && !active && "border-jade/45 ring-1 ring-jade/15",
        active && "border-accent/55 bg-accent-soft/20 ring-1 ring-accent/20",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center text-[11.5px] font-semibold text-paper",
            meal ? "rotate-45 rounded-[6px]" : "rounded-full",
          )}
          style={{ background: day.color }}
        >
          <span className={meal ? "-rotate-45" : undefined}>
            {stop.flexible ? <Icon name="clock" size={10} /> : number}
          </span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[13.5px] font-medium text-ink">
              {stop.place.name}
            </span>
            {stop.flexible ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 self-center rounded bg-jade-soft px-1.5 py-px text-micro text-jade">
                <Icon name="clock" size={8} />
                自由选
              </span>
            ) : (
              <span className="shrink-0 text-[10.5px] text-ink-faint">
                {STOP_KIND_LABELS[stop.kind]}
              </span>
            )}
            {hero ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-soft px-1 py-px text-micro text-amber">
                <Icon name="star" size={8} />
                主景
              </span>
            ) : null}
            {locked ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-jade-soft px-1 py-px text-micro text-jade">
                <Icon name="lock" size={8} />
                锁定
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 block truncate text-[10.5px] text-ink-faint">
            {clockRange(stop.startMin, stop.endMin)} · 停留 {stop.dwellMin} 分 ·{" "}
            {stop.flexible ? "用餐时段" : CATEGORY_LABELS[stop.place.category]}
          </span>
        </span>
        <Icon
          name="chevron-right"
          size={12}
          className="shrink-0 text-ink-faint transition group-hover:translate-x-0.5 group-hover:text-ink"
        />
      </div>
      {stop.note ? (
        <p className="mt-1.5 pl-8 text-[11.5px] leading-relaxed text-ink-soft">
          {stop.note}
        </p>
      ) : null}
      {stop.ticket || stop.place.rating || stop.place.openHours ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-8 text-[10.5px] text-ink-faint">
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
      {!meal ? (
        // 落地支持：导航到点 + 查票入口。只跳转，不碰支付（宪法第 11 节）。
        // stopPropagation 避免点链接时父级 onFocus 把地图也拽过去。
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-8">
          <a
            href={navUrl(stop.place)}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2 py-0.5 text-micro text-ink-soft transition hover:border-jade/40 hover:text-jade"
          >
            <Icon name="route" size={9} />
            导航
          </a>
          {hasTicketInfo(stop, city) ? (
            <a
              href={ticketSearchUrl(stop.place, city)}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => event.stopPropagation()}
              className="inline-flex items-center gap-1 rounded-full border border-line bg-paper px-2 py-0.5 text-micro text-ink-soft transition hover:border-accent/40 hover:text-accent"
            >
              <Icon name="ticket" size={9} />
              查票
            </a>
          ) : null}
        </div>
      ) : null}
      {stop.attrs?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-8">
          {stop.attrs.map((attr) => (
            <span
              key={attr}
              className="rounded bg-jade-soft/70 px-1.5 py-px text-micro text-jade"
            >
              {attr}
            </span>
          ))}
        </div>
      ) : null}
      {tips.length ? (
        <div className="mt-1.5 space-y-1 pl-8">
          {visibleTips.map((tip) => (
            <div
              key={tip.id}
              className="flex gap-1 text-[11px] leading-relaxed text-ink-soft"
            >
              <Icon
                name={TIP_ICONS[tip.kind]}
                size={9}
                className="mt-0.5 shrink-0 text-jade"
              />
              <span className="min-w-0">
                <span className="font-medium text-ink">{tip.title}</span>
                <span className="text-ink-faint"> · </span>
                {tip.body}
                {expanded ? (
                  <span className="mt-0.5 block text-[10px] text-ink-faint">
                    来源：{tip.source}
                  </span>
                ) : null}
              </span>
            </div>
          ))}
          {tips.length > 2 ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((value) => !value);
              }}
              className="text-[11.5px] text-jade hover:underline"
            >
              {expanded ? "收起点位贴士" : `展开另外 ${tips.length - 2} 条`}
            </button>
          ) : null}
        </div>
      ) : null}
      {/* 常驻显示：藏在悬停背后的操作等于没有，用户要先看见「能改」才敢改。
          对话里的只读手册不给按钮，免得点了没反应。 */}
      {onReplace && onRemove ? (
      <div className="mt-2 flex flex-wrap items-center gap-1 pl-8">
        {stop.kind === "sight" && onToggleLock ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleLock();
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition",
              locked
                ? "border-jade/45 bg-jade-soft text-jade"
                : "border-line bg-card text-ink-faint hover:border-ink/25 hover:text-ink",
            )}
            title={
              locked
                ? "解除锁定，之后重排可能会换掉它"
                : "锁定这个点，换一版时保留在原定那天"
            }
          >
            <Icon name={locked ? "lock" : "unlock"} size={10} />
            {locked ? "已锁定" : "锁定"}
          </button>
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onReplace();
          }}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-2 py-1 text-[11px] text-ink-faint transition hover:border-ink/25 hover:text-ink"
          title="换一个同类点位，其余行程尽量不动"
        >
          <Icon name="shuffle" size={10} />
          换一个
        </button>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="inline-flex items-center gap-1 rounded-full border border-line bg-card px-2 py-1 text-[11px] text-ink-faint transition hover:border-amber/50 hover:text-amber"
          title="从行程里移除，当天会少排一个点"
        >
          <Icon name="x" size={10} />
          移除
        </button>
      </div>
      ) : null}
    </div>
  );
}
