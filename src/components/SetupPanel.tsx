"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BUDGET_TIERS,
  PACES,
  QUICK_CITIES,
  STYLES,
  TRANSPORT_OPTIONS,
} from "@/lib/constants";
import { DEMO_HOTELS } from "@/content/demo-xiamen";
import { isDemoCity } from "@/lib/demo";
import { EXPERIENCE_OPTIONS } from "@/lib/plan/experience-options";
import { money } from "@/lib/format";
import { todayISOLocal } from "@/lib/geo";
import { getHoliday, isWeekend } from "@/lib/holidays";
import type {
  BudgetTier,
  CityOption,
  ExperienceId,
  FixedPlace,
  PaceId,
  Place,
  StyleId,
  TransportPref,
} from "@/lib/types";
import GuideImport from "./GuideImport";
import { Icon } from "./Icon";
import { Chip, Section, Spinner, Stepper, cn } from "./ui";

export interface SetupPanelProps {
  city: CityOption;
  hotel: Place | null;
  days: number;
  date: string;
  pace: PaceId;
  styles: StyleId[];
  experiences: ExperienceId[];
  transport: TransportPref;
  budgetTier: BudgetTier;
  adults: number;
  children: number;
  seniors: number;
  farDays: number | null;
  busy: boolean;
  picking: boolean;
  liveData: boolean;
  hasPlan: boolean;
  fixedCount: number;
  guideResetKey: number;
  onCityChange: (city: CityOption) => void;
  onHotelChange: (hotel: Place) => void;
  onHotelUndecided: () => void;
  onDaysChange: (days: number) => void;
  onDateChange: (date: string) => void;
  onPaceChange: (pace: PaceId) => void;
  onStyleToggle: (style: StyleId) => void;
  onExperienceToggle: (id: ExperienceId) => void;
  onTransportChange: (transport: TransportPref) => void;
  onBudgetChange: (tier: BudgetTier) => void;
  onAdultsChange: (count: number) => void;
  onChildrenChange: (count: number) => void;
  onSeniorsChange: (count: number) => void;
  onFarDaysChange: (value: number | null) => void;
  onTogglePick: () => void;
  onGenerate: () => void;
  onGuideApply: (fixed: FixedPlace[], days: number) => void;
  onGuideClear: () => void;
}

type SearchResponse = {
  results?: Place[];
  error?: string;
};

const FIELD_CLASS =
  "w-full rounded-xl border border-line bg-card/75 px-3 py-2.5 text-[13px] text-ink placeholder:text-ink-faint/85 focus:border-ink/25 focus:outline-none";

const FAR_DAY_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "自动" },
  { value: 0, label: "就近" },
  { value: 1, label: "1 天" },
  { value: 2, label: "2 天" },
  { value: 3, label: "3 天" },
];

function SearchList({
  results,
  onChoose,
}: {
  results: Place[];
  onChoose: (place: Place) => void;
}) {
  return (
    <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 max-h-60 overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-lift scroll-thin">
      {results.map((place) => (
        <button
          key={place.id}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChoose(place)}
          className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition hover:bg-paper"
        >
          <Icon
            name="map-pin"
            size={12}
            className="mt-0.5 shrink-0 text-ink-faint"
          />
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-ink">
              {place.name}
            </span>
            <span className="mt-0.5 block truncate text-[10.5px] text-ink-faint">
              {place.address ?? place.city ?? "地图点位"}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

export default function SetupPanel({
  city,
  hotel,
  days,
  date,
  pace,
  styles,
  experiences,
  transport,
  budgetTier,
  adults,
  children,
  seniors,
  farDays,
  busy,
  picking,
  liveData,
  hasPlan,
  fixedCount,
  guideResetKey,
  onCityChange,
  onHotelChange,
  onHotelUndecided,
  onDaysChange,
  onDateChange,
  onPaceChange,
  onStyleToggle,
  onExperienceToggle,
  onTransportChange,
  onBudgetChange,
  onAdultsChange,
  onChildrenChange,
  onSeniorsChange,
  onFarDaysChange,
  onTogglePick,
  onGenerate,
  onGuideApply,
  onGuideClear,
}: SetupPanelProps) {
  const [cityQuery, setCityQuery] = useState("");
  const [cityResults, setCityResults] = useState<Place[]>([]);
  const [citySearching, setCitySearching] = useState(false);
  const [cityError, setCityError] = useState<string | null>(null);
  const [cityOpen, setCityOpen] = useState(false);
  const [hotelQuery, setHotelQuery] = useState("");
  const [hotelResults, setHotelResults] = useState<Place[]>([]);
  const [hotelSearching, setHotelSearching] = useState(false);
  const [hotelError, setHotelError] = useState<string | null>(null);
  const [hotelOpen, setHotelOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    const query = cityQuery.trim();
    if (!query) {
      setCityResults([]);
      setCitySearching(false);
      setCityError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setCitySearching(true);
      setCityError(null);
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&kind=city`,
          { signal: controller.signal },
        );
        const data: SearchResponse = await response.json();
        if (!response.ok || data.error) {
          setCityResults([]);
          setCityError("城市搜索暂时不可用，可先用下方常用城市。");
          return;
        }
        setCityResults(Array.isArray(data.results) ? data.results : []);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setCityResults([]);
        setCityError("城市搜索暂时不可用，可先用下方常用城市。");
      } finally {
        setCitySearching(false);
      }
    }, 320);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [cityQuery]);

  useEffect(() => {
    const query = hotelQuery.trim();
    if (!query) {
      setHotelResults([]);
      setHotelSearching(false);
      setHotelError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setHotelSearching(true);
      setHotelError(null);
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(query)}&kind=hotel&city=${encodeURIComponent(
            city.name,
          )}&lat=${city.lat}&lng=${city.lng}`,
          { signal: controller.signal },
        );
        const data: SearchResponse = await response.json();
        if (!response.ok || data.error) {
          setHotelResults([]);
          setHotelError("酒店搜索暂时不可用，可以先跳过，让漫城推荐落脚片区。");
          return;
        }
        setHotelResults(Array.isArray(data.results) ? data.results : []);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setHotelResults([]);
        setHotelError("酒店搜索暂时不可用，可以先跳过，让漫城推荐落脚片区。");
      } finally {
        setHotelSearching(false);
      }
    }, 350);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [hotelQuery, city.name, city.lat, city.lng]);

  const holiday = getHoliday(date);
  const weekend = isWeekend(date);
  const demoCity = isDemoCity(city.name);
  const minDate = todayISOLocal();
  // 攻略解析需要一个地理锚点；住处未定时用城市中心，不影响排线用的落脚推荐。
  const guideHotel = useMemo<Place>(
    () =>
      hotel ?? {
        id: `center-${city.name}`,
        name: `${city.name}市中心`,
        category: "hotel",
        lat: city.lat,
        lng: city.lng,
        city: city.name,
        source: "demo",
      },
    [hotel, city.name, city.lat, city.lng],
  );
  const transportLabel =
    TRANSPORT_OPTIONS.find((option) => option.id === transport)?.label ??
    "交通自动";
  const farLabel =
    farDays === null ? "远足自动" : farDays === 0 ? "就近玩" : `远足 ${farDays} 天`;
  const transportSummary =
    transportLabel === "自动" ? "交通自动" : `交通 ${transportLabel}`;
  const advancedSummary = `${farLabel} · ${transportSummary} · ${BUDGET_TIERS[budgetTier].label} · ${adults} 成人${children ? ` ${children} 儿童` : ""}${seniors ? ` ${seniors} 老人` : ""}`;

  function chooseCity(place: Place) {
    setCityQuery("");
    setCityResults([]);
    setCityOpen(false);
    onCityChange({
      name: place.name,
      address: place.address,
      lat: place.lat,
      lng: place.lng,
    });
  }

  function chooseHotel(place: Place) {
    setHotelQuery("");
    setHotelResults([]);
    setHotelOpen(false);
    onHotelChange({ ...place, category: "hotel" });
  }

  return (
    <div className="space-y-5 rounded-[26px] border border-line/70 bg-card/60 p-4 shadow-soft backdrop-blur-sm sm:p-5">
      <Section no="01" title="目的地" hint="任意城市">
        <div className="rounded-2xl border border-line bg-card p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-serif text-[22px] leading-tight tracking-wide text-ink">
                {city.name}
              </p>
              <p className="mt-1 truncate text-[11px] text-ink-faint">
                {city.address ??
                  `${city.lat.toFixed(3)}, ${city.lng.toFixed(3)}`}
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-jade-soft px-2 py-1 text-[10.5px] tracking-[0.12em] text-jade">
              目的地
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {QUICK_CITIES.map((option) => (
            <Chip
              key={option.name}
              active={option.name === city.name}
              onClick={() => onCityChange(option)}
            >
              {option.name}
            </Chip>
          ))}
        </div>

        <div className="relative">
          <Icon
            name="search"
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            value={cityQuery}
            onChange={(event) => {
              setCityQuery(event.target.value);
              setCityOpen(true);
            }}
            onFocus={() => setCityOpen(true)}
            onBlur={() => window.setTimeout(() => setCityOpen(false), 120)}
            placeholder="搜索其他城市"
            className={`${FIELD_CLASS} pl-8 pr-8`}
          />
          {citySearching ? (
            <Spinner className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-accent" />
          ) : null}
          {cityOpen && cityResults.length > 0 ? (
            <SearchList results={cityResults} onChoose={chooseCity} />
          ) : null}
          {cityOpen && !citySearching && cityError ? (
            <p className="mt-1.5 px-1 text-[10.5px] leading-relaxed text-accent-deep">
              {cityError}
            </p>
          ) : null}
        </div>
      </Section>

      <div className="h-px bg-line/60" />

      <Section no="02" title="落脚点" hint="没定也可以先排">
        {hotel ? (
          <div className="rounded-xl border border-line bg-card px-3 py-2.5">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-jade-soft text-jade">
                <Icon name="bed" size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium text-ink">
                  {hotel.name}
                </p>
                <p className="mt-0.5 truncate text-[11px] text-ink-faint">
                  {hotel.address ??
                    `${hotel.lat.toFixed(3)}, ${hotel.lng.toFixed(3)}`}
                </p>
                {hotel.cost ? (
                  <p className="mt-1 text-[11px] text-jade">
                    {money(hotel.cost)} / 晚 · 参考价
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-jade/40 bg-jade-soft/40 px-3 py-2.5">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-card text-jade">
                <Icon name="bed" size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-ink">还没定住处</p>
                <p className="mt-0.5 text-[10.5px] leading-relaxed text-ink-faint">
                  漫城会按景点分布推荐落脚片区，酒店到片区里再挑。
                </p>
              </div>
            </div>
          </div>
        )}

        {hotel ? (
          <button
            type="button"
            onClick={onHotelUndecided}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-line px-3 py-2.5 text-[12px] text-ink-soft transition hover:border-jade/50 hover:text-jade"
          >
            <Icon name="sparkles" size={13} />
            还没定，帮我按景点推荐
          </button>
        ) : null}

        <button
          type="button"
          onClick={onTogglePick}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 py-2.5 text-[12px] transition",
            picking
              ? "border-accent bg-accent-soft/70 text-accent-deep"
              : "border-line text-ink-soft hover:border-ink/30 hover:text-ink",
          )}
        >
          <Icon name="map-pin" size={13} />
          {picking ? "请在地图上点击位置 · 再点一次取消" : "在地图上点选酒店"}
        </button>

        <div className="relative">
          <Icon
            name="search"
            size={13}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            value={hotelQuery}
            onChange={(event) => {
              setHotelQuery(event.target.value);
              setHotelOpen(true);
            }}
            onFocus={() => setHotelOpen(true)}
            onBlur={() => window.setTimeout(() => setHotelOpen(false), 120)}
            placeholder="搜索酒店、民宿或地标"
            className={`${FIELD_CLASS} pl-8 pr-8`}
          />
          {hotelSearching ? (
            <Spinner className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-accent" />
          ) : null}
          {hotelOpen && hotelResults.length > 0 ? (
            <SearchList results={hotelResults} onChoose={chooseHotel} />
          ) : null}
          {hotelOpen && !hotelSearching && hotelError ? (
            <p className="mt-1.5 px-1 text-[10.5px] leading-relaxed text-accent-deep">
              {hotelError}
            </p>
          ) : null}
        </div>

        {demoCity ? (
          <div className="space-y-1.5">
            <p className="text-[10.5px] tracking-[0.12em] text-ink-faint">
              厦门常用落脚点
            </p>
            {DEMO_HOTELS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => onHotelChange(option)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12px] transition",
                  option.id === hotel?.id
                    ? "border-jade/50 bg-jade-soft/60 text-jade"
                    : "border-line bg-card/60 text-ink-soft hover:border-ink/25",
                )}
              >
                <Icon name="bed" size={12} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                <span className="shrink-0 text-ink-faint">
                  {option.cost ? `¥${option.cost}` : "—"}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </Section>

      <div className="h-px bg-line/60" />

      <Section no="03" title="怎么玩" hint="自动重排">
        <div className="space-y-1.5">
          <Stepper
            label="游玩天数"
            value={days}
            min={1}
            max={15}
            suffix="天"
            onChange={onDaysChange}
          />
          <div className="flex items-center justify-between rounded-xl border border-line bg-card/70 px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-[13px] text-ink-soft">
              <Icon name="calendar" size={13} className="text-ink-faint" />
              出发日期
            </span>
            <input
              type="date"
              value={date}
              min={minDate}
              onChange={(event) => {
                if (event.target.value) onDateChange(event.target.value);
              }}
              className="bg-transparent font-serif text-[14px] tabular-nums text-ink focus:outline-none"
            />
          </div>
          {holiday ? (
            <div className="rounded-lg bg-amber-soft px-2.5 py-2 text-[10.5px] leading-relaxed text-amber">
              <span className="font-medium">
                {holiday.name} · 人流约 +{holiday.crowdPct}%
              </span>
              <span className="mt-0.5 block text-amber/85">{holiday.tip}</span>
            </div>
          ) : weekend ? (
            <p className="px-1 text-[10.5px] leading-relaxed text-ink-faint">
              周末热门点位会排队，排线已按人流系数放宽路上的时间。
            </p>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <p className="px-1 text-[10.5px] tracking-[0.12em] text-ink-faint">节奏</p>
          <div className="grid grid-cols-3 gap-1.5">
            {Object.entries(PACES).map(([id, option]) => (
              <button
                key={id}
                type="button"
                onClick={() => onPaceChange(id as PaceId)}
                className={cn(
                  "rounded-xl border px-2 py-2.5 text-left transition",
                  pace === id
                    ? "border-ink bg-ink text-paper"
                    : "border-line bg-card/70 text-ink hover:border-ink/25",
                )}
              >
                <span className="block font-serif text-[14px] leading-none">
                  {option.label}
                </span>
                <span
                  className={cn(
                    "mt-1 block text-[10.5px] leading-none",
                    pace === id ? "text-paper/70" : "text-ink-faint",
                  )}
                >
                  {option.short}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="flex items-center justify-between px-1 text-[10.5px] tracking-[0.12em] text-ink-faint">
            <span>旅行风格</span>
            <span>最多 3 个 · 已选 {styles.length}</span>
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {STYLES.map((style) => {
              const active = styles.includes(style.id);
              return (
                <button
                  key={style.id}
                  type="button"
                  onClick={() => onStyleToggle(style.id)}
                  className={cn(
                    "flex items-start gap-2 rounded-xl border px-2.5 py-2.5 text-left transition",
                    active
                      ? "border-accent/55 bg-accent-soft/60"
                      : "border-line bg-card/70 hover:border-ink/25",
                  )}
                >
                  <Icon
                    name={style.icon}
                    size={14}
                    className={cn(
                      "mt-0.5 shrink-0",
                      active ? "text-accent" : "text-ink-soft",
                    )}
                  />
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block text-[12px] leading-tight",
                        active ? "text-accent-deep" : "text-ink",
                      )}
                    >
                      {style.label}
                    </span>
                    <span className="mt-0.5 block truncate text-[10.5px] leading-tight text-ink-faint">
                      {style.tagline}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="flex items-center justify-between px-1 text-[10.5px] tracking-[0.12em] text-ink-faint">
            <span>最想做的事</span>
            <span>最多 3 个 · 已选 {experiences.length}</span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {EXPERIENCE_OPTIONS.map((option) => {
              const active = experiences.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onExperienceToggle(option.id)}
                  className={cn(
                    "rounded-full border px-2.5 py-1.5 text-[11.5px] transition",
                    active
                      ? "border-jade/55 bg-jade-soft/70 text-jade"
                      : "border-line bg-card/70 text-ink-soft hover:border-ink/25",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <p className="px-1 text-[10.5px] leading-relaxed text-ink-faint">
            从心愿出发，漫城会把它们落到具体点位和时段，不再只看景点名气。
          </p>
        </div>

        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          className="flex w-full items-center gap-2 rounded-xl border border-line bg-card/70 px-2.5 py-2.5 text-left transition hover:border-ink/25"
        >
          <Icon name="compass" size={13} className="shrink-0 text-ink-soft" />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] text-ink">更多偏好</span>
            <span className="mt-0.5 block truncate text-[10.5px] text-ink-faint">
              {advancedSummary}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-ink-faint">
            {advancedOpen ? "收起" : "展开"}
            <Icon
              name="chevron-down"
              size={12}
              className={cn("mc-chevron", advancedOpen && "rotate-180")}
            />
          </span>
        </button>

        {advancedOpen ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="px-1 text-[10.5px] tracking-[0.12em] text-ink-faint">
                远足天数
              </p>
              <div className="grid grid-cols-5 gap-1.5">
                {FAR_DAY_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => onFarDaysChange(option.value)}
                    className={cn(
                      "rounded-xl border px-1 py-2.5 text-center text-[12px] transition",
                      farDays === option.value
                        ? "border-jade/55 bg-jade-soft/70 text-jade"
                        : "border-line bg-card/70 text-ink hover:border-ink/25",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="px-1 text-[10.5px] leading-relaxed text-ink-faint">
                较远但出名的景点值得专程去，全天只走一个方向；自动会按名气和距离权衡。
              </p>
            </div>

            <div className="space-y-1.5">
              <p className="px-1 text-[10.5px] tracking-[0.12em] text-ink-faint">
                交通方式
              </p>
              <div className="grid grid-cols-2 gap-1.5">
                {TRANSPORT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => onTransportChange(option.id)}
                    className={cn(
                      "flex items-center gap-2 rounded-xl border px-2.5 py-2.5 text-left transition",
                      transport === option.id
                        ? "border-jade/50 bg-jade-soft/70"
                        : "border-line bg-card/70 hover:border-ink/25",
                    )}
                  >
                    <Icon
                      name={option.icon}
                      size={13}
                      className={
                        transport === option.id ? "text-jade" : "text-ink-soft"
                      }
                    />
                    <span className="min-w-0">
                      <span
                        className={cn(
                          "block text-[12px] leading-tight",
                          transport === option.id ? "text-jade" : "text-ink",
                        )}
                      >
                        {option.label}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] leading-tight text-ink-faint">
                        {option.description}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="px-1 text-[10.5px] tracking-[0.12em] text-ink-faint">
                预算档位
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {Object.entries(BUDGET_TIERS).map(([id, option]) => (
                  <Chip
                    key={id}
                    active={budgetTier === id}
                    onClick={() => onBudgetChange(id as BudgetTier)}
                    className="w-full"
                    title={option.description}
                  >
                    {option.label}
                  </Chip>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <Stepper
                label="成人"
                value={adults}
                min={0}
                max={10}
                onChange={onAdultsChange}
              />
              <Stepper
                label="儿童"
                value={children}
                min={0}
                max={10}
                onChange={onChildrenChange}
              />
              <Stepper
                label="老人"
                value={seniors}
                min={0}
                max={10}
                onChange={onSeniorsChange}
              />
            </div>
          </div>
        ) : null}
      </Section>

      <div className="h-px bg-line/60" />

      <Section no="04" title="现成攻略" hint={fixedCount ? `已锁 ${fixedCount} 点` : "可选"}>
        <GuideImport
          city={city.name}
          hotel={guideHotel}
          resetKey={guideResetKey}
          busy={busy}
          appliedCount={fixedCount}
          onApply={onGuideApply}
          onClear={onGuideClear}
        />
      </Section>

      <div className="space-y-2 pt-1">
        <button
          type="button"
          onClick={onGenerate}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-accent px-4 py-3.5 text-[14px] font-medium tracking-wide text-paper shadow-lift transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <Spinner className="h-3.5 w-3.5" />
          ) : (
            <Icon name="sparkles" size={15} />
          )}
          {busy
            ? "正在重新排线…"
            : hasPlan
              ? "按当前偏好重新生成"
              : "生成我的行程"}
        </button>
        <p className="text-center text-[10.5px] leading-relaxed text-ink-faint">
          改动任一偏好都会自动重排；想保留设置时，也可以手动再生成一次。
        </p>
      </div>

      <div className="rounded-xl border border-line/70 bg-paper/60 px-3 py-2.5 text-[10.5px] leading-relaxed text-ink-faint">
        <div className="flex items-center gap-1.5 text-ink-soft">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              liveData ? "bg-jade" : "bg-amber",
            )}
          />
          {liveData
            ? "高德 Web 服务已连接 · 任意城市真实商户与公交"
            : "免 Key 模式 · 厦门为内置演示城市"}
        </div>
        <p className="mt-1">
          步行与驾车走真实路网；门票、房价与人流为参考估算，预订前请再确认。
        </p>
      </div>
    </div>
  );
}
