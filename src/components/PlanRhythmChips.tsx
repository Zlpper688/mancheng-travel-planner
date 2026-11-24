"use client";

import type { DayPlan } from "@/lib/types";
import { Icon } from "./Icon";
import { cn } from "./ui";

const CHIPS: {
  key: keyof NonNullable<DayPlan["rhythm"]>;
  label: string;
  icon: string;
}[] = [
  { key: "sunrise", label: "看日出", icon: "sunrise" },
  { key: "early", label: "早出门", icon: "clock" },
  { key: "indoorMidday", label: "午间室内", icon: "building" },
  { key: "sunset", label: "等日落", icon: "sunset" },
  { key: "night", label: "夜逛", icon: "moon" },
];

export default function PlanRhythmChips({
  rhythm,
  className,
}: {
  rhythm?: DayPlan["rhythm"];
  className?: string;
}) {
  if (!rhythm) return null;
  const active = CHIPS.filter((chip) => rhythm[chip.key]);
  if (!active.length) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {active.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1 rounded-full bg-paper/80 px-2 py-0.5 text-[10px] text-ink-soft"
        >
          <Icon name={chip.icon} size={9} className="text-jade" />
          {chip.label}
        </span>
      ))}
    </div>
  );
}