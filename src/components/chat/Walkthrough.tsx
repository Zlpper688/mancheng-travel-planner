"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_LABELS } from "@/lib/constants";
import { clockRange, countdown } from "@/lib/format";
import type { PlanResult } from "@/lib/types";
import {
  buildWalkRoute,
  pointAlong,
  WALK_MODE_LABELS,
  type WalkDwell,
  type WalkRoute,
  type WalkSegment,
  type WalkStop,
} from "@/lib/walk";
import type { WalkApi, WalkPose } from "../MapView";
import { Icon } from "../Icon";
import { cn } from "../ui";

interface WalkthroughProps {
  plan: PlanResult;
  dayIndex: number;
  hotelName: string;
  api: WalkApi | null;
  onDayChange: (day: number) => void;
  onClose: () => void;
  onFocusStop: (placeId: string) => void;
  onFinish?: () => void;
}

function stopTitle(stop: WalkStop): string {
  if (!stop.flexible) return stop.name;
  if (stop.slot === "lunch") return "午餐时段";
  if (stop.slot === "dinner") return "晚餐时段";
  return "茶歇时段";
}

function flexibleNote(stop: WalkStop): string {
  if (stop.slot === "dinner") {
    return "这一段不绑死餐厅：回住处前就近找一家，吃完正好收工。";
  }
  if (stop.slot === "cafe") {
    return "走累了就进一家咖啡店或茶馆，坐下来缓一缓再继续。";
  }
  return "这一段不绑死餐厅：就近挑一家顺眼的，吃完按路线继续。临时想换，直接跟我说。";
}

function stopSpeech(route: WalkRoute, segment: WalkDwell): string {
  const stop = segment.stop;
  if (stop.flexible) {
    return stop.slot === "lunch"
      ? "午餐时间。就近挑一家顺眼的，吃完按路线继续。"
      : stop.slot === "dinner"
        ? "晚餐时间。附近找一家，吃完就回住处。"
        : "茶歇时间。来杯咖啡或茶，缓一缓再走。";
  }
  const tip = stop.tips[0]
    ? ` ${stop.tips[0].title}：${stop.tips[0].body}`
    : "";
  return `第${stop.index + 1}站，${stop.name}。${stop.note ?? "慢慢逛，不用赶。"}${tip}`;
}

function poseFor(
  segment: WalkSegment,
  elapsed: number,
  fallbackBearing: number,
): WalkPose {
  if (segment.kind === "dwell") {
    return {
      lng: segment.lng,
      lat: segment.lat,
      bearing: fallbackBearing,
      moving: false,
    };
  }
  const progress = Math.min(1, Math.max(0, elapsed / segment.seconds));
  const point = pointAlong(segment, progress);
  return {
    lng: point.lng,
    lat: point.lat,
    bearing: point.bearing,
    moving: progress < 0.995,
  };
}

function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export default function Walkthrough({
  plan,
  dayIndex,
  hotelName,
  api,
  onDayChange,
  onClose,
  onFocusStop,
  onFinish,
}: WalkthroughProps) {
  const route = useMemo(
    () => buildWalkRoute(plan, dayIndex),
    [plan, dayIndex],
  );
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [voice, setVoice] = useState(true);
  const [follow, setFollow] = useState(true);

  const routeRef = useRef<WalkRoute | null>(route);
  const apiRef = useRef<WalkApi | null>(api);
  const voiceRef = useRef(voice);
  const followRef = useRef(follow);
  const onFinishRef = useRef(onFinish);
  const stateRef = useRef({ seg: 0, elapsed: 0, playing: false });
  const timerRef = useRef<number | null>(null);
  const lastFrameRef = useRef(0);
  const lastBearingRef = useRef(90);
  const lastPoseRef = useRef<WalkPose | null>(null);
  const progressRef = useRef<HTMLDivElement | null>(null);
  const finishedRef = useRef(false);
  const tickRef = useRef<(ts: number) => void>(() => {});

  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  useEffect(() => {
    voiceRef.current = voice;
    if (!voice && speechAvailable()) window.speechSynthesis.cancel();
  }, [voice]);

  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  const speak = useCallback((text: string) => {
    if (!voiceRef.current || !speechAvailable()) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-CN";
      utterance.rate = 1.02;
      utterance.pitch = 1.05;
      window.speechSynthesis.speak(utterance);
    } catch {
      // 浏览器没有语音引擎时，文字讲解照常。
    }
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      tickRef.current(performance.now());
    }, 40);
  }, []);

  const updateProgress = useCallback(
    (target: WalkRoute, segmentIndex: number, elapsed: number) => {
      const node = progressRef.current;
      if (!node) return;
      let before = 0;
      for (
        let index = 0;
        index < segmentIndex && index < target.segments.length;
        index += 1
      ) {
        before += target.segments[index].seconds;
      }
      const ratio =
        target.totalSeconds > 0
          ? (before + elapsed) / target.totalSeconds
          : 0;
      node.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
    },
    [],
  );

  const tick = useCallback(
    (timestamp: number) => {
      const target = routeRef.current;
      const state = stateRef.current;
      if (!target || !state.playing) return;
      if (!lastFrameRef.current) lastFrameRef.current = timestamp;
      const delta =
        Math.min(800, Math.max(0, timestamp - lastFrameRef.current)) / 1000;
      lastFrameRef.current = timestamp;
      state.elapsed += delta;

      let guard = 0;
      while (
        guard < 8 &&
        state.seg < target.segments.length &&
        state.elapsed >= target.segments[state.seg].seconds
      ) {
        guard += 1;
        state.elapsed -= target.segments[state.seg].seconds;
        state.seg += 1;
        if (state.seg >= target.segments.length) break;
        const segment = target.segments[state.seg];
        setCursor(state.seg);
        if (segment.kind === "dwell") {
          apiRef.current?.focusAt(segment.lng, segment.lat, 15.4);
          speak(stopSpeech(target, segment));
        } else {
          apiRef.current?.setFollow(followRef.current);
        }
        updateProgress(target, state.seg, 0);
      }

      if (state.seg >= target.segments.length) {
        state.playing = false;
        setPlaying(false);
        setCursor(target.segments.length);
        updateProgress(target, target.segments.length, 0);
        if (lastPoseRef.current) {
          apiRef.current?.setWalker({
            ...lastPoseRef.current,
            moving: false,
          });
        }
        speak(`Day ${target.dayIndex} 的路线走完了，回住处休息。`);
        if (!finishedRef.current) {
          finishedRef.current = true;
          onFinishRef.current?.();
        }
        return;
      }

      const segment = target.segments[state.seg];
      const pose = poseFor(segment, state.elapsed, lastBearingRef.current);
      lastBearingRef.current = pose.bearing ?? lastBearingRef.current;
      lastPoseRef.current = pose;
      apiRef.current?.setWalker(pose);
      updateProgress(target, state.seg, state.elapsed);
      schedule();
    },
    [speak, schedule, updateProgress],
  );

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    routeRef.current = route;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (speechAvailable()) window.speechSynthesis.cancel();

    const state = stateRef.current;
    state.seg = 0;
    state.elapsed = 0;
    state.playing = Boolean(route);
    lastFrameRef.current = 0;
    lastBearingRef.current = 90;
    lastPoseRef.current = null;
    finishedRef.current = false;
    setCursor(0);
    setPlaying(Boolean(route));
    setFollow(true);
    followRef.current = true;
    if (progressRef.current) progressRef.current.style.width = "0%";

    if (!route) {
      apiRef.current?.setWalker(null);
      return;
    }

    apiRef.current?.setFollow(true);
    const first = route.segments[0];
    if (first) {
      const pose = poseFor(first, 0, 90);
      lastPoseRef.current = pose;
      lastBearingRef.current = pose.bearing ?? 90;
      apiRef.current?.setWalker(pose);
    }
    speak(`Day ${route.dayIndex}，${route.theme}。跟着阿漫出发。`);
    schedule();

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      stateRef.current.playing = false;
      if (speechAvailable()) window.speechSynthesis.cancel();
    };
  }, [route, speak, schedule]);

  useEffect(
    () => () => {
      apiRef.current?.setWalker(null);
      if (speechAvailable()) window.speechSynthesis.cancel();
    },
    [],
  );

  const pause = useCallback(() => {
    const state = stateRef.current;
    state.playing = false;
    setPlaying(false);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (lastPoseRef.current) {
      apiRef.current?.setWalker({ ...lastPoseRef.current, moving: false });
    }
    if (speechAvailable()) window.speechSynthesis.cancel();
  }, []);

  const play = useCallback(() => {
    const target = routeRef.current;
    if (!target) return;
    const state = stateRef.current;
    if (state.seg >= target.segments.length) {
      restart();
      return;
    }
    state.playing = true;
    setPlaying(true);
    lastFrameRef.current = 0;
    apiRef.current?.setFollow(followRef.current);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    schedule();
    const segment = target.segments[state.seg];
    if (segment?.kind === "dwell") {
      speak(stopSpeech(target, segment));
    } else if (segment) {
      speak(`继续走，前往${segment.toName}。`);
    }
  }, [speak, schedule]);

  function restart() {
    const target = routeRef.current;
    if (!target) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    const state = stateRef.current;
    state.seg = 0;
    state.elapsed = 0;
    state.playing = true;
    lastFrameRef.current = 0;
    lastBearingRef.current = 90;
    lastPoseRef.current = null;
    finishedRef.current = false;
    setCursor(0);
    setPlaying(true);
    apiRef.current?.setFollow(followRef.current);
    const first = target.segments[0];
    if (first) {
      const pose = poseFor(first, 0, 90);
      lastPoseRef.current = pose;
      apiRef.current?.setWalker(pose);
    }
    updateProgress(target, 0, 0);
    schedule();
    speak("重新走一遍。");
  }

  function jumpToStop(direction: 1 | -1) {
    const target = routeRef.current;
    if (!target) return;
    const state = stateRef.current;
    const segment = target.segments[state.seg];
    if (!segment) return;
    const stopIndex =
      segment.kind === "dwell"
        ? segment.stopIndex + direction
        : direction > 0
          ? segment.stopIndex
          : segment.stopIndex - 1;
    if (stopIndex < 0 || stopIndex >= target.stops.length) return;
    const index = target.segments.findIndex(
      (item) => item.kind === "dwell" && item.stopIndex === stopIndex,
    );
    if (index < 0) return;

    state.seg = index;
    state.elapsed = 0;
    lastFrameRef.current = 0;
    setCursor(index);
    const dwell = target.segments[index] as WalkDwell;
    const pose = poseFor(dwell, 0, lastBearingRef.current);
    lastPoseRef.current = pose;
    apiRef.current?.setWalker(pose);
    apiRef.current?.focusAt(dwell.lng, dwell.lat, 15.4);
    updateProgress(target, index, 0);
    speak(stopSpeech(target, dwell));
    if (state.playing) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      schedule();
    }
  }

  function toggleFollow() {
    const next = !followRef.current;
    followRef.current = next;
    setFollow(next);
    apiRef.current?.setFollow(next);
  }

  function toggleVoice() {
    const next = !voiceRef.current;
    voiceRef.current = next;
    setVoice(next);
    if (!next && speechAvailable()) window.speechSynthesis.cancel();
  }

  const current =
    route && cursor < route.segments.length
      ? route.segments[cursor]
      : null;
  const done = Boolean(route) && cursor >= (route?.segments.length ?? 0);
  const totalStops = route?.stops.length ?? 0;
  const prevDisabled =
    !current ||
    (current.kind === "dwell"
      ? current.stopIndex === 0
      : current.stopIndex === 0);
  const nextDisabled =
    !current ||
    (current.kind === "dwell"
      ? current.stopIndex >= totalStops - 1
      : current.stopIndex >= totalStops);
  const dwellStop =
    current?.kind === "dwell" ? current.stop : null;

  return (
    <div className="absolute inset-x-3 bottom-[100px] z-40 mx-auto max-w-[620px] lg:inset-x-auto lg:bottom-4 lg:left-[448px] lg:right-4 lg:mx-0 lg:max-w-none">
      <div className="overflow-hidden rounded-[22px] border border-line/70 bg-card/95 shadow-lift backdrop-blur-md">
        <div className="h-[3px] w-full bg-line/60">
          <div
            ref={progressRef}
            className="h-full rounded-r-full bg-accent transition-[width] duration-150 ease-linear"
            style={{ width: "0%" }}
          />
        </div>

        <div className="flex items-center gap-1 px-3 pt-2">
          <span className="mr-0.5 inline-flex shrink-0 items-center gap-1 rounded-full bg-jade-soft px-2 py-0.5 text-micro text-jade">
            <Icon name="footprints" size={9} />
            导览
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {plan.days.map((day) => (
              <button
                key={day.index}
                type="button"
                disabled={!day.stops.length}
                onClick={() => onDayChange(day.index)}
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] transition",
                  day.index === dayIndex
                    ? "bg-ink text-paper"
                    : "border border-line text-ink-soft hover:border-ink/25 hover:text-ink",
                  !day.stops.length && "opacity-40",
                )}
              >
                Day {day.index}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={toggleFollow}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-1 text-micro transition",
              follow
                ? "border-jade/40 bg-jade-soft text-jade"
                : "border-line text-ink-faint hover:text-ink",
            )}
            title="镜头是否跟着阿漫"
          >
            <Icon name="compass" size={10} />
            跟随
          </button>
          <button
            type="button"
            onClick={toggleVoice}
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border transition",
              voice
                ? "border-jade/40 bg-jade-soft text-jade"
                : "border-line text-ink-faint hover:text-ink",
            )}
            title={voice ? "关闭语音讲解" : "开启语音讲解"}
            aria-label={voice ? "关闭语音讲解" : "开启语音讲解"}
          >
            <Icon name={voice ? "sound" : "mute"} size={11} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line text-ink-faint transition hover:text-ink"
            aria-label="关闭导览"
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <div className="min-h-[92px] px-4 pb-2 pt-1.5">
          {!route ? (
            <>
              <p className="text-micro tracking-[0.16em] text-ink-faint">
                DAY {dayIndex} · 留白
              </p>
              <h3 className="mt-0.5 font-serif text-[17px] leading-snug text-ink">
                这一天没有要走的点
              </h3>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                睡到自然醒，在酒店附近随意走走也很好。换一天，或者让漫城再排一版。
              </p>
            </>
          ) : done && route ? (
            <>
              <p className="text-micro tracking-[0.16em] text-ink-faint">
                DAY {route.dayIndex} · 完成
              </p>
              <h3 className="mt-0.5 font-serif text-[17px] leading-snug text-ink">
                今天的路线走完了
              </h3>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                回到「{hotelName}」休息。今天走了 {totalStops}{" "}
                个停留点，吃饭的时段也留好了。
              </p>
            </>
          ) : current?.kind === "travel" ? (
            <>
              <p className="text-micro tracking-[0.16em] text-ink-faint">
                DAY {route?.dayIndex} · 在路上
              </p>
              <h3 className="mt-0.5 font-serif text-[17px] leading-snug text-ink">
                前往 {current.toName}
              </h3>
              <p className="mt-0.5 text-[10.5px] text-ink-faint">
                {WALK_MODE_LABELS[current.mode]} {current.durationMin} 分钟 ·{" "}
                {countdown(current.km)}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">
                {current.note ?? "顺着路线走，到了我讲这一站怎么玩。"}
              </p>
            </>
          ) : current && dwellStop ? (
            <>
              <p className="text-micro tracking-[0.16em] text-ink-faint">
                DAY {route?.dayIndex} · 第 {dwellStop.index + 1} / {totalStops} 站
              </p>
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="font-serif text-[17px] leading-snug text-ink">
                  {stopTitle(dwellStop)}
                </h3>
                <p className="text-[10.5px] text-ink-faint">
                  {clockRange(dwellStop.startMin, dwellStop.endMin)} ·{" "}
                  {dwellStop.flexible
                    ? "现场选"
                    : `停留 ${dwellStop.dwellMin} 分 · ${CATEGORY_LABELS[dwellStop.category]}`}
                </p>
              </div>
              <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-ink-soft">
                {dwellStop.flexible
                  ? flexibleNote(dwellStop)
                  : (dwellStop.note ?? "慢慢逛，不用赶。")}
              </p>
              {!dwellStop.flexible && dwellStop.tips[0] ? (
                <p className="mt-1 line-clamp-1 text-[11px] leading-relaxed text-ink-faint">
                  <span className="font-medium text-jade">
                    {dwellStop.tips[0].title}
                  </span>
                  {" · "}
                  {dwellStop.tips[0].body}
                </p>
              ) : null}
              {!dwellStop.flexible &&
              (dwellStop.ticket ||
                dwellStop.openHours ||
                dwellStop.attrs.length) ? (
                <p className="mt-1 truncate text-[10px] text-ink-faint">
                  {[
                    dwellStop.ticket ? `门票 ¥${dwellStop.ticket}` : null,
                    dwellStop.openHours,
                    dwellStop.attrs.slice(0, 3).join(" · ") || null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5 border-t border-line/60 px-3 py-2">
          <button
            type="button"
            onClick={() => jumpToStop(-1)}
            disabled={prevDisabled}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-soft transition hover:border-ink/25 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="上一站"
          >
            <Icon name="prev" size={13} />
          </button>
          {done ? (
            <button
              type="button"
              onClick={restart}
              className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3 text-[11px] text-paper transition hover:bg-ink/90"
            >
              <Icon name="refresh" size={11} />
              再看一遍
            </button>
          ) : (
            <button
              type="button"
              onClick={playing ? pause : play}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-paper shadow-[0_8px_18px_-10px_rgba(35,42,36,0.8)] transition hover:bg-ink/90"
              aria-label={playing ? "暂停" : "继续"}
            >
              <Icon
                name={playing ? "pause" : "play"}
                size={14}
                strokeWidth={2}
              />
            </button>
          )}
          <button
            type="button"
            onClick={() => jumpToStop(1)}
            disabled={nextDisabled}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-ink-soft transition hover:border-ink/25 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35"
            aria-label="下一站"
          >
            <Icon name="next" size={13} />
          </button>
          <span className="ml-1 text-[10px] text-ink-faint">
            {done ? "导览结束" : playing ? "讲解中" : "已暂停"}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            {dwellStop && !dwellStop.flexible ? (
              <button
                type="button"
                onClick={() => onFocusStop(dwellStop.placeId)}
                className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[10.5px] text-ink-soft transition hover:border-ink/25 hover:text-ink"
              >
                <Icon name="book-open" size={10} />
                在手册里看
              </button>
            ) : null}
            {done ? (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[10.5px] text-ink-soft transition hover:border-ink/25 hover:text-ink"
              >
                结束
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}