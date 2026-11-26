"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_LABELS, GUIDE_SAMPLE } from "@/lib/constants";
import type { GuideIndexItem, GuideRouteSummary } from "@/lib/guides/types";
import type {
  FixedPlace,
  GuideParseResult,
  GuideStop,
  Place,
} from "@/lib/types";
import { Icon } from "./Icon";
import { Spinner, cn } from "./ui";

type AppliedGuide = {
  id: string;
  title: string;
  city: string;
  routeId: string;
  routeTitle: string | null;
  days: number;
  stops: number;
};

type GuideResponse = {
  result?: GuideParseResult;
  error?: string;
  hint?: string;
  sourceNote?: string;
  guide?: AppliedGuide | null;
};

function guideLabel(guide: GuideIndexItem): string {
  const cleaned = guide.title.replace(/^我是驴友[-－—\s]*/, "");
  const name = guide.canonicalTitle ?? (cleaned && cleaned !== guide.city ? cleaned : "");
  return name ? `${guide.city} · ${name}` : `${guide.city} · ${guide.days} 天路线`;
}

function routeLabel(route: GuideRouteSummary): string {
  return route.title ?? `路线 ${route.id.replace(/^r/, "")}`;
}

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
  const [mode, setMode] = useState<"library" | "paste">("library");
  const [text, setText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<GuideParseResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [guides, setGuides] = useState<GuideIndexItem[] | null>(null);
  const [loadingGuides, setLoadingGuides] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [activeGuideId, setActiveGuideId] = useState<string>("");
  const [activeRouteId, setActiveRouteId] = useState<string>("");
  const [appliedGuide, setAppliedGuide] = useState<AppliedGuide | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    setOpen(false);
    setMode("library");
    setText("");
    setResult(null);
    setSelected(new Set());
    setError(null);
    setParsing(false);
    setGuides(null);
    setLibraryError(null);
    setActiveGuideId("");
    setActiveRouteId("");
    setAppliedGuide(null);
  }, [resetKey]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch("/api/guide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city, hotel, days: 3, prewarm: true }),
      signal: controller.signal,
    }).catch(() => {});
    return () => controller.abort();
  }, [open, city, hotel]);

  useEffect(() => {
    if (!open || mode !== "library" || guides !== null) return;
    let cancelled = false;
    setLoadingGuides(true);
    setLibraryError(null);
    fetch(`/api/guides?city=${encodeURIComponent(city)}`)
      .then((response) => response.json())
      .then((data: { guides?: GuideIndexItem[] }) => {
        if (cancelled) return;
        const list = (data.guides ?? []).filter(
          (item) => item.routeCount > 0 && item.canonicalRouteId,
        );
        setGuides(list);
        const first = list[0];
        if (first) {
          setActiveGuideId(first.id);
          setActiveRouteId(
            first.canonicalRouteId ?? first.routes[0]?.id ?? "",
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLibraryError("攻略库没有响应，可以先改用粘贴游记。");
          setGuides([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingGuides(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, city, guides]);

  const activeGuide = useMemo(
    () => guides?.find((item) => item.id === activeGuideId) ?? null,
    [guides, activeGuideId],
  );
  const activeRoute = useMemo(
    () =>
      activeGuide?.routes.find((route) => route.id === activeRouteId) ??
      activeGuide?.routes[0] ??
      null,
    [activeGuide, activeRouteId],
  );

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

  async function requestGuide(payload: Record<string, unknown>) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setParsing(true);
    setError(null);
    try {
      const response = await fetch("/api/guide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, hotel, days: 3, ...payload }),
        signal: controller.signal,
      });
      const data: GuideResponse = await response.json();
      if (!response.ok || !data.result) {
        setError(
          data.hint
            ? `${data.error ?? "解析失败"}：${data.hint}`
            : (data.error ?? "解析失败，请稍后再试"),
        );
        return null;
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
      return data;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      setError("解析服务没有响应，请稍后重试。");
      return null;
    } finally {
      if (abortRef.current === controller) setParsing(false);
    }
  }

  async function parse() {
    const content = text.trim();
    if (content.length < 10) {
      setError("再多贴一点内容吧，至少包含一个地点或一天的安排。");
      return;
    }
    setAppliedGuide(null);
    await requestGuide({ text: content });
  }

  async function parseLibrary() {
    if (!activeGuide || !activeRoute) return;
    const data = await requestGuide({
      guideId: activeGuide.id,
      routeId: activeRoute.id,
    });
    if (data?.guide) setAppliedGuide(data.guide);
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
          <span className="block text-[13px] font-medium text-ink">
            导入现成攻略
          </span>
          <span className="mt-0.5 block text-[11px] text-ink-faint">
            从攻略库选一条路线，或粘贴游记复刻
          </span>
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-faint">
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
            <div className="flex items-center gap-2 rounded-lg bg-jade-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-jade">
              <Icon name="check" size={12} className="shrink-0" />
              <span className="min-w-0 flex-1">
                已采用 {appliedCount} 个攻略点，行程已按攻略日期与顺序重排。
                {appliedGuide ? (
                  <span className="mt-0.5 block text-[10.5px] opacity-75">
                    来源《{appliedGuide.title}》·{" "}
                    {appliedGuide.routeTitle ??
                      `路线 ${appliedGuide.routeId.replace(/^r/, "")}`}
                  </span>
                ) : null}
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

          <div className="grid grid-cols-2 gap-1 rounded-full bg-paper p-0.5 text-[11.5px]">
            <button
              type="button"
              onClick={() => setMode("library")}
              className={cn(
                "rounded-full py-1.5 transition",
                mode === "library"
                  ? "bg-card text-ink shadow-sm"
                  : "text-ink-faint hover:text-ink-soft",
              )}
            >
              从攻略库选
            </button>
            <button
              type="button"
              onClick={() => setMode("paste")}
              className={cn(
                "rounded-full py-1.5 transition",
                mode === "paste"
                  ? "bg-card text-ink shadow-sm"
                  : "text-ink-faint hover:text-ink-soft",
              )}
            >
              粘贴游记
            </button>
          </div>

          {mode === "library" ? (
            <div className="space-y-2">
              {loadingGuides ? (
                <p className="flex items-center gap-2 text-[11.5px] text-ink-faint">
                  <Spinner className="h-3 w-3" />
                  正在翻攻略库…
                </p>
              ) : null}
              {libraryError ? (
                <p className="rounded-lg bg-accent-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-accent-deep">
                  {libraryError}
                </p>
              ) : null}
              {guides && guides.length === 0 && !loadingGuides ? (
                <p className="rounded-lg bg-paper px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-soft">
                  攻略库里还没有「{city}」的路线。可以切到「粘贴游记」，或换一座城市。
                </p>
              ) : null}
              {guides && guides.length > 0 && activeGuide ? (
                <>
                  <label className="block">
                    <span className="mb-1 block text-[10.5px] tracking-[0.16em] text-ink-faint">
                      攻略
                    </span>
                    <select
                      value={activeGuide.id}
                      onChange={(event) => {
                        const next = guides.find(
                          (item) => item.id === event.target.value,
                        );
                        setActiveGuideId(event.target.value);
                        setActiveRouteId(
                          next?.canonicalRouteId ??
                            next?.routes[0]?.id ??
                            "",
                        );
                      }}
                      className="w-full rounded-xl border border-line bg-paper/60 px-2.5 py-2 text-[12.5px] text-ink focus:border-ink/25 focus:outline-none"
                    >
                      {guides.map((item) => (
                        <option key={item.id} value={item.id}>
                          {guideLabel(item)} · {item.days} 天
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="flex flex-wrap gap-1.5">
                    {activeGuide.routes.map((route) => {
                      const active = route.id === activeRoute?.id;
                      return (
                        <button
                          key={route.id}
                          type="button"
                          onClick={() => setActiveRouteId(route.id)}
                          className={cn(
                            "rounded-full border px-2.5 py-1 text-[11px] transition",
                            active
                              ? "border-ink bg-ink text-paper"
                              : "border-line bg-card text-ink-soft hover:border-ink/25 hover:text-ink",
                          )}
                        >
                          {routeLabel(route)} · {route.days}天{route.stops}点
                        </button>
                      );
                    })}
                  </div>

                  {activeRoute?.needsReview ? (
                    <p className="text-[10.5px] leading-relaxed text-amber">
                      这条路线是从旧攻略里自动抽出来的，个别顺序可能需要你核对。
                    </p>
                  ) : null}

                  <div className="flex items-center gap-2">
                    <span className="text-[10.5px] text-ink-faint">
                      {city}共 {guides.length} 份攻略
                    </span>
                    <button
                      type="button"
                      onClick={parseLibrary}
                      disabled={parsing || busy || !activeRoute}
                      className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[12px] text-paper transition hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {parsing ? (
                        <Spinner className="h-3 w-3" />
                      ) : (
                        <Icon name="sparkles" size={12} />
                      )}
                      {parsing ? "正在识别地点…" : "解析这条路线"}
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <>
              <div className="relative">
                <textarea
                  value={text}
                  onChange={(event) =>
                    setText(event.target.value.slice(0, 8000))
                  }
                  rows={5}
                  placeholder="把游记或攻略整段贴进来，例如：Day 1 上午先去八市吃沙茶面，然后逛中山路……"
                  className="scroll-thin w-full resize-y rounded-xl border border-line bg-paper/60 px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint/85 focus:border-ink/25 focus:outline-none"
                />
                <span className="pointer-events-none absolute bottom-2 right-3 text-[10.5px] tabular-nums text-ink-faint">
                  {text.length} / 8000
                </span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setText(GUIDE_SAMPLE)}
                  className="rounded-full border border-line bg-card px-3 py-2 text-[12px] text-ink-soft transition hover:border-ink/25 hover:text-ink"
                >
                  填入示例
                </button>
                <button
                  type="button"
                  onClick={parse}
                  disabled={parsing || busy}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[12px] text-paper transition hover:bg-ink/85 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {parsing ? (
                    <Spinner className="h-3 w-3" />
                  ) : (
                    <Icon name="sparkles" size={12} />
                  )}
                  {parsing ? "正在识别地点…" : "解析攻略"}
                </button>
              </div>
            </>
          )}

          {error ? (
            <p className="rounded-lg bg-accent-soft px-2.5 py-2 text-[11.5px] leading-relaxed text-accent-deep">
              {error}
            </p>
          ) : null}

          {result ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
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
                      <span className="font-serif text-[13px] text-ink">
                        Day {day}
                      </span>
                      <span className="text-[10.5px] text-ink-faint">
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
                              "flex cursor-pointer items-start gap-2 rounded-lg px-2 py-2 transition",
                              checked ? "bg-card/80" : "opacity-60 hover:opacity-90",
                            )}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                toggleStop(stop.day, stop.place!.id)
                              }
                              className="mt-0.5 h-4 w-4 accent-[#c15a36]"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[12px] text-ink">
                                  {stop.place.name}
                                </span>
                                {stop.confidence < 0.7 ? (
                                  <span className="shrink-0 rounded bg-amber-soft px-1 py-px text-micro text-amber">
                                    {stop.confidence < 0.55 ? "低置信" : "相近"}
                                  </span>
                                ) : null}
                              </span>
                              <span className="mt-0.5 block truncate text-[10.5px] text-ink-faint">
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
                <p className="text-[10.5px] leading-relaxed text-ink-faint">
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
                <p className="text-[10.5px] leading-relaxed text-ink-faint">
                  {result.notes.slice(0, 2).join(" ")}
                </p>
              ) : null}

              <div className="flex items-center gap-2">
                <span className="text-[11px] text-ink-faint">
                  已选 {selectedStops.length} 个
                </span>
                <button
                  type="button"
                  onClick={apply}
                  disabled={!selectedStops.length || busy}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-accent px-4 py-2 text-[12px] text-paper transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Icon name="route" size={12} />
                  {appliedCount > 0 ? "重新采用" : "按攻略安排"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
