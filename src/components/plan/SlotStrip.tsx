import { SLOT_PERIOD_LABELS, type DaySlot, type SlotPeriod } from "@/lib/types";
import { cn } from "../ui";


export default function SlotStrip({ slots }: { slots?: DaySlot[] }) {
  if (!slots?.length) return null;
  const label = (period: SlotPeriod) => SLOT_PERIOD_LABELS[period];
  return (
    <div className="mt-2 rounded-xl border border-line/70 bg-paper/60 px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="text-micro text-ink-faint">一天的节奏</span>
        <span className="text-micro tabular-nums text-ink-faint">
          {slots.filter((s) => s.stops.length).length}/6 段有安排
        </span>
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {slots.map((slot) => {
          const filled = slot.stops.length > 0;
          return (
            <div
              key={slot.period}
              title={filled ? slot.stops.map((s) => s.place.name).join("、") : slot.emptyHint}
              className={cn(
                "rounded-lg border px-1.5 py-1 text-micro",
                filled
                  ? "border-jade/30 bg-jade-soft/60 text-ink"
                  : "border-line/50 bg-card/60 text-ink-faint",
              )}
            >
              <div className="font-medium">{label(slot.period)}</div>
              <div className="mt-0.5 truncate">
                {filled ? (slot.intent ?? `${slot.stops.length} 个点`) : "留白"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 行前待办（宪法 B 块）：把散在各点位上的预约/票务汇总成一张清单。
 * 不新造数据，只做聚合——免得用户翻完整个行程才发现鼓浪屿要实名船票。
 */
