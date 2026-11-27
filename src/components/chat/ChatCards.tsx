"use client";

import { useEffect, useRef, useState } from "react";
import {
  BUDGET_TIERS,
  PACES,
  QUICK_CITIES,
  STYLES,
  STYLE_LABELS,
  TRANSPORT_OPTIONS,
} from "@/lib/constants";
import { CITY_FACTS, NEUTRAL_FACTS } from "@/content/city-facts.generated";
import { todayISOLocal } from "@/lib/geo";
import type { Place } from "@/lib/types";
import { cityFromPlace, hotelForCity } from "@/lib/chat/draft";
import type { ChatCard, ChatDraft, ResolvedPatch } from "@/lib/chat/types";
import { Icon } from "../Icon";
import { cn } from "../ui";

const DAY_CHOICES = [1, 2, 3, 4, 5, 6, 7, 8];

function OptionButton({
  active,
  children,
  onClick,
  disabled,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "rounded-full border px-3 py-1.5 text-[12px] leading-tight transition",
        active
          ? "border-jade bg-jade-soft text-jade"
          : "border-line bg-card text-ink-soft hover:border-ink/25 hover:text-ink",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {children}
    </button>
  );
}

function CardShell({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-2 rounded-2xl border border-line/70 bg-paper/55 p-3">
      <p className="text-[12.5px] font-medium leading-snug text-ink">{title}</p>
      {hint ? (
        <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">{hint}</p>
      ) : null}
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function CityCard({
  draft,
  onApply,
  disabled,
}: {
  draft: ChatDraft;
  onApply: (patch: ResolvedPatch) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true);
      void fetch(
        `/api/search?kind=city&q=${encodeURIComponent(text)}`,
        { signal: controller.signal },
      )
        .then(async (response) => {
          const data = (await response.json()) as { results?: Place[] };
          setResults(Array.isArray(data.results) ? data.results.slice(0, 6) : []);
          setSearched(true);
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearched(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 320);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {QUICK_CITIES.map((city) => (
          <OptionButton
            key={city.name}
            active={draft.confirmed.city && draft.city.name === city.name}
            disabled={disabled}
            onClick={() => onApply({ city })}
          >
            {city.name}
          </OptionButton>
        ))}
      </div>
      <div className="relative">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={disabled}
          placeholder="也可以输入城市名，比如 泉州"
          className="w-full rounded-xl border border-line bg-card px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint/70 focus:border-jade/50"
        />
        {searching ? (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-ink-faint">
            查找中
          </span>
        ) : null}
      </div>
      {results.length ? (
        <div className="space-y-1">
          {results.map((place) => (
            <button
              key={place.id}
              type="button"
              disabled={disabled}
              onClick={() => onApply({ city: cityFromPlace(place) })}
              className="flex w-full items-center justify-between rounded-xl border border-line/70 bg-card px-3 py-2 text-left transition hover:border-ink/25"
            >
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] text-ink">
                  {place.name}
                </span>
                <span className="block truncate text-[10.5px] text-ink-faint">
                  {place.address ?? "选择这座城市"}
                </span>
              </span>
              <Icon name="chevron-right" size={12} className="shrink-0 text-ink-faint" />
            </button>
          ))}
        </div>
      ) : searched && !searching ? (
        <p className="text-[11px] text-ink-faint">
          没找到这座城市，换一个名字或直接点上面的常用城市。
        </p>
      ) : null}
    </div>
  );
}

function DateCard({
  draft,
  onApply,
  disabled,
}: {
  draft: ChatDraft;
  onApply: (patch: ResolvedPatch) => void;
  disabled?: boolean;
}) {
  const [date, setDate] = useState(draft.date);
  const [days, setDays] = useState(draft.days);
  const today = todayISOLocal();

  return (
    <div className="space-y-2.5">
      <label className="block text-[11px] text-ink-faint">
        出发日期
        <input
          type="date"
          value={date}
          min={today}
          disabled={disabled}
          onChange={(event) => setDate(event.target.value)}
          className="mt-1 w-full rounded-xl border border-line bg-card px-3 py-2 text-[13px] text-ink outline-none focus:border-jade/50"
        />
      </label>
      <div>
        <p className="text-[11px] text-ink-faint">玩几天</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {DAY_CHOICES.map((value) => (
            <OptionButton
              key={value}
              active={days === value}
              disabled={disabled}
              onClick={() => setDays(value)}
            >
              {value} 天
            </OptionButton>
          ))}
        </div>
      </div>
      <button
        type="button"
        disabled={disabled || !date}
        onClick={() => onApply({ date, days })}
        className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12px] text-paper transition hover:bg-ink/90 disabled:opacity-40"
      >
        就这几天
        <Icon name="chevron-right" size={12} />
      </button>
    </div>
  );
}

function PartyCard({
  draft,
  onApply,
  disabled,
}: {
  draft: ChatDraft;
  onApply: (patch: ResolvedPatch) => void;
  disabled?: boolean;
}) {
  const [adults, setAdults] = useState(draft.adults);
  const [children, setChildren] = useState(draft.children);
  const [seniors, setSeniors] = useState(draft.seniors);
  const total = adults + children + seniors;

  const stepper = (
    label: string,
    value: number,
    min: number,
    max: number,
    setValue: (value: number) => void,
  ) => (
    <div className="flex items-center justify-between rounded-xl border border-line/70 bg-card px-3 py-2">
      <span className="text-[12.5px] text-ink">{label}</span>
      <span className="flex items-center gap-2.5">
        <button
          type="button"
          disabled={disabled || value <= min}
          onClick={() => setValue(value - 1)}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-line text-ink-soft transition hover:border-ink/30 disabled:opacity-30"
        >
          −
        </button>
        <span className="w-5 text-center text-[13px] tabular-nums text-ink">
          {value}
        </span>
        <button
          type="button"
          disabled={disabled || value >= max}
          onClick={() => setValue(value + 1)}
          className="flex h-6 w-6 items-center justify-center rounded-full border border-line text-ink-soft transition hover:border-ink/30 disabled:opacity-30"
        >
          +
        </button>
      </span>
    </div>
  );

  return (
    <div className="space-y-2">
      {stepper("成人（60 岁以下）", adults, 0, 9, setAdults)}
      {stepper("儿童", children, 0, 9, setChildren)}
      {stepper("老人（60 岁以上）", seniors, 0, 9, setSeniors)}
      {total < 1 ? (
        <p className="text-[11px] text-ink-faint">至少要有 1 位同行者才能开始安排。</p>
      ) : null}
      <button
        type="button"
        disabled={disabled || total < 1}
        onClick={() => onApply({ adults, children, seniors })}
        className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12px] text-paper transition hover:bg-ink/90 disabled:opacity-40"
      >
        就这些人
        <Icon name="chevron-right" size={12} />
      </button>
    </div>
  );
}

function StyleCard({
  draft,
  onApply,
  onSay,
  disabled,
}: {
  draft: ChatDraft;
  onApply: (patch: ResolvedPatch) => void;
  onSay?: (text: string) => void;
  disabled?: boolean;
}) {
  const [styles, setStyles] = useState<ChatDraft["styles"]>(draft.styles);
  const [experiences, setExperiences] = useState<ChatDraft["experiences"]>(
    draft.experiences,
  );
  const [note, setNote] = useState("");
  // 城市画像：同步查离线生成的表。不再 fetch、不再有「加载失败回退全量」——
  // 那正是内陆城市露出「海边」的根因。查不到城市给中性玩法（无海陆专属）。
  const cityName = draft.city.name;
  const facts = (cityName && CITY_FACTS[cityName]) || NEUTRAL_FACTS;
  const experienceOptions = facts.experiences.map((option) => ({
    id: option.id as ChatDraft["experiences"][number],
    label: option.label,
  }));
  // 风格与心愿同源：无海城市不会出现「环海慢游」。
  const styleOptions = STYLES.filter((style) =>
    (facts.styles as string[]).includes(style.id),
  );

  const say = () => {
    const text = note.trim();
    if (!text || disabled || !onSay) return;
    setNote("");
    onSay(text);
  };

  const toggleStyle = (id: ChatDraft["styles"][number]) => {
    setStyles((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : previous.length >= 3
          ? previous
          : [...previous, id],
    );
  };
  const toggleExperience = (id: ChatDraft["experiences"][number]) => {
    setExperiences((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : previous.length >= 4
          ? previous
          : [...previous, id],
    );
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1.5">
        {styleOptions.map((style) => (
          <OptionButton
            key={style.id}
            active={styles.includes(style.id)}
            disabled={disabled}
            onClick={() => toggleStyle(style.id)}
          >
            {style.label}
          </OptionButton>
        ))}
      </div>
      <div>
        <p className="text-[11px] text-ink-faint">
          {cityName ? `${cityName}适合玩什么` : "一定要做的事"}
        </p>
        {cityName ? (
          <p className="mt-0.5 text-micro text-jade">{facts.summary}</p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {experienceOptions.map((option) => (
            <OptionButton
              key={option.id}
              active={experiences.includes(option.id)}
              disabled={disabled}
              onClick={() => toggleExperience(option.id)}
            >
              {option.label}
            </OptionButton>
          ))}
        </div>
      </div>
      {onSay ? (
        <div>
          <p className="text-[11px] text-ink-faint">更想用自己的话说？</p>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value.slice(0, 200))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                say();
              }
            }}
            rows={2}
            placeholder="例如：带爸妈，腿脚一般，想看海和日落，不想爬山，吃得清淡"
            className="mt-1.5 w-full resize-none rounded-xl border border-line/70 bg-card px-3 py-2 text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-ink/30 focus:outline-none"
          />
          <button
            type="button"
            disabled={disabled || !note.trim()}
            onClick={say}
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-ink/20 px-3.5 py-1.5 text-[11.5px] text-ink transition hover:border-ink/40 disabled:opacity-40"
          >
            按这句话来
            <Icon name="chevron-right" size={11} />
          </button>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onApply({ styles, experiences })}
          className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2 text-[12px] text-paper transition hover:bg-ink/90 disabled:opacity-40"
        >
          按这个来
          <Icon name="chevron-right" size={12} />
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onApply({ styles: [], experiences: [] })}
          className="text-[11.5px] text-ink-faint transition hover:text-ink-soft disabled:opacity-40"
        >
          跳过
        </button>
      </div>
    </div>
  );
}

function HotelCard({
  draft,
  onApply,
  onPickMap,
  disabled,
}: {
  draft: ChatDraft;
  onApply: (patch: ResolvedPatch) => void;
  onPickMap: () => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const timer = window.setTimeout(() => {
      setSearching(true);
      const params = new URLSearchParams({
        kind: "hotel",
        q: text,
        city: draft.city.name,
        lat: String(draft.city.lat),
        lng: String(draft.city.lng),
      });
      void fetch(`/api/search?${params.toString()}`, {
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = (await response.json()) as { results?: Place[] };
          setResults(Array.isArray(data.results) ? data.results.slice(0, 5) : []);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 320);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, draft.city.name, draft.city.lat, draft.city.lng]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <OptionButton disabled={disabled} onClick={() => onApply({ hotelUndecided: true })}>
          还没定，帮我推荐
        </OptionButton>
        <OptionButton disabled={disabled} onClick={() => onApply({ hotel: hotelForCity(draft.city) })}>
          先住市中心
        </OptionButton>
        <OptionButton disabled={disabled} onClick={onPickMap}>
          在地图上点一个
        </OptionButton>
      </div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        disabled={disabled}
        placeholder="或者搜酒店 / 片区，比如 中山路"
        className="w-full rounded-xl border border-line bg-card px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-faint/70 focus:border-jade/50"
      />
      {searching ? (
        <p className="text-[11px] text-ink-faint">查找中…</p>
      ) : results.length ? (
        <div className="space-y-1">
          {results.map((place) => (
            <button
              key={place.id}
              type="button"
              disabled={disabled}
              onClick={() => onApply({ hotel: { ...place, category: "hotel" } })}
              className="flex w-full items-center justify-between rounded-xl border border-line/70 bg-card px-3 py-2 text-left transition hover:border-ink/25"
            >
              <span className="min-w-0">
                <span className="block truncate text-[12.5px] text-ink">
                  {place.name}
                </span>
                <span className="block truncate text-[10.5px] text-ink-faint">
                  {place.address ?? place.name}
                </span>
              </span>
              <Icon name="home" size={12} className="shrink-0 text-ink-faint" />
            </button>
          ))}
        </div>
      ) : null}
      <p className="text-[10.5px] leading-relaxed text-ink-faint">
        {draft.hotelUndecided
          ? "当前：还没定，安排时会按景点分布推荐落脚片区"
          : `当前：${draft.hotel.name}${
              draft.hotel.name.includes("市中心") ? "（默认落脚点）" : ""
            }`}
      </p>
    </div>
  );
}

function ConfirmCard({
  draft,
  onPlan,
  disabled,
  planning,
}: {
  draft: ChatDraft;
  onPlan: () => void;
  disabled?: boolean;
  planning: boolean;
}) {
  const styleText = draft.styles.length
    ? draft.styles.map((id) => STYLE_LABELS[id]).join("、")
    : "不设限";
  const confirmFacts =
    (draft.city.name && CITY_FACTS[draft.city.name]) || NEUTRAL_FACTS;
  const experienceText = draft.experiences.length
    ? draft.experiences
        .map(
          (id) =>
            confirmFacts.experiences.find((option) => option.id === id)?.label ??
            id,
        )
        .join("、")
    : "自动安排";
  const transportText =
    TRANSPORT_OPTIONS.find((option) => option.id === draft.transport)?.label ??
    "自动";

  const rows: [string, string][] = [
    ["城市", draft.city.name],
    ["时间", `${draft.date} · ${draft.days} 天`],
    [
      "同行",
      `${draft.adults} 成人${draft.children ? ` · ${draft.children} 儿童` : ""}${
        draft.seniors ? ` · ${draft.seniors} 老人` : ""
      }`,
    ],
    ["玩法", styleText],
    ["心愿", experienceText],
    ["节奏", `${PACES[draft.pace].label} · ${transportText}`],
    ["预算", BUDGET_TIERS[draft.budgetTier].label],
    ["住处", draft.hotelUndecided ? "还没定（按景点推荐）" : draft.hotel.name],
  ];
  if (draft.avoidSteep) {
    rows.push(["避坑", "不爬山、不走长台阶"]);
  }
  if (draft.notes) {
    rows.push(["补充", draft.notes]);
  }
  if (draft.selectedPlaces.length) {
    rows.push(["点名要去", draft.selectedPlaces.map((place) => place.name).join("、")]);
  }

  return (
    <div className="space-y-2">
      <dl className="space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-[11px] text-ink-faint">{label}</dt>
            <dd className="min-w-0 text-right text-[11.5px] leading-snug text-ink-soft">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        disabled={disabled || planning}
        onClick={onPlan}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[12.5px] text-paper transition hover:bg-ink/90 disabled:opacity-40"
      >
        {planning ? "正在安排…" : "开始安排"}
        {planning ? null : <Icon name="route" size={13} />}
      </button>
    </div>
  );
}

export default function ChatCardView({
  card,
  draft,
  disabled,
  planning,
  onApply,
  onPickMap,
  onPlan,
  onSay,
}: {
  card: ChatCard;
  draft: ChatDraft;
  disabled?: boolean;
  planning: boolean;
  onApply: (patch: ResolvedPatch) => void;
  onPickMap: () => void;
  onPlan: () => void;
  onSay?: (text: string) => void;
}) {
  return (
    <CardShell title={card.title} hint={card.hint}>
      {card.kind === "city" ? (
        <CityCard draft={draft} onApply={onApply} disabled={disabled} />
      ) : card.kind === "date" ? (
        <DateCard draft={draft} onApply={onApply} disabled={disabled} />
      ) : card.kind === "party" ? (
        <PartyCard draft={draft} onApply={onApply} disabled={disabled} />
      ) : card.kind === "style" ? (
        <StyleCard
          draft={draft}
          onApply={onApply}
          onSay={onSay}
          disabled={disabled}
        />
      ) : card.kind === "pace" ? (
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(PACES) as ChatDraft["pace"][]).map((id) => (
            <OptionButton
              key={id}
              active={draft.pace === id}
              disabled={disabled}
              onClick={() => onApply({ pace: id })}
            >
              {PACES[id].label} · {PACES[id].short}
            </OptionButton>
          ))}
        </div>
      ) : card.kind === "transport" ? (
        <div className="flex flex-wrap gap-1.5">
          {TRANSPORT_OPTIONS.map((option) => (
            <OptionButton
              key={option.id}
              active={draft.transport === option.id}
              disabled={disabled}
              onClick={() => onApply({ transport: option.id })}
            >
              {option.label}
            </OptionButton>
          ))}
        </div>
      ) : card.kind === "budget" ? (
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(BUDGET_TIERS) as ChatDraft["budgetTier"][]).map((id) => (
            <OptionButton
              key={id}
              active={draft.budgetTier === id}
              disabled={disabled}
              onClick={() => onApply({ budgetTier: id })}
            >
              {BUDGET_TIERS[id].label}
            </OptionButton>
          ))}
        </div>
      ) : card.kind === "hotel" ? (
        <HotelCard
          draft={draft}
          onApply={onApply}
          onPickMap={onPickMap}
          disabled={disabled}
        />
      ) : (
        <ConfirmCard draft={draft} onPlan={onPlan} disabled={disabled} planning={planning} />
      )}
    </CardShell>
  );
}