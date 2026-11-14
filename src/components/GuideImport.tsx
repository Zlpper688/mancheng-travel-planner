"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_LABELS, GUIDE_SAMPLE } from "@/lib/constants";
import type {
  FixedPlace,
  GuideParseResult,
  GuideStop,
  Place,
} from "@/lib/types";
import { Icon } from "./Icon";
import { Spinner, cn } from "./ui";

type GuideResponse = {
  result?: GuideParseResult;
  error?: string;
  hint?: string;
  sourceNote?: string;
};

export interface GuideImportProps {
  city: string;
  hotel: Place;
  resetKey: number;
  busy: boolean;
  appliedCount: number;
  onApply: (fixed: FixedPlace[], guideDays: number) => void;
  onClear: () => void;
}

function stopKey(day: number, placeId: string): string {
  return `${day}:${placeId}`;
}

export default function GuideImport({
  city,
  hotel,
  resetKey,
  busy,
  appliedCount,
  onApply,
  onClear,
}: GuideImportProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<GuideParseResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    setOpen(false);
    setText("");
    setResult(null);
    setSelected(new Set());
    setError(null);
    setParsing(false);
  }, [resetKey]);

  const groups = useMemo(() => {
    if (!result) return [];
    const map = new Map<number, GuideStop[]>();
    for (const stop of result.stops) {
      const list = map.get(stop.day) ?? [];
      list.push(stop);
      map.set(stop.day, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [result]);

  const selectedStops = useMemo(
    () =>
      result
        ? result.stops.filter(
            (stop) =>
              stop.place && selected.has(stopKey(stop.day, stop.place.id)),
          )
        : [],
    [result, selected],
  );

  async function parse() {
    const content = text.trim();
    if (content.length < 10) {
      setError("再多贴一点内容吧，至少包含一个地点或一天的安排。");
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setParsing(true);
    setError(null);
    try {
      const response = await fetch("/api/guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: content, city, hotel, days: 3 }),
        signal: controller.signal,
      });
      const data: GuideResponse = await response.json();
      if (!response.ok || !data.result) {
        setError(
          data.hint
            ? `${data.error ?? "解析失败"}：${data.hint}`
            : (data.error ?? "解析失败，请稍后再试"),
        );
        return;
      }
      setResult(data.result);
      setSelected(
        new Set(
          data.result.stops
            .filter((stop) => stop.place)
            .map((stop) => stopKey(stop.day, stop.place!.id)),
        ),
      );
      setOpen(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError("解析服务没有响应，请稍后重试。");
    } finally {
      setParsing(false);
    }
  }

  function toggleStop(day: number, placeId: string) {
    const key = stopKey(day, placeId);
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function apply() {
    if (!result || !selectedStops.length) return;
    const fixed: FixedPlace[] = selectedStops
      .filter((stop): stop is GuideStop & { place: Place } => Boolean(stop.place))
      .map((stop) => ({ place: stop.place, day: stop.day }))
      .sort((a, b) => a.day - b.day);
    onApply(fixed, result.days);
  }

  return (
    <div className="rounded-2xl border border-line bg-card/70">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3.5 py-3 text-left"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-paper text-ink-soft">
          <Icon name="book-open" size={14} />
        </span>
        <span className="min-w-0">
          <span className="block text-[12px] font-medium text-ink">
            导入现成攻略
          </span>
          <span className="mt-0.5 block text-[10px] text-ink-faint">
            粘贴别人的游记，按原文顺序复刻
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] text-ink-faint">
          {appliedCount > 0 ? `已采用 ${appliedCount} 个` : open ? "收起" : "展开"}
          <Icon
            name="chevron-down"
            size={13}
            className={cn("mc-chevron", open && "rotate-180")}
          />
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-line/70 px-3.5 py-3">
          {appliedCount > 0 ? (
            <div className="flex items-center gap-2 rounded-lg bg-jade-soft px-2.5 py-2 text-[10px] leading-relaxed text-jade">
              <Icon name="check" size={12} className="shrink-0" />
              <span className="min-w-0 flex-1">
                已采用 {appliedCount} 个攻略点，行程已按攻略日期与顺序重排。
              </span>
              <button
                type="button"
                onClick={onClear}
                className="shrink-0 underline underline-offset-2 hover:text-ink"
              >
                取消复刻
              </button>
            </div>
          ) : null}

          <div className="relative">
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value.slice(0, 8000))}
              rows={5}
              placeholder="把游记或攻略整段贴进来，例如：Day 1 上午先去八市吃沙茶面，然后逛中山路……"
              className="scroll-thin w-full resize-y rounded-xl border border-line bg-paper/60 px-3 py-2.5 text-[11px] leading-relaxed text-ink placeholder:text-ink-faint/70 focus:border-ink/25 focus:outline-none"
            />
            <span className="pointer-events-none absolute bottom-2 right-3 text-[9px] tabular-nums text-ink-faint">
              {text.length} / 8000
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setText(GUIDE_SAMPLE)}
              className="rounded-full border border-line bg-card px-2.5 py-1.5 text-[10px] text-ink-soft transition hover:border-ink/25 hover:text-ink"
            >
              填入示例
            </button>
            <button
              type="button"
              onClick={parse}
              disabled={parsing || busy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1.5 text-[11px] text-paper transition hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {parsing ? <Spinner className="h-3 w-3" /> : <Icon name="sparkles" size={12} />}
              {parsing ? "正在识别地点…" : "解析攻略"}
            </button>
          </div>

          {error ? (
            <p className="rounded-lg bg-accent-soft px-2.5 py-2 text-[10px] leading-relaxed text-accent-deep">
              {error}
            </p>
          ) : null}

          {result ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-[10px] text-ink-faint">
                <span className="rounded-full bg-paper px-2 py-0.5 text-ink-soft">
                  识别出 {result.days} 天
                </span>
                <span>{result.stops.length} 个可定位停靠点</span>
                {result.rawCount > result.stops.length ? (
                  <span>· 原文 {result.rawCount} 处</span>
                ) : null}
              </div>

              <div className="scroll-thin max-h-[300px] space-y-2 overflow-y-auto pr-1">
                {groups.map(([day, stops]) => (
                  <div
                    key={day}
                    className="rounded-xl border border-line/80 bg-paper/45"
                  >
                    <div className="flex items-center justify-between px-2.5 py-1.5">
                      <span className="font-serif text-[12px] text-ink">
                        Day {day}
                      </span>
                      <span className="text-[9px] text-ink-faint">
                        {stops.length} 个点
                      </span>
                    </div>
                    <div className="space-y-0.5 px-1.5 pb-1.5">
                      {stops.map((stop) => {
                        if (!stop.place) return null;
                        const key = stopKey(stop.day, stop.place.id);
                        const checked = selected.has(key);
                        return (
                          <label
                            key={key}
                            className={cn(
                              "flex cursor-pointer items-start gap-2 rounded-lg px-1.5 py-1.5 transition",
                              checked ? "bg-card/80" : "opacity-60 hover:opacity-90",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                toggleStop(stop.day, stop.place!.id)
                              }
                              className="mt-0.5 h-3 w-3 accent-[#c15a36]"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[11px] text-ink">
                                  {stop.place.name}
                                </span>
                                {stop.confidence < 0.7 ? (
                                  <span className="shrink-0 rounded bg-amber-soft px-1 py-px text-[8px] text-amber">
                                    {stop.confidence < 0.55 ? "低置信" : "相近"}
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block truncate text-[9px] text-ink-faint">
                                {CATEGORY_LABELS[stop.place.category]} · 原文「
                                {stop.query}」
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {result.unmatched.length > 0 ? (
                <p className="text-[9px] leading-relaxed text-ink-faint">
                  未在数据里找到：
                  {result.unmatched
                    .slice(0, 6)
                    .map((item) => item.query)
                    .join("、")}
                  {result.unmatched.length > 6
                    ? ` 等 ${result.unmatched.length} 处`
                    : ""}
                </p>
              ) : null}

              {result.notes.length > 0 ? (
                <p className="text-[9px] leading-relaxed text-ink-faint">
                  {result.notes.slice(0, 2).join(" ")}
                </p>
              ) : null}

              <div className="flex items-center gap-2">
                <span className="text-[10px] text-ink-faint">
                  已选 {selectedStops.length} 个
                </span>
                <button
                  type="button"
                  onClick={apply}
                  disabled={!selectedStops.length || busy}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[11px] text-paper transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="route" size={12} />
                  {appliedCount > 0 ? "重新采用" : "按攻略排线"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
