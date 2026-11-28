import type { LodgingPlan } from "@/lib/types";
import { Icon } from "../Icon";

/** 住宿建议：主住 + 可选换宿，以及为什么这么建议。 */

export default function LodgingCard({ lodging }: { lodging: LodgingPlan }) {
  return (
    <div className="mt-2.5 rounded-2xl border border-jade/25 bg-jade-soft/40 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-jade">
        <Icon name="home" size={11} />
        {lodging.headline}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-ink-soft">
        {lodging.summary}
      </p>
      <div className="mt-2 space-y-1.5">
        {lodging.bases.map((base) => (
          <div key={base.id} className="rounded-xl bg-card/70 px-2.5 py-1.5">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-[11.5px] font-medium text-ink">
                {base.name}
              </span>
              <span className="text-micro tracking-wide text-ink-faint">
                {base.role === "main" ? "主住" : "可选换宿"}
                {base.nights.length ? ` · 第 ${base.nights.join("、")} 晚` : ""}
              </span>
            </div>
            <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-faint">
              {base.reason}
              {base.tradeoff ? ` ${base.tradeoff}` : ""}
            </p>
          </div>
        ))}
      </div>
      {lodging.notes.length ? (
        <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">
          {lodging.notes.join(" ")}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 六段骨架条：把一天的时段结构摊开给人看。
 * 有内容的段显示意图，空段给留白话术（不静默留白）。这是宪法 Step 2 的展示入口；
 * stops 逐条列表仍是排线真源，这里只做结构概览，零回归。
 */
