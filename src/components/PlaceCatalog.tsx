"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CATALOG_THEME_COLORS,
  CATALOG_THEME_LABELS,
  CATALOG_THEME_ORDER,
  POPULARITY_TIERS,
  TIER_BY_ID,
  type CatalogEntry,
  type CatalogResult,
  type CatalogThemeId,
  type PopularityTier,
} from "@/lib/catalog";
import { CATEGORY_LABELS } from "@/lib/constants";
import type { Place } from "@/lib/types";
import { Icon } from "./Icon";
import PlacePhoto from "./PlacePhoto";
import { Spinner, cn } from "./ui";

const MAX_SELECTION = 40;
const PAGE_SIZE = 40;

const TIER_BADGE: Record<PopularityTier, string> = {
  icon: "bg-accent-soft text-accent-deep",
  must: "bg-amber-soft text-amber",
  recommend: "bg-jade-soft text-jade",
  hidden: "bg-paper-deep text-ink-soft",
};

export interface PlaceCatalogProps {
  city: string;
  catalog: CatalogResult | null;
  loading: boolean;
  error: { message: string; hint?: string } | null;
  selectedIds: string[];
  focus: { placeId: string; nonce: number } | null;
  onToggle: (place: Place) => void;
  onClear: () => void;
  onRefresh: () => void;
  onPlan: () => void;
  onFocus: (placeId: string) => void;
  scanning?: boolean;
  scanNote?: string | null;
}

export default function PlaceCatalog({
  city,
  catalog,
  loading,
  error,
  selectedIds,
  focus,
  onToggle,
  onClear,
  onRefresh,
  onPlan,
  onFocus,
  scanning = false,
  scanNote = null,
}: PlaceCatalogProps) {
  const [query, setQuery] = useState("");
  const [tier, setTier] = useState<PopularityTier | "all">("all");
  const [theme, setTheme] = useState<CatalogThemeId | "all">("all");
  const [onlySelected, setOnlySelected] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);

  useEffect(() => {
    setLimit(PAGE_SIZE);
  }, [query, tier, theme, onlySelected]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const entries = catalog?.entries ?? [];
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (tier !== "all" && entry.tier !== tier) return false;
      if (theme !== "all" && entry.theme !== theme) return false;
      if (onlySelected && !selectedSet.has(entry.place.id)) return false;
      if (!keyword) return true;
      const haystack = [
        entry.place.name,
        entry.intro,
        entry.place.address ?? "",
        entry.bestTime ?? "",
        entry.booking ?? "",
        entry.duration ?? "",
        CATALOG_THEME_LABELS[entry.theme],
        ...entry.tags,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [entries, query, tier, theme, onlySelected, selectedSet]);

  const visible = filtered.slice(0, limit);
  const hasFilters =
    Boolean(query.trim()) || tier !== "all" || theme !== "all" || onlySelected;

  return (
    <div className="rounded-[22px] border border-line/70 bg-card/80 p-3.5 shadow-soft sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="font-serif text-[18px] tracking-wide text-ink">
            景点图鉴
          </h2>
          <p className="mt-0.5 text-[10.5px] text-ink-faint">
            {catalog
              ? `${city} · 共 ${catalog.total} 个景点 · ${
                  catalog.sourceNote || "自动汇总"
                }`
              : `${city} · 正在等待景点数据`}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {catalog ? (
            <span className="hidden text-[10px] tabular-nums text-ink-faint sm:inline">
              更新于{" "}
              {new Date(catalog.updatedAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flex items-center gap-1 rounded-full border border-line bg-paper/70 px-2.5 py-1.5 text-[11px] text-ink-soft transition hover:border-ink/30 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon name="refresh" size={11} />
            刷新
          </button>
        </div>
      </div>

      {catalog?.sniff ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-relaxed text-ink-faint">
          <span className="rounded-full bg-paper-deep/70 px-2 py-0.5 font-medium text-ink-soft">
            {catalog.sniff.stage === "deep" ? "全城深挖" : "快速扫描"}
          </span>
          {catalog.sniff.bySource.amap ? (
            <span>高德 {catalog.sniff.bySource.amap}</span>
          ) : null}
          {catalog.sniff.bySource.osm ? (
            <span>OpenStreetMap {catalog.sniff.bySource.osm}</span>
          ) : null}
          {catalog.sniff.bySource.wikidata ? (
            <span>Wikidata {catalog.sniff.bySource.wikidata}</span>
          ) : null}
          {catalog.sniff.bySource.demo ? (
            <span>精选 {catalog.sniff.bySource.demo}</span>
          ) : null}
          <span>· 用时 {(catalog.sniff.elapsedMs / 1000).toFixed(1)}s</span>
          {catalog.sniff.hasMore ? <span>· 还有更多待补全</span> : null}
        </div>
      ) : null}

      {scanning ? (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-accent/25 bg-accent-soft/30 px-3 py-2 text-[11px] text-ink-soft">
          <Spinner className="h-3 w-3 text-accent" />
          正在深挖全市，已显示 {catalog?.total ?? 0} 个景点，完成后自动补全…
        </div>
      ) : null}

      {scanNote ? (
        <div className="mt-2 rounded-xl border border-amber/25 bg-amber-soft/35 px-3 py-2 text-[10.5px] leading-relaxed text-ink-soft">
          {scanNote}
        </div>
      ) : null}

      <div className="mt-3 flex items-center gap-2 rounded-xl border border-line bg-card px-3 py-2">
        <Icon name="search" size={14} className="shrink-0 text-ink-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜景点名、关键词，比如「日落」「老街」"
          className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint/80"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="清空搜索"
            className="shrink-0 rounded-full p-0.5 text-ink-faint transition hover:text-ink"
          >
            <Icon name="x" size={13} />
          </button>
        ) : null}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <FilterChip
          active={tier === "all"}
          onClick={() => setTier("all")}
          label={`全部 ${catalog?.total ?? 0}`}
        />
        {POPULARITY_TIERS.map((item) => (
          <FilterChip
            key={item.id}
            active={tier === item.id}
            onClick={() => setTier(item.id)}
            label={`${item.label} ${
              catalog?.tierCounts[item.id] ?? 0
            }`}
            dotClass={
              item.id === "icon"
                ? "bg-accent"
                : item.id === "must"
                  ? "bg-amber"
                  : item.id === "recommend"
                    ? "bg-jade"
                    : "bg-ink-faint"
            }
          />
        ))}
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <FilterChip
          active={theme === "all"}
          onClick={() => setTheme("all")}
          label="全部主题"
        />
        {CATALOG_THEME_ORDER.filter(
          (id) => (catalog?.themeCounts[id] ?? 0) > 0,
        ).map((id) => (
          <FilterChip
            key={id}
            active={theme === id}
            onClick={() => setTheme(id)}
            label={`${CATALOG_THEME_LABELS[id]} ${
              catalog?.themeCounts[id] ?? 0
            }`}
            dotClass=""
            dotColor={CATALOG_THEME_COLORS[id]}
          />
        ))}
        <FilterChip
          active={onlySelected}
          onClick={() => setOnlySelected((value) => !value)}
          label={`只看已选 ${selectedIds.length}`}
        />
      </div>

      <div
        className={cn(
          "mt-3 flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2",
          selectedIds.length
            ? "border-accent/30 bg-accent-soft/35"
            : "border-line/70 bg-paper/60",
        )}
      >
        <p className="text-[12px] text-ink-soft">
          {selectedIds.length ? (
            <>
              已选 <span className="font-medium text-accent-deep">{selectedIds.length}</span>{" "}
              个景点
              <span className="ml-1 hidden text-[10.5px] text-ink-faint sm:inline">
                · 会按位置分组、分配到每天，其余时间照常自动补全
              </span>
            </>
          ) : (
            "勾选想去的景点，再让漫城为它们安排路线"
          )}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          {selectedIds.length ? (
            <button
              type="button"
              onClick={onClear}
              className="rounded-full px-2.5 py-1.5 text-[11.5px] text-ink-faint transition hover:text-ink"
            >
              清空
            </button>
          ) : null}
          <button
            type="button"
            onClick={onPlan}
            disabled={!selectedIds.length}
            className="flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-medium text-paper transition hover:bg-accent-deep disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Icon name="route" size={12} />
            用这些景点安排路线
          </button>
        </div>
      </div>

      {loading && !catalog ? (
        <div className="mt-8 mb-6 flex flex-col items-center gap-3 text-center">
          <Spinner className="text-accent" />
          <p className="text-[12.5px] text-ink-soft">
            正在扫描 {city} 全市的景点…
          </p>
          <p className="text-[10.5px] text-ink-faint">
            先出快速结果，再自动深挖全城；第一次通常需要几秒到十几秒
          </p>
        </div>
      ) : error && !catalog ? (
        <div className="mt-6 mb-4 rounded-xl border border-amber/30 bg-amber-soft/40 px-3 py-3 text-center">
          <p className="text-[12.5px] text-ink-soft">{error.message}</p>
          {error.hint ? (
            <p className="mt-1 text-[10.5px] leading-relaxed text-ink-faint">
              {error.hint}
            </p>
          ) : null}
          <button
            type="button"
            onClick={onRefresh}
            className="mt-2 rounded-full border border-ink/15 bg-card px-3 py-1.5 text-[11.5px] text-ink transition hover:border-ink/30"
          >
            再试一次
          </button>
        </div>
      ) : (
        <>
          {catalog && catalog.notes.length ? (
            <ul className="mt-3 space-y-0.5">
              {catalog.notes.slice(0, 2).map((note) => (
                <li
                  key={note}
                  className="flex items-start gap-1 text-[10.5px] leading-relaxed text-ink-faint"
                >
                  <Icon name="info" size={10} className="mt-0.5 shrink-0" />
                  {note}
                </li>
              ))}
            </ul>
          ) : null}

          {visible.length ? (
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {visible.map((entry) => (
                <CatalogCard
                  key={entry.place.id}
                  entry={entry}
                  city={city}
                  selected={selectedSet.has(entry.place.id)}
                  active={focus?.placeId === entry.place.id}
                  disabled={
                    !selectedSet.has(entry.place.id) &&
                    selectedIds.length >= MAX_SELECTION
                  }
                  onToggle={onToggle}
                  onFocus={onFocus}
                />
              ))}
            </div>
          ) : (
            <div className="mt-6 mb-4 text-center">
              <p className="text-[12.5px] text-ink-soft">
                {hasFilters ? "没有匹配的景点" : "这个城市暂时没有可展示的景点"}
              </p>
              {hasFilters ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setTier("all");
                    setTheme("all");
                    setOnlySelected(false);
                  }}
                  className="mt-2 rounded-full border border-ink/15 bg-card px-3 py-1.5 text-[11.5px] text-ink transition hover:border-ink/30"
                >
                  清空筛选
                </button>
              ) : null}
            </div>
          )}

          {filtered.length > visible.length ? (
            <button
              type="button"
              onClick={() => setLimit((value) => value + PAGE_SIZE * 2)}
              className="mt-3 w-full rounded-xl border border-dashed border-line py-2 text-[11.5px] text-ink-soft transition hover:border-ink/30 hover:text-ink"
            >
              展开其余 {filtered.length - visible.length} 个景点
            </button>
          ) : null}

          <p className="mt-3 text-[10px] leading-relaxed text-ink-faint">
            分类、标签、一句话介绍与热门分级均由地图数据自动派生；全城扫描会持续补全小众点位，刷新即可同步最新数据。
          </p>
        </>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  dotClass,
  dotColor,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  dotClass?: string;
  dotColor?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] leading-none transition",
        active
          ? "border-ink bg-ink text-paper"
          : "border-line bg-card/70 text-ink-soft hover:border-ink/30 hover:text-ink",
      )}
    >
      {dotClass || dotColor ? (
        <span
          className={cn("h-1.5 w-1.5 rounded-full", dotClass)}
          style={dotColor ? { background: dotColor } : undefined}
        />
      ) : null}
      {label}
    </button>
  );
}

function CatalogCard({
  entry,
  city,
  selected,
  active,
  disabled,
  onToggle,
  onFocus,
}: {
  entry: CatalogEntry;
  city: string;
  selected: boolean;
  active: boolean;
  disabled: boolean;
  onToggle: (place: Place) => void;
  onFocus: (placeId: string) => void;
}) {
  const tierMeta = TIER_BY_ID[entry.tier];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onFocus(entry.place.id)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onFocus(entry.place.id);
        }
      }}
      className={cn(
        "group relative flex cursor-pointer flex-col rounded-xl border bg-card px-3 py-2.5 text-left transition",
        selected
          ? "border-accent/45 bg-accent-soft/20 shadow-[0_10px_22px_-18px_rgba(193,90,54,0.6)]"
          : "border-line/70 hover:border-ink/25",
        active && "ring-2 ring-accent/40",
      )}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-white/70"
          style={{ background: CATALOG_THEME_COLORS[entry.theme] }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[13.5px] font-medium text-ink">
              {entry.place.name}
            </p>
            <span
              className={cn(
                "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] leading-none",
                TIER_BADGE[entry.tier],
              )}
            >
              {tierMeta.label}
            </span>
          </div>
          <p className="mt-1 text-[10px] text-ink-faint">
            {CATALOG_THEME_LABELS[entry.theme]} ·{" "}
            {CATEGORY_LABELS[entry.place.category]} · 人气{" "}
            {entry.popularity.toFixed(1)}
            {entry.duration ? ` · ${entry.duration}` : ""}
          </p>
          <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-ink-soft">
            {entry.intro}
          </p>
          {entry.tags.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {entry.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-paper/80 px-1.5 py-0.5 text-[9px] text-ink-faint"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {entry.photo ? (
          <PlacePhoto
            name={entry.place.name}
            city={city}
            lat={entry.place.lat}
            lng={entry.place.lng}
            qid={entry.place.wikidataId}
            image={entry.place.image}
            commons={entry.place.commons}
            category={entry.place.category}
            compact
            aspect="aspect-square w-[62px]"
            className="shrink-0 rounded-lg"
          />
        ) : null}
      </div>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (disabled) return;
          onToggle(entry.place);
        }}
        disabled={disabled}
        className={cn(
          "mt-2 flex w-full items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] leading-none transition",
          selected
            ? "border-accent/40 bg-card text-accent-deep hover:bg-accent-soft/50"
            : "border-line bg-paper/60 text-ink-soft hover:border-ink/30 hover:text-ink",
          disabled && "cursor-not-allowed opacity-40",
        )}
      >
        <Icon name={selected ? "check" : "map-pin"} size={11} />
        {selected ? "已加入 · 点击移除" : "加入行程"}
      </button>
    </div>
  );
}