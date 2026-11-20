"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { QUICK_CITIES } from "@/lib/constants";
import { DEMO_HOTELS, isDemoCity } from "@/lib/demo/xiamen";
import type {
  BudgetTier,
  CityOption,
  FixedPlace,
  PaceId,
  Place,
  PlanResponse,
  PlanResult,
  StyleId,
  TransportPref,
  TripInput,
} from "@/lib/types";
import { Icon } from "./Icon";
import PlanPanel from "./PlanPanel";
import SetupPanel from "./SetupPanel";
import { cn } from "./ui";
import {
  buildShareUrl,
  copyText,
  decodeRecipe,
  encodeRecipe,
  formatPlanText,
  type TripRecipe,
} from "@/lib/share";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full animate-pulse rounded-[26px] border border-line/70 bg-paper-deep" />
  ),
});

type PlanOverrides = Partial<{
  city: CityOption;
  hotel: Place;
  days: number;
  date: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  budgetTier: BudgetTier;
  adults: number;
  children: number;
  seed: number;
  fixedPlaces: FixedPlace[];
  lockedPlaces: FixedPlace[];
  excludeIds: string[];
  slimDays: Record<number, number>;
  farDays: number | null;
}>;

function pickedHotel(lng: number, lat: number): Place {
  return {
    id: `picked-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    name: "地图选点",
    category: "hotel",
    lat,
    lng,
    address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    source: "demo",
  };
}

const INITIAL_CITY = QUICK_CITIES[0];
const INITIAL_HOTEL = DEMO_HOTELS[0];

/** 与各 useState 的初始值保持一致，用作分享链接的兜底值。 */
function defaultRecipe(date: string): TripRecipe {
  return {
    city: INITIAL_CITY,
    hotel: INITIAL_HOTEL,
    days: 3,
    date,
    pace: "balanced",
    styles: ["citywalk", "coastal"],
    transport: "auto",
    budgetTier: "comfort",
    adults: 2,
    children: 0,
    seed: 42,
    farDays: null,
  };
}

export default function PlannerApp({
  initialDate,
  liveData,
}: {
  initialDate: string;
  liveData: boolean;
}) {
  const [city, setCity] = useState<CityOption>(INITIAL_CITY);
  const [hotel, setHotel] = useState<Place>(INITIAL_HOTEL);
  const [days, setDays] = useState(3);
  const [date, setDate] = useState(initialDate);
  const [pace, setPace] = useState<PaceId>("balanced");
  const [styles, setStyles] = useState<StyleId[]>(["citywalk", "coastal"]);
  const [transport, setTransport] = useState<TransportPref>("auto");
  const [budgetTier, setBudgetTier] = useState<BudgetTier>("comfort");
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [seed, setSeed] = useState(42);
  const [farDays, setFarDays] = useState<number | null>(null);
  const [fixedPlaces, setFixedPlaces] = useState<FixedPlace[]>([]);
  /** 单点锁定：重排时这些点必须留在原定的那天。 */
  const [lockedPlaces, setLockedPlaces] = useState<FixedPlace[]>([]);
  /** 用户移除或替换掉的点位，后续重排不得再出现。 */
  const [excludeIds, setExcludeIds] = useState<string[]>([]);
  /** 某天少排几个点位，让「移除」不被自动补位抵消。 */
  const [slimDays, setSlimDays] = useState<Record<number, number>>({});
  const [guideResetKey, setGuideResetKey] = useState(0);

  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [reverseLoading, setReverseLoading] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [picking, setPicking] = useState(false);
  const [activeDay, setActiveDay] = useState<number | "all">("all");
  const [focus, setFocus] = useState<{ placeId: string; nonce: number } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);

  const seqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const autoRef = useRef(false);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  /** 当前这一版行程的配方，用于分享与地址栏同步。 */
  function currentRecipe(overrides: PlanOverrides = {}): TripRecipe {
    return {
      city: overrides.city ?? city,
      hotel: overrides.hotel ?? hotel,
      days: overrides.days ?? days,
      date: overrides.date ?? date,
      pace: overrides.pace ?? pace,
      styles: overrides.styles ?? styles,
      transport: overrides.transport ?? transport,
      budgetTier: overrides.budgetTier ?? budgetTier,
      adults: overrides.adults ?? adults,
      children: overrides.children ?? children,
      seed: overrides.seed ?? seed,
      farDays: overrides.farDays !== undefined ? overrides.farDays : farDays,
    };
  }

  /**
   * 把配方写回地址栏。用 replaceState 而不是 pushState：这只是一份
   * 「当前视图」的快照，不该在浏览器历史里堆成几十条。
   * 刷新能恢复、链接能直接发给别人，都靠这一步。
   */
  function syncUrl(recipe: TripRecipe) {
    if (typeof window === "undefined") return;
    const next = `?${encodeRecipe(recipe)}`;
    if (window.location.search === next) return;
    window.history.replaceState(null, "", next);
  }

  async function requestPlan(overrides: PlanOverrides = {}) {
    const nextCity = overrides.city ?? city;
    const nextHotel = overrides.hotel ?? hotel;
    const nextDays = overrides.days ?? days;
    const nextDate = overrides.date ?? date;
    const nextPace = overrides.pace ?? pace;
    const nextStyles = overrides.styles ?? styles;
    const nextTransport = overrides.transport ?? transport;
    const nextBudget = overrides.budgetTier ?? budgetTier;
    const nextAdults = overrides.adults ?? adults;
    const nextChildren = overrides.children ?? children;
    const nextSeed = overrides.seed ?? seed;
    const nextFixed = overrides.fixedPlaces ?? fixedPlaces;
    const nextLocked = overrides.lockedPlaces ?? lockedPlaces;
    const nextExclude = overrides.excludeIds ?? excludeIds;
    const nextSlim = overrides.slimDays ?? slimDays;
    const nextFarDays =
      overrides.farDays !== undefined ? overrides.farDays : farDays;

    const body: TripInput = {
      city: nextCity.name,
      center: [nextCity.lng, nextCity.lat],
      hotel: nextHotel,
      days: nextDays,
      date: nextDate,
      pace: nextPace,
      styles: nextStyles,
      transport: nextTransport,
      budgetTier: nextBudget,
      adults: nextAdults,
      children: nextChildren,
      seed: nextSeed,
      hotelPrice: nextHotel.cost,
      fixedPlaces: nextFixed.length ? nextFixed : undefined,
      lockedPlaces: nextLocked.length ? nextLocked : undefined,
      excludeIds: nextExclude.length ? nextExclude : undefined,
      slimDays: Object.keys(nextSlim).length ? nextSlim : undefined,
      farDays: nextFarDays ?? undefined,
    };

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data: PlanResponse = await response.json();
      if (seq !== seqRef.current) return;
      if (!response.ok || !data.plan) {
        setError({
          message: data.error ?? "生成失败，请稍后再试。",
          hint: data.hint,
        });
        return;
      }
      const nextPlan = data.plan;
      setPlan(nextPlan);
      // 只有真的排出来了才认这一版：中途失败时地址栏应停留在上一版。
      syncUrl(currentRecipe(overrides));
      setFocus(null);
      setActiveDay((previous) =>
        previous === "all" ||
        nextPlan.days.some((item) => item.index === previous)
          ? previous
          : "all",
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (seq !== seqRef.current) return;
      setError({
        message: "网络好像断了，没能拿到新行程。",
        hint: "确认本地服务还在运行后再试一次。",
      });
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    if (autoRef.current) return;
    autoRef.current = true;
    const shared =
      typeof window === "undefined"
        ? null
        : decodeRecipe(window.location.search, defaultRecipe(initialDate));
    if (!shared) {
      void requestPlan();
      return;
    }
    // 这条链接带着别人的一版行程，先把界面状态对齐，再照着排一次。
    setCity(shared.city);
    setHotel(shared.hotel);
    setDays(shared.days);
    setDate(shared.date);
    setPace(shared.pace);
    setStyles(shared.styles);
    setTransport(shared.transport);
    setBudgetTier(shared.budgetTier);
    setAdults(shared.adults);
    setChildren(shared.children);
    setSeed(shared.seed);
    setFarDays(shared.farDays);
    setToast("已按分享链接恢复这一版行程。");
    void requestPlan(shared);
    // Only the first load should auto-plan; later changes call requestPlan directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCityChange(next: CityOption) {
    const nextHotel: Place = isDemoCity(next.name)
      ? DEMO_HOTELS[0]
      : {
          id: `hotel-${next.name}`,
          name: `${next.name}市中心酒店`,
          category: "hotel",
          lat: next.lat,
          lng: next.lng,
          city: next.name,
          address: `${next.name}市中心 · 也可以在地图上点选更准确的落脚点`,
          source: "demo",
        };
    setCity(next);
    setHotel(nextHotel);
    setPicking(false);
    setFixedPlaces([]);
    setLockedPlaces([]);
    setExcludeIds([]);
    setSlimDays({});
    setGuideResetKey((value) => value + 1);
    void requestPlan({
      city: next,
      hotel: nextHotel,
      fixedPlaces: [],
      lockedPlaces: [],
      excludeIds: [],
      slimDays: {},
    });
  }

  function handleHotelChange(next: Place) {
    setHotel(next);
    setPicking(false);
    setLockedPlaces([]);
    setExcludeIds([]);
    setSlimDays({});
    void requestPlan({
      hotel: next,
      lockedPlaces: [],
      excludeIds: [],
      slimDays: {},
    });
  }

  function handleDaysChange(next: number) {
    setDays(next);
    void requestPlan({ days: next });
  }

  function handleDateChange(next: string) {
    setDate(next);
    void requestPlan({ date: next });
  }

  function handlePaceChange(next: PaceId) {
    setPace(next);
    void requestPlan({ pace: next });
  }

  function handleStyleToggle(id: StyleId) {
    let next: StyleId[];
    if (styles.includes(id)) {
      if (styles.length === 1) {
        setToast("至少保留一种旅行风格。");
        return;
      }
      next = styles.filter((style) => style !== id);
    } else if (styles.length >= 3) {
      next = [...styles.slice(1), id];
    } else {
      next = [...styles, id];
    }
    setStyles(next);
    void requestPlan({ styles: next });
  }

  function handleTransportChange(next: TransportPref) {
    setTransport(next);
    void requestPlan({ transport: next });
  }

  function handleFarDaysChange(next: number | null) {
    setFarDays(next);
    void requestPlan({ farDays: next });
  }

  function handleBudgetChange(next: BudgetTier) {
    setBudgetTier(next);
    void requestPlan({ budgetTier: next });
  }

  function handleAdultsChange(next: number) {
    setAdults(next);
    void requestPlan({ adults: next });
  }

  function handleChildrenChange(next: number) {
    setChildren(next);
    void requestPlan({ children: next });
  }

  function handleTogglePick() {
    const next = !picking;
    setPicking(next);
    if (next) {
      window.setTimeout(() => {
        document
          .getElementById("trip-map")
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
    }
  }

  async function handlePick(lng: number, lat: number) {
    setPicking(false);
    setReverseLoading(true);
    try {
      const response = await fetch(
        `/api/reverse?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`,
      );
      const data = await response.json();
      const nextHotel: Place =
        data && data.place && typeof data.place === "object"
          ? { ...(data.place as Place), category: "hotel" }
          : pickedHotel(lng, lat);
      setHotel(nextHotel);
      setLockedPlaces([]);
      setExcludeIds([]);
      setSlimDays({});
      void requestPlan({
        hotel: nextHotel,
        lockedPlaces: [],
        excludeIds: [],
        slimDays: {},
      });
    } catch {
      const nextHotel = pickedHotel(lng, lat);
      setHotel(nextHotel);
      setLockedPlaces([]);
      setExcludeIds([]);
      setSlimDays({});
      setToast("没能识别地名，已用坐标作为落脚点。");
      void requestPlan({
        hotel: nextHotel,
        lockedPlaces: [],
        excludeIds: [],
        slimDays: {},
      });
    } finally {
      setReverseLoading(false);
    }
  }

  function handleGuideApply(fixed: FixedPlace[], guideDays: number) {
    const nextDays = Math.min(7, Math.max(days, guideDays));
    setFixedPlaces(fixed);
    setDays(nextDays);
    setToast("已按攻略锁定停靠点与顺序，正在重排路线。");
    void requestPlan({ fixedPlaces: fixed, days: nextDays });
  }

  function handleGuideClear() {
    setFixedPlaces([]);
    setToast("已取消攻略复刻，恢复自动安排。");
    void requestPlan({ fixedPlaces: [] });
  }

  function handleShuffle() {
    const nextSeed = (seed + 1 + Math.floor(Math.random() * 997)) % 2147483646;
    setSeed(nextSeed);
    void requestPlan({ seed: nextSeed });
  }

  async function handleShare() {
    const url = buildShareUrl(currentRecipe());
    const ok = await copyText(url);
    setToast(
      ok
        ? "链接已复制。朋友打开就是这一版，刷新也不会丢。"
        : "复制失败，可以从地址栏手动复制。",
    );
  }

  async function handleCopyGuide() {
    if (!plan) return;
    const text = formatPlanText(
      plan,
      hotel.name,
      buildShareUrl(currentRecipe()),
    );
    const ok = await copyText(text);
    setToast(
      ok
        ? "行程已复制成文字，可以直接粘到微信或备忘录。"
        : "复制失败，请换个浏览器再试。",
    );
  }

  /** 从当前行程里取出某个点位的完整对象，供锁定与替换使用。 */
  function placeOf(dayIndex: number, placeId: string): Place | undefined {
    return plan?.days
      .find((item) => item.index === dayIndex)
      ?.stops.find((stop) => stop.place.id === placeId)?.place;
  }

  function handleToggleLock(dayIndex: number, placeId: string) {
    const already = lockedPlaces.some(
      (item) => item.day === dayIndex && item.place.id === placeId,
    );
    if (already) {
      setLockedPlaces((previous) =>
        previous.filter(
          (item) => !(item.day === dayIndex && item.place.id === placeId),
        ),
      );
      setToast("已解除锁定，下次重排可能会换掉这个点。");
      return;
    }
    const place = placeOf(dayIndex, placeId);
    if (!place) return;
    setLockedPlaces((previous) => [...previous, { place, day: dayIndex }]);
    // 解锁和上锁都不立刻重排：用户看到的是「标记」，真正的重排发生在换一版或改偏好时。
    setToast(`已锁定「${place.name}」，换一版时会留在第 ${dayIndex} 天。`);
  }

  function handleReplaceStop(dayIndex: number, placeId: string) {
    const place = placeOf(dayIndex, placeId);
    const nextExclude = excludeIds.includes(placeId)
      ? excludeIds
      : [...excludeIds, placeId];
    const nextLocked = lockedPlaces.filter(
      (item) => item.place.id !== placeId,
    );
    setExcludeIds(nextExclude);
    setLockedPlaces(nextLocked);
    setToast(place ? `正在换掉「${place.name}」…` : "正在换一个点位…");
    void requestPlan({
      excludeIds: nextExclude,
      lockedPlaces: nextLocked,
      slimDays,
    });
  }

  function handleRemoveStop(dayIndex: number, placeId: string) {
    const place = placeOf(dayIndex, placeId);
    const nextExclude = excludeIds.includes(placeId)
      ? excludeIds
      : [...excludeIds, placeId];
    const nextLocked = lockedPlaces.filter(
      (item) => item.place.id !== placeId,
    );
    const nextSlim: Record<number, number> = {
      ...slimDays,
      [dayIndex]: Math.min(4, (slimDays[dayIndex] ?? 0) + 1),
    };
    setExcludeIds(nextExclude);
    setLockedPlaces(nextLocked);
    setSlimDays(nextSlim);
    setToast(
      place
        ? `已移除「${place.name}」，第 ${dayIndex} 天会少排一个点。`
        : "已移除这个点位。",
    );
    void requestPlan({
      excludeIds: nextExclude,
      lockedPlaces: nextLocked,
      slimDays: nextSlim,
    });
  }

  function handleFocusStop(dayIndex: number, placeId: string) {
    setActiveDay(dayIndex);
    setFocus((previous) => ({
      placeId,
      nonce: (previous?.nonce ?? 0) + 1,
    }));
  }

  function handleActiveDay(next: number | "all") {
    setActiveDay(next);
    setFocus(null);
  }

  const source =
    plan?.meta.source ?? (liveData ? "amap" : null);
  const sourceLabel =
    source === "amap"
      ? "高德实时数据"
      : source === "demo"
        ? "厦门演示数据"
        : source === "open"
          ? "开放地图数据"
          : liveData
            ? "高德已连接"
            : "免 Key 模式";
  const sourceDot =
    source === "amap" || (source === null && liveData)
      ? "bg-jade"
      : "bg-amber";
  const busy = loading || reverseLoading;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line/60 bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1560px] items-center gap-3 px-3 py-2.5 sm:px-4 lg:px-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink text-paper shadow-[0_12px_24px_-14px_rgba(35,42,36,0.8)]">
            <Icon name="compass" size={18} />
          </span>
          <div className="min-w-0 leading-none">
            <div className="flex items-baseline gap-2">
              <p className="font-serif text-[19px] tracking-[0.22em] text-ink">
                漫城
              </p>
              <span className="hidden text-micro tracking-[0.28em] text-ink-faint sm:inline">
                MANCHENG
              </span>
            </div>
            <p className="mt-1.5 truncate text-meta tracking-[0.14em] text-ink-faint">
              从一间酒店出发的城市漫游计划
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full border border-line bg-card/80 px-2.5 py-1 text-meta text-ink-soft sm:inline-flex">
              <span className={cn("h-1.5 w-1.5 rounded-full", sourceDot)} />
              {sourceLabel}
            </span>
            <span className="hidden text-meta tracking-wide text-ink-faint md:inline">
              点 = 停留 · 线 = 路程
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1560px] px-3 pb-8 pt-3 sm:px-4 lg:px-6">
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[392px_minmax(0,1fr)] lg:items-start">
          <aside className="order-3 lg:order-none lg:col-start-1 lg:row-span-2 lg:row-start-1">
            <div className="scroll-thin lg:sticky lg:top-[68px] lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto lg:pr-1">
              <SetupPanel
                city={city}
                hotel={hotel}
                days={days}
                date={date}
                pace={pace}
                styles={styles}
                transport={transport}
                budgetTier={budgetTier}
                adults={adults}
                children={children}
                farDays={farDays}
                busy={busy}
                picking={picking}
                liveData={liveData}
                hasPlan={Boolean(plan)}
                fixedCount={fixedPlaces.length}
                guideResetKey={guideResetKey}
                onCityChange={handleCityChange}
                onHotelChange={handleHotelChange}
                onDaysChange={handleDaysChange}
                onDateChange={handleDateChange}
                onPaceChange={handlePaceChange}
                onStyleToggle={handleStyleToggle}
                onTransportChange={handleTransportChange}
                onBudgetChange={handleBudgetChange}
                onAdultsChange={handleAdultsChange}
                onChildrenChange={handleChildrenChange}
                onFarDaysChange={handleFarDaysChange}
                onTogglePick={handleTogglePick}
                onGenerate={() => void requestPlan()}
                onGuideApply={handleGuideApply}
                onGuideClear={handleGuideClear}
              />
            </div>
          </aside>

          <div
            id="trip-map"
            className="order-1 h-[50vh] min-h-[340px] max-h-[560px] lg:order-none lg:col-start-2 lg:row-start-1 lg:h-[460px] lg:max-h-none"
          >
            <MapView
              hotel={hotel}
              plan={plan}
              activeDay={activeDay}
              focus={focus}
              picking={picking}
              loading={busy}
              onPick={handlePick}
              onExitPick={() => setPicking(false)}
              onStopClick={handleFocusStop}
            />
          </div>

          <div className="order-2 lg:order-none lg:col-start-2 lg:row-start-2">
            <PlanPanel
              plan={plan}
              loading={loading}
              error={error}
              activeDay={activeDay}
              hotelName={hotel.name}
              onActiveDay={handleActiveDay}
              onFocusStop={handleFocusStop}
              onShuffle={handleShuffle}
              onGenerate={() => void requestPlan()}
              onShare={handleShare}
              onCopyGuide={handleCopyGuide}
              lockedIds={lockedPlaces.map((item) => item.place.id)}
              onToggleLock={handleToggleLock}
              onReplaceStop={handleReplaceStop}
              onRemoveStop={handleRemoveStop}
            />
          </div>
        </div>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-3 text-meta text-ink-faint">
          <p>漫城 MANCHENG · 用真实地图，把旅行排成一个圈</p>
          <p>数据来自高德 / OpenStreetMap / OSRM / Open-Meteo · 时间与价格请以现场为准</p>
        </footer>
      </main>

      {toast ? (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 animate-fade-up rounded-full border border-white/20 bg-ink/92 px-4 py-2 text-[11px] text-paper shadow-lift backdrop-blur">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
