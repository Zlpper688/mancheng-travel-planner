"use client";

import { useState } from "react";
import { bookingSummary, collectBookings, reservationCount } from "@/lib/booking";
import type { PlanResult } from "@/lib/types";
import { Icon } from "../Icon";


export default function BookingCard({ plan, city }: { plan: PlanResult; city: string }) {
  const [open, setOpen] = useState(false);
  const items = collectBookings(plan, city);
  if (!items.length) return null;
  const must = reservationCount(items);
  const visible = open ? items : items.slice(0, 3);
  return (
    <div className="mt-2 rounded-xl border border-amber/30 bg-amber-soft/40 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="inline-flex items-center gap-1.5 text-meta font-medium text-amber">
          <Icon name="ticket" size={10} />
          行前待办 · {must ? `${must} 件要提前约` : `${items.length} 处要买票`}
        </span>
        <span className="text-micro text-amber/80">{open ? "收起" : "展开"}</span>
      </button>
      <p className="mt-1 text-micro leading-relaxed text-ink-soft">
        {bookingSummary(items)}
      </p>
      <ul className="mt-1.5 space-y-1">
        {visible.map((item) => (
          <li key={`${item.placeId}-${item.day}`} className="flex gap-1.5 text-micro">
            <span className="shrink-0 tabular-nums text-ink-faint">
              D{item.day}
            </span>
            <span className="min-w-0">
              <span className="font-medium text-ink">{item.placeName}</span>
              <span className="text-ink-faint"> · </span>
              <span className="text-ink-soft">{item.booking}</span>
              {item.note ? (
                <span className="text-ink-faint">（{item.note}）</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {items.length > 3 ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="mt-1 text-micro text-amber underline-offset-2 hover:underline"
        >
          {open ? "只看前 3 条" : `还有 ${items.length - 3} 条`}
        </button>
      ) : null}
      <p className="mt-1.5 text-micro text-ink-faint">
        票务与放票规则以官方最新公告为准；这里只做提醒和跳转，不代办购买。
      </p>
    </div>
  );
}

