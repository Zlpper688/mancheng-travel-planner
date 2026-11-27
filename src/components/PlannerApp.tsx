"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CatalogResult } from "@/lib/catalog";
import { QUICK_CITIES } from "@/lib/constants";
import type {
  BudgetTier,
  CityOption,
  ExperienceId,
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
import { journalFromPlan, saveJournal } from "@/lib/journal";
import {
  buildShareUrl,
  copyText,
  decodeRecipe,
  encodeRecipe,
  formatPlanText,
  type TripRecipe,
} from "@/lib/share";
import PlaceCatalog from "./PlaceCatalog";
import PlanPanel from "./PlanPanel";
import SetupPanel from "./SetupPanel";
import { cn } from "./ui";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full animate-pulse rounded-[26px] border border-line/70 bg-paper-deep" />
  ),
});

type PlanOverrides = Partial<{
  city: CityOption;
  hotel: Place | null;
  days: number;
  date: string;
  pace: PaceId;
  styles: StyleId[];
  transport: TransportPref;
  budgetTier: BudgetTier;
  adults: number;
  children: number;
  seniors: number;
  seed: number;
  fixedPlaces: FixedPlace[];
  farDays: number | null;
  selectedPlaces: Place[];
  experiences: ExperienceId[];
  lockedPlaces: FixedPlace[];
  excludeIds: string[];
  slimDays: Record<number, number>;
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

/** 首次 3 步向导只出现一次：排出行程或点「跳过」后就不再打扰。 */
const GUIDE_KEY = "mc-guide-v1";

function guideDone(): boolean {
  // SSR 与水合阶段一律当作「已完成」，避免首屏闪一下向导。
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(GUIDE_KEY) === "done";
  } catch {
    return true;
  }
}

function markGuideDone() {
  try {
    window.localStorage.setItem(GUIDE_KEY, "done");
  } catch {
    // 隐私模式写不进去就每次重新引导，不影响主流程。
  }
}

/** 与各 useState 的初始值保持一致，用作分享链接的兜底值。 */
function defaultRecipe(date: string): TripRecipe {
  return {
    city: INITIAL_CITY,
    hotel: {
      id: `center-${INITIAL_CITY.name}`,
      name: `${INITIAL_CITY.name}市中心`,
      category: "hotel",
      lat: INITIAL_CITY.lat,
      lng: INITIAL_CITY.lng,
      city: INITIAL_CITY.name,
      source: "demo",
    },
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
  const [hotel, setHotel] = useState<Place | null>(null);
  const [days, setDays] = useState(3);
  const [date, setDate] = useState(initialDate);
  const [pace, setPace] = useState<PaceId>("balanced");
  const [styles, setStyles] = useState<StyleId[]>(["citywalk", "coastal"]);
  const [experiences, setExperiences] = useState<ExperienceId[]>([]);
  const [transport, setTransport] = useState<TransportPref>("auto");
  const [budgetTier, setBudgetTier] = useState<BudgetTier>("comfort");
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [seniors, setSeniors] = useState(0);
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

  const [view, setView] = useState<"plan" | "catalog">("plan");
  const [catalog, setCatalog] = useState<CatalogResult | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogScanning, setCatalogScanning] = useState(false);
  const [catalogScanNote, setCatalogScanNote] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<{
    message: string;
    hint?: string;
  } | null>(null);
  const [catalogKey, setCatalogKey] = useState(0);
  const [selectedPlaces, setSelectedPlaces] = useState<Place[]>([]);

  const [plan, setPlan] = useState<PlanResult | null>(null);
  /** 首次 3 步向导：1 选目的地 → 2 调玩法 → 3 生成。null 表示不再引导。 */
  const [guideStep, setGuideStep] = useState<1 | 2 | 3 | null>(null);
  const [loading, setLoading] = useState(false);
  const [reverseLoading, setReverseLoading] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const [picking, setPicking] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [activeDay, setActiveDay] = useState<number | "all">("all");
  const [focus, setFocus] = useState<{ placeId: string; nonce: number } | null>(
    null,
  );
  const [toast, setToast] = useState<string | null>(null);

  const seqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const autoRef = useRef(false);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const catalogCityRef = useRef("");
  const catalogKeyRef = useRef(-1);
  const catalogTotalRef = useRef(0);

  const mainBase = plan?.lodging?.bases.find((base) => base.role === "main");

  const mapHotel = useMemo<Place>(() => {
    if (hotel) return hotel;
    if (mainBase) {
      return {
        id: mainBase.id,
        name: mainBase.name,
        category: "hotel",
        lat: mainBase.lat,
        lng: mainBase.lng,
        city: city.name,
        note: mainBase.reason,
        source: "demo",
      };
    }
    return {
      id: `center-${city.name}`,
      name: `${city.name}市中心`,
      category: "hotel",
      lat: city.lat,
      lng: city.lng,
      city: city.name,
      note: "还没定住处：地图先按城市中心定位，生成后会给落脚片区建议。",
      source: "demo",
    };
  }, [hotel, mainBase, city.name, city.lat, city.lng]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      catalogAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (view !== "catalog") return;
    if (
      catalogCityRef.current === city.name &&
      catalogKeyRef.current === catalogKey
    ) {
      return;
    }
    catalogKeyRef.current = catalogKey;
    const controller = new AbortController();
    catalogAbortRef.current?.abort();
    catalogAbortRef.current = controller;
    setCatalogLoading(true);
    setCatalogScanning(false);
    setCatalogScanNote(null);
    setCatalogError(null);

    const fetchStage = async (stage: "base" | "deep") => {
      const params = new URLSearchParams({
        city: city.name,
        lat: city.lat.toFixed(4),
        lng: city.lng.toFixed(4),
        stage,
      });
      const response = await fetch(`/api/catalog?${params.toString()}`, {
        signal: controller.signal,
      });
      const data = await response.json();
      if (!response.ok || !Array.isArray(data?.entries)) {
        const failure = new Error(
          data?.error ?? "景点图鉴没有加载出来。",
        ) as Error & { hint?: string };
        failure.hint = data?.hint;
        throw failure;
      }
      return data as CatalogResult;
    };

    void (async () => {
      try {
        const base = await fetchStage("base");
        if (controller.signal.aborted) return;
        setCatalog(base);
        catalogTotalRef.current = base.total;
        catalogCityRef.current = city.name;
        setCatalogLoading(false);
        setCatalogScanning(true);

        try {
          const deep = await fetchStage("deep");
          if (controller.signal.aborted) return;
          if (deep.total < catalogTotalRef.current) {
            setCatalogScanNote(
              "全城深挖结果少于快速扫描，已保留快速结果；稍后再刷新可以继续补全。",
            );
          } else {
            setCatalog(deep);
            catalogTotalRef.current = deep.total;
            catalogCityRef.current = city.name;
          }
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          setCatalogScanNote(
            "全城深挖没有完成，已保留快速扫描结果；稍后刷新可以继续。",
          );
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const failure = error as Error & { hint?: string };
        setCatalogError({
          message: failure.message || "网络好像断了，景点图鉴没能加载。",
          hint: failure.hint,
        });
      } finally {
        if (catalogAbortRef.current === controller) {
          setCatalogLoading(false);
          setCatalogScanning(false);
        }
      }
    })();

    return () => controller.abort();
  }, [view, city.name, city.lat, city.lng, catalogKey]);

  useEffect(() => {
    if (!prefsOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPrefsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [prefsOpen]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const onChange = () => {
      if (desktop.matches) setPrefsOpen(false);
    };
    desktop.addEventListener("change", onChange);
    return () => desktop.removeEventListener("change", onChange);
  }, []);

  /** 当前这一版行程的配方，用于分享与地址栏同步。 */
  function currentRecipe(overrides: PlanOverrides = {}): TripRecipe {
    return {
      city: overrides.city ?? city,
      hotel: overrides.hotel ?? hotel ?? mapHotel,
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

  const guideActive = guideStep !== null && !plan;

  function finishGuide() {
    setGuideStep(null);
    markGuideDone();
  }

  /** 引导进行中，改偏好只落到本地状态——选个城市就立刻排线的话，
   *  结果页会把向导顶掉，用户反而没机会把三件事选完。 */
  function commitChange(overrides: PlanOverrides = {}) {
    if (guideActive) return;
    void requestPlan(overrides);
  }

  async function requestPlan(overrides: PlanOverrides = {}) {
    const nextCity = overrides.city ?? city;
    const nextHotel =
      overrides.hotel !== undefined ? overrides.hotel : hotel;
    const nextDays = overrides.days ?? days;
    const nextDate = overrides.date ?? date;
    const nextPace = overrides.pace ?? pace;
    const nextStyles = overrides.styles ?? styles;
    const nextExperiences = overrides.experiences ?? experiences;
    const nextTransport = overrides.transport ?? transport;
    const nextBudget = overrides.budgetTier ?? budgetTier;
    const nextAdults = overrides.adults ?? adults;
    const nextChildren = overrides.children ?? children;
    const nextSeniors = overrides.seniors ?? seniors;
    const nextSeed = overrides.seed ?? seed;
    const nextFixed = overrides.fixedPlaces ?? fixedPlaces;
    const nextSelected = overrides.selectedPlaces ?? selectedPlaces;
    const nextLocked = overrides.lockedPlaces ?? lockedPlaces;
    const nextExclude = overrides.excludeIds ?? excludeIds;
    const nextSlim = overrides.slimDays ?? slimDays;
    const nextFarDays =
      overrides.farDays !== undefined ? overrides.farDays : farDays;

    const body: TripInput = {
      city: nextCity.name,
      center: [nextCity.lng, nextCity.lat],
      hotel: nextHotel ?? undefined,
      hotelUndecided: nextHotel ? undefined : true,
      days: nextDays,
      date: nextDate,
      pace: nextPace,
      styles: nextStyles,
      experiences: nextExperiences.length ? nextExperiences : undefined,
      transport: nextTransport,
      budgetTier: nextBudget,
      adults: nextAdults,
      children: nextChildren,
      seniors: nextSeniors,
      seed: nextSeed,
      hotelPrice: nextHotel?.cost,
      fixedPlaces: nextFixed.length ? nextFixed : undefined,
      selectedPlaces: nextSelected.length ? nextSelected : undefined,
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
      finishGuide();
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
    if (!guideDone()) {
      // 分享链接里已经有别人的一版行程，直接照着排；否则先让用户自己选三件事。
      if (shared) markGuideDone();
      else {
        setGuideStep(1);
        return;
      }
    }
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
    // 换城市后旧住处已经失效，直接交给行程引擎按景点分布重新推荐落脚片区。
    setCity(next);
    setHotel(null);
    setPicking(false);
    setFixedPlaces([]);
    setSelectedPlaces([]);
    setLockedPlaces([]);
    setExcludeIds([]);
    setSlimDays({});
    setGuideResetKey((value) => value + 1);
    catalogAbortRef.current?.abort();
    catalogCityRef.current = "";
    catalogKeyRef.current = -1;
    catalogTotalRef.current = 0;
    setCatalog(null);
    setCatalogError(null);
    setCatalogLoading(false);
    setCatalogScanning(false);
    setCatalogScanNote(null);
    commitChange({
      city: next,
      hotel: null,
      fixedPlaces: [],
      selectedPlaces: [],
      lockedPlaces: [],
      excludeIds: [],
      slimDays: {},
    });
  }

  function handleHotelChange(next: Place) {
    setHotel(next);
    setPicking(false);
    // 换住处等于换了一天的起点，旧的锁定与排除都失去参照。
    setLockedPlaces([]);
    setExcludeIds([]);
    setSlimDays({});
    commitChange({
      hotel: next,
      lockedPlaces: [],
      excludeIds: [],
      slimDays: {},
    });
  }

  function handleHotelUndecided() {
    setHotel(null);
    setPicking(false);
    setLockedPlaces([]);
    setExcludeIds([]);
    setSlimDays({});
    commitChange({
      hotel: null,
      lockedPlaces: [],
      excludeIds: [],
      slimDays: {},
    });
  }

  function handleDaysChange(next: number) {
    setDays(next);
    commitChange({ days: next });
  }

  function handleDateChange(next: string) {
    setDate(next);
    commitChange({ date: next });
  }

  function handlePaceChange(next: PaceId) {
    setPace(next);
    commitChange({ pace: next });
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
    commitChange({ styles: next });
  }

  function handleExperienceToggle(id: ExperienceId) {
    let next: ExperienceId[];
    if (experiences.includes(id)) {
      next = experiences.filter((item) => item !== id);
    } else if (experiences.length >= 3) {
      next = [...experiences.slice(1), id];
    } else {
      next = [...experiences, id];
    }
    setExperiences(next);
    commitChange({ experiences: next });
  }

  function handleTransportChange(next: TransportPref) {
    setTransport(next);
    commitChange({ transport: next });
  }

  function handleFarDaysChange(next: number | null) {
    setFarDays(next);
    commitChange({ farDays: next });
  }

  function handleBudgetChange(next: BudgetTier) {
    setBudgetTier(next);
    commitChange({ budgetTier: next });
  }

  function handleAdultsChange(next: number) {
    setAdults(next);
    commitChange({ adults: next });
  }

  function handleChildrenChange(next: number) {
    setChildren(next);
    commitChange({ children: next });
  }

  function handleSeniorsChange(next: number) {
    setSeniors(next);
    commitChange({ seniors: next });
  }

  function handleTogglePick() {
    const next = !picking;
    setPicking(next);
    if (next) {
      setPrefsOpen(false);
      window.setTimeout(() => {
        document
          .getElementById("trip-map")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 260);
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
      commitChange({
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
      commitChange({
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
    const nextDays = Math.min(15, Math.max(days, guideDays));
    setFixedPlaces(fixed);
    setDays(nextDays);
    setToast("已按攻略锁定停靠点与顺序，正在重新安排路线。");
    commitChange({ fixedPlaces: fixed, days: nextDays });
  }

  function handleGuideClear() {
    setFixedPlaces([]);
    setToast("已取消攻略复刻，恢复自动安排。");
    commitChange({ fixedPlaces: [] });
  }

  function handleViewChange(next: "plan" | "catalog") {
    setView(next);
  }

  function handleToggleCatalog(place: Place) {
    if (
      !selectedPlaces.some((item) => item.id === place.id) &&
      selectedPlaces.length >= 40
    ) {
      setToast("最多同时选择 40 个景点，先取消几个再选。");
      return;
    }
    setSelectedPlaces((current) => {
      if (current.some((item) => item.id === place.id)) {
        return current.filter((item) => item.id !== place.id);
      }
      if (current.length >= 40) return current;
      return [...current, place];
    });
  }

  function handleClearSelected() {
    if (!selectedPlaces.length) return;
    setSelectedPlaces([]);
    setToast("已清空自选景点，下次安排会恢复自动选点。");
  }

  function handlePlanSelected() {
    if (!selectedPlaces.length) return;
    const count = selectedPlaces.length;
    setView("plan");
    setToast(`已锁定 ${count} 个自选景点，正在按位置分组安排。`);
    window.setTimeout(() => {
      document
        .getElementById("trip-map")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    commitChange({ selectedPlaces });
  }

  function handleCatalogRefresh() {
    setCatalog(null);
    catalogCityRef.current = "";
    catalogTotalRef.current = 0;
    setCatalogScanNote(null);
    setCatalogKey((value) => value + 1);
  }

  function handleShuffle() {
    const nextSeed = (seed + 1 + Math.floor(Math.random() * 997)) % 2147483646;
    setSeed(nextSeed);
    commitChange({ seed: nextSeed });
  }

  function focusStop(placeId: string) {
    setFocus((previous) => ({
      placeId,
      nonce: (previous?.nonce ?? 0) + 1,
    }));
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

  /**
   * 记下这趟（宪法 C 闭环）：把当前行程自动归档成旅行记录。
   * 不需要用户填表——配方（recipe）足够别人重排同款，daySnapshots 记录去了什么。
   */
  function handleSaveJournal() {
    if (!plan) return;
    const recipe = encodeRecipe(currentRecipe());
    try {
      saveJournal(journalFromPlan(plan, recipe));
      setToast("已记下这趟。在「旅行记录」里可以分享，或让别人一键排同款。");
    } catch {
      setToast("本地存储写不进去（可能是隐私模式），这趟没能保存。");
    }
  }

  async function handleCopyGuide() {
    if (!plan) return;
    const text = formatPlanText(
      plan,
      hotel?.name ?? mapHotel.name,
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

  function handleFocusStop(_dayIndex: number, placeId: string) {
    focusStop(placeId);
    if (window.matchMedia("(max-width: 1023px)").matches) {
      document
        .getElementById("trip-map")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function handleMapStopClick(_dayIndex: number, placeId: string) {
    focusStop(placeId);
  }

  function handlePrefsGenerate() {
    setPrefsOpen(false);
    void requestPlan();
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
  const selectedIds = selectedPlaces.map((place) => place.id);

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
            <p className="mt-1.5 truncate text-[10.5px] tracking-[0.14em] text-ink-faint">
              从一间酒店出发的城市漫游计划
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/chat"
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card/80 px-2.5 py-1 text-[11px] text-ink-soft transition hover:border-accent/40 hover:text-accent"
              title="对话定制：像聊天一样说需求，直接排出路线"
            >
              <Icon name="sparkles" size={11} />
              <span>对话定制</span>
            </Link>
            <Link
              href="/journal"
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card/80 px-2.5 py-1 text-[11px] text-ink-soft transition hover:border-jade/40 hover:text-jade"
              title="旅行记录：去过哪、花了多少、分享给别人一键排同款"
            >
              <Icon name="footprints" size={11} />
              <span className="hidden sm:inline">旅行记录</span>
            </Link>
            <span className="hidden items-center gap-1.5 rounded-full border border-line bg-card/80 px-2.5 py-1 text-[11px] text-ink-soft sm:inline-flex">
              <span className={cn("h-1.5 w-1.5 rounded-full", sourceDot)} />
              {sourceLabel}
            </span>
            <span className="hidden text-[10.5px] tracking-wide text-ink-faint md:inline">
              {view === "catalog"
                ? "点标记看介绍 · 加入想去的景点"
                : "点 = 停留 · 线 = 路程"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1560px] px-3 pb-24 pt-3 sm:px-4 lg:px-6 lg:pb-8">
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[392px_minmax(0,1fr)] lg:items-start">
          {/* 手机上首次向导放在最前面：地图这时还是空的，先让人把三件事选完。 */}
          <aside
            className={cn(
              "order-3 lg:order-none lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:self-stretch",
              guideActive
                ? "order-1 max-lg:block"
                : prefsOpen
                  ? "max-lg:fixed max-lg:inset-0 max-lg:z-50 max-lg:overflow-y-auto max-lg:overscroll-contain max-lg:bg-paper max-lg:px-3 max-lg:pb-28"
                  : "max-lg:hidden",
            )}
          >
            <div className="scroll-thin lg:sticky lg:top-[68px] lg:max-h-[calc(100vh-84px)] lg:overflow-y-auto lg:pr-1">
              {prefsOpen ? (
                <div className="sticky top-0 z-20 -mx-3 mb-2 flex items-center justify-between gap-3 border-b border-line/70 bg-paper/95 px-4 py-2.5 backdrop-blur lg:hidden">
                  <div className="min-w-0">
                    <p className="font-serif text-[16px] tracking-wide text-ink">
                      调整行程偏好
                    </p>
                    <p className="mt-0.5 text-[10.5px] text-ink-faint">
                      改动会立即重排路线
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPrefsOpen(false)}
                    className="shrink-0 rounded-full bg-ink px-4 py-2 text-[13px] text-paper transition hover:bg-ink/85"
                  >
                    完成
                  </button>
                </div>
              ) : null}
              <SetupPanel
                city={city}
                hotel={hotel}
                days={days}
                date={date}
                pace={pace}
                styles={styles}
                experiences={experiences}
                transport={transport}
                budgetTier={budgetTier}
                adults={adults}
                children={children}
                seniors={seniors}
                farDays={farDays}
                busy={busy}
                picking={picking}
                liveData={liveData}
                hasPlan={Boolean(plan)}
                guideStep={guideActive ? guideStep : null}
                onGuideStep={setGuideStep}
                onGuideDone={finishGuide}
                fixedCount={fixedPlaces.length}
                guideResetKey={guideResetKey}
                onCityChange={handleCityChange}
                onHotelChange={handleHotelChange}
                onHotelUndecided={handleHotelUndecided}
                onDaysChange={handleDaysChange}
                onDateChange={handleDateChange}
                onPaceChange={handlePaceChange}
                onStyleToggle={handleStyleToggle}
                onExperienceToggle={handleExperienceToggle}
                onTransportChange={handleTransportChange}
                onBudgetChange={handleBudgetChange}
                onAdultsChange={handleAdultsChange}
                onChildrenChange={handleChildrenChange}
                onSeniorsChange={handleSeniorsChange}
                onFarDaysChange={handleFarDaysChange}
                onTogglePick={handleTogglePick}
                onGenerate={handlePrefsGenerate}
                onGuideApply={handleGuideApply}
                onGuideClear={handleGuideClear}
              />
            </div>
          </aside>

          <div
            id="trip-map"
            className={cn(
              "h-[50vh] min-h-[340px] max-h-[560px] scroll-mt-[62px] lg:order-none lg:col-start-2 lg:row-start-1 lg:h-[460px] lg:max-h-none",
              guideActive ? "order-2" : "order-1",
            )}
          >
            <MapView
              hotel={mapHotel}
              plan={plan}
              activeDay={activeDay}
              focus={focus}
              mode={view === "catalog" ? "browse" : "plan"}
              catalog={catalog?.entries ?? null}
              catalogLoading={catalogLoading}
              selectedIds={selectedIds}
              picking={picking}
              loading={busy}
              onPick={handlePick}
              onExitPick={() => setPicking(false)}
              onStopClick={handleMapStopClick}
              onToggleCatalog={handleToggleCatalog}
            />
          </div>

          <div
            className={cn(
              "lg:order-none lg:col-start-2 lg:row-start-2",
              guideActive ? "order-3" : "order-2",
            )}
          >
            <div className="mb-2 flex w-fit items-center gap-1 rounded-full border border-line/70 bg-card/70 p-1">
              <button
                type="button"
                onClick={() => handleViewChange("plan")}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] transition",
                  view === "plan"
                    ? "bg-ink text-paper shadow-[0_8px_18px_-14px_rgba(35,42,36,0.8)]"
                    : "text-ink-soft hover:text-ink",
                )}
              >
                <Icon name="route" size={12} />
                行程方案
              </button>
              <button
                type="button"
                onClick={() => handleViewChange("catalog")}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12.5px] transition",
                  view === "catalog"
                    ? "bg-ink text-paper shadow-[0_8px_18px_-14px_rgba(35,42,36,0.8)]"
                    : "text-ink-soft hover:text-ink",
                )}
              >
                <Icon name="compass" size={12} />
                景点图鉴
                {selectedPlaces.length ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-micro leading-none",
                      view === "catalog"
                        ? "bg-paper/20 text-paper"
                        : "bg-accent text-paper",
                    )}
                  >
                    已选 {selectedPlaces.length}
                  </span>
                ) : catalog ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-micro leading-none",
                      view === "catalog"
                        ? "bg-paper/20 text-paper"
                        : "bg-paper-deep text-ink-faint",
                    )}
                  >
                    {catalog.total}
                  </span>
                ) : null}
              </button>
            </div>

            {view === "plan" ? (
              <PlanPanel
                plan={plan}
                loading={loading}
                error={error}
                activeDay={activeDay}
                focus={focus}
                hotelName={hotel?.name ?? "落脚片区"}
                onActiveDay={handleActiveDay}
                onFocusStop={handleFocusStop}
                onShuffle={handleShuffle}
                onSaveJournal={handleSaveJournal}
                onGenerate={() => void requestPlan()}
                lockedIds={lockedPlaces.map((item) => item.place.id)}
                onToggleLock={handleToggleLock}
                onReplaceStop={handleReplaceStop}
                onRemoveStop={handleRemoveStop}
                onShare={handleShare}
                onCopyGuide={handleCopyGuide}
              />
            ) : (
              <PlaceCatalog
                city={city.name}
                catalog={catalog}
                loading={catalogLoading}
                error={catalogError}
                selectedIds={selectedIds}
                focus={focus}
                onToggle={handleToggleCatalog}
                onClear={handleClearSelected}
                onRefresh={handleCatalogRefresh}
                onPlan={handlePlanSelected}
                onFocus={(placeId) => focusStop(placeId)}
                scanning={catalogScanning}
                scanNote={catalogScanNote}
              />
            )}
          </div>
        </div>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-3 text-[10.5px] text-ink-faint">
          <p>漫城 MANCHENG · 用真实地图，把旅行排成一个圈</p>
          <p>数据来自高德 / OpenStreetMap / OSRM / Open-Meteo · 时间与价格请以现场为准</p>
        </footer>
      </main>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line/70 bg-card/95 pb-[max(0.6rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-md lg:hidden">
        <div className="mx-auto flex max-w-md items-center gap-2 px-3">
          <button
            type="button"
            onClick={() => setPrefsOpen(true)}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-line bg-paper/70 px-3 py-2.5 text-[13px] text-ink-soft transition active:scale-[0.99]"
          >
            <Icon name="compass" size={14} />
            调整偏好
          </button>
          {view === "catalog" ? (
            <button
              type="button"
              onClick={handlePlanSelected}
              disabled={busy || !selectedPlaces.length}
              className="flex flex-[1.3] items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2.5 text-[13px] font-medium text-paper transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Icon name="route" size={14} />
              {busy
                ? "安排中…"
                : selectedPlaces.length
                  ? `排已选 ${selectedPlaces.length} 个`
                  : "先选几个景点"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleShuffle}
              disabled={busy}
              className="flex flex-[1.3] items-center justify-center gap-1.5 rounded-xl bg-accent px-3 py-2.5 text-[13px] font-medium text-paper transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Icon name="shuffle" size={14} />
              {busy ? "重排中…" : "换一版"}
            </button>
          )}
        </div>
      </div>

      {toast ? (
        <div className="fixed bottom-20 left-1/2 z-[60] max-w-[calc(100vw-2rem)] -translate-x-1/2 animate-fade-up rounded-full border border-white/20 bg-ink/92 px-4 py-2 text-center text-[12px] text-paper shadow-lift backdrop-blur lg:bottom-5">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
