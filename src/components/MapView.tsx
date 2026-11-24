"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl, {
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MapLibreMap,
  type MapMouseEvent,
  type Marker,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  CATALOG_THEME_COLORS,
  CATALOG_THEME_LABELS,
  TIER_BY_ID,
  type CatalogEntry,
} from "@/lib/catalog";
import { CATEGORY_LABELS } from "@/lib/constants";
import {
  convertWgsPolylineToGcj,
  gcj02ToWgs84,
  wgs84ToGcj02,
} from "@/lib/coords";
import { clockRange } from "@/lib/format";
import { minutesToTime } from "@/lib/geo";
import type { PlanResult, Place } from "@/lib/types";
import { Spinner } from "./ui";

const TILE_URLS = [
  "https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  "https://webrd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  "https://webrd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  "https://webrd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
];

function toMapPoint(lng: number, lat: number): [number, number] {
  return wgs84ToGcj02(lng, lat);
}

// 预览器或后台页会暂停 requestAnimationFrame，而 MapLibre 5 加载样式时要
// 等下一帧，地图会永远停在“正在铺开”。用定时器兜底，回到前台自动还原。
let frameFallbackRefs = 0;
let restoreFrameFallback: (() => void) | null = null;

function createFrameFallback(): () => void {
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const shimIds = new Set<number>();
  let installed = false;

  const install = () => {
    if (installed || document.visibilityState !== "hidden") return;
    installed = true;
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      const id = window.setTimeout(() => {
        shimIds.delete(id);
        callback(performance.now());
      }, 32);
      shimIds.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id: number) => {
      if (shimIds.delete(id)) window.clearTimeout(id);
      else nativeCancel(id);
    };
  };

  const uninstall = () => {
    if (!installed) return;
    installed = false;
    window.requestAnimationFrame = nativeRaf;
    window.cancelAnimationFrame = nativeCancel;
  };

  install();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") install();
    else uninstall();
  };
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    uninstall();
  };
}

function acquireFrameFallback(): () => void {
  frameFallbackRefs += 1;
  restoreFrameFallback ??= createFrameFallback();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    frameFallbackRefs -= 1;
    if (frameFallbackRefs === 0) {
      restoreFrameFallback?.();
      restoreFrameFallback = null;
    }
  };
}

const SOLID_SOURCE = "mc-route-solid";
const DASHED_SOURCE = "mc-route-dashed";

type RouteFeature = {
  type: "Feature";
  properties: { color: string; opacity: number; width: number };
  geometry: { type: "LineString"; coordinates: [number, number][] };
};

type RouteCollection = {
  type: "FeatureCollection";
  features: RouteFeature[];
};

type MarkerRecord = {
  marker: Marker;
  el: HTMLDivElement;
  day: number;
  placeId: string;
  place: Place;
};

type CatalogMarkerRecord = {
  marker: Marker;
  el: HTMLDivElement;
  placeId: string;
};

export interface WalkPose {
  lng: number;
  lat: number;
  bearing?: number;
  moving?: boolean;
}

export interface WalkApi {
  setWalker(pose: WalkPose | null): void;
  setFollow(on: boolean): void;
  focusAt(lng: number, lat: number, zoom?: number): void;
}

export interface MapViewProps {
  hotel: Place;
  plan: PlanResult | null;
  activeDay: number | "all";
  focus: { placeId: string; nonce: number } | null;
  mode: "plan" | "browse";
  catalog: CatalogEntry[] | null;
  catalogLoading: boolean;
  selectedIds: string[];
  picking: boolean;
  loading: boolean;
  onPick: (lng: number, lat: number) => void;
  onExitPick: () => void;
  onStopClick: (day: number, placeId: string) => void;
  onToggleCatalog: (place: Place) => void;
  onWalkApi?: (api: WalkApi | null) => void;
}

const WALKER_MARKUP = `
<span class="mc-walker-halo" aria-hidden="true"></span>
<span class="mc-walker-label">阿漫</span>
<div class="mc-walker-figure" aria-hidden="true">
  <svg viewBox="0 0 64 84" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="32" cy="79.5" rx="14.5" ry="4.2" fill="rgba(28,23,16,0.2)"/>
    <g class="mc-walker-leg mc-walker-leg-back">
      <path d="M28 59 L26 72" stroke="#4a4034" stroke-width="7" stroke-linecap="round"/>
      <path d="M26 72 q-3.5 3.4 -6.5 3.4" stroke="#2c332c" stroke-width="5" stroke-linecap="round"/>
    </g>
    <g class="mc-walker-leg mc-walker-leg-front">
      <path d="M36 59 L39.5 72" stroke="#5a4f42" stroke-width="7" stroke-linecap="round"/>
      <path d="M39.5 72 q3.5 3.4 6.5 3.4" stroke="#333a33" stroke-width="5" stroke-linecap="round"/>
    </g>
    <g class="mc-walker-body">
      <rect x="12.5" y="37" width="13" height="20" rx="6.5" fill="#b5793f"/>
      <rect x="15.5" y="43" width="7" height="3" rx="1.5" fill="#8a5a2c"/>
      <path d="M23 38.5 Q32 32.5 41 38.5 L43 59 Q32 65 21 59 Z" fill="#c15a36"/>
      <path d="M23.5 35.5 Q32 32 40.5 35.5 L40.5 39.5 Q32 36.5 23.5 39.5 Z" fill="#f1d9a8"/>
      <path d="M23.5 41 L18.5 53" stroke="#a34a28" stroke-width="6" stroke-linecap="round"/>
      <path d="M41.5 41 L47 30.5" stroke="#c15a36" stroke-width="6" stroke-linecap="round"/>
      <circle cx="47.6" cy="28.8" r="3" fill="#f0cfa9"/>
      <circle cx="32" cy="24.5" r="10.5" fill="#f0cfa9"/>
      <path d="M21.8 21.5 Q23 12 32 12 Q41 12 42.2 21.5 Q37 18 32 18 Q27 18 21.8 21.5Z" fill="#3a433b"/>
      <path d="M20 21.5 H44" stroke="#2c332c" stroke-width="4" stroke-linecap="round"/>
      <circle cx="28.4" cy="26" r="1.3" fill="#2c332c"/>
      <circle cx="35.6" cy="26" r="1.3" fill="#2c332c"/>
      <path d="M29.7 29.9 Q32 31.5 34.3 29.9" stroke="#2c332c" stroke-width="1.2" stroke-linecap="round"/>
    </g>
  </svg>
</div>`;

const ROUTE_COLOR: ExpressionSpecification = ["get", "color"];
const ROUTE_OPACITY: ExpressionSpecification = ["get", "opacity"];
const ROUTE_WIDTH: ExpressionSpecification = ["get", "width"];
const CASING_WIDTH: ExpressionSpecification = [
  "+",
  ["get", "width"],
  3.4,
];
const CASING_OPACITY: ExpressionSpecification = [
  "*",
  ["get", "opacity"],
  0.92,
];

function emptyCollection(): RouteCollection {
  return { type: "FeatureCollection", features: [] };
}

function addRouteLayers(map: MapLibreMap) {
  map.addSource(SOLID_SOURCE, { type: "geojson", data: emptyCollection() });
  map.addSource(DASHED_SOURCE, { type: "geojson", data: emptyCollection() });

  for (const source of [SOLID_SOURCE, DASHED_SOURCE]) {
    const dashed = source === DASHED_SOURCE;
    map.addLayer({
      id: `${source}-casing`,
      type: "line",
      source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#fffdf8",
        "line-width": CASING_WIDTH,
        "line-opacity": CASING_OPACITY,
      },
    });
    map.addLayer({
      id: `${source}-line`,
      type: "line",
      source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ROUTE_COLOR,
        "line-width": ROUTE_WIDTH,
        "line-opacity": ROUTE_OPACITY,
        ...(dashed ? { "line-dasharray": [2.2, 1.9] } : {}),
      },
    });
  }
}

function setRouteData(
  map: MapLibreMap,
  sourceId: string,
  data: RouteCollection,
) {
  const source = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (!source) return;
  source.setData(
    data as unknown as Parameters<GeoJSONSource["setData"]>[0],
  );
}

export default function MapView({
  hotel,
  plan,
  activeDay,
  focus,
  mode,
  catalog,
  catalogLoading,
  selectedIds,
  picking,
  loading,
  onPick,
  onExitPick,
  onStopClick,
  onToggleCatalog,
  onWalkApi,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const markersRef = useRef<MarkerRecord[]>([]);
  const catalogMarkersRef = useRef<CatalogMarkerRecord[]>([]);
  const hotelMarkerRef = useRef<Marker | null>(null);
  const walkerRef = useRef<{ marker: Marker; el: HTMLDivElement } | null>(null);
  const followRef = useRef(true);
  const onPickRef = useRef(onPick);
  const onStopClickRef = useRef(onStopClick);
  const onToggleCatalogRef = useRef(onToggleCatalog);
  const selectedIdsRef = useRef(selectedIds);
  const [ready, setReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [basemapWarning, setBasemapWarning] = useState(false);
  const [mapEpoch, setMapEpoch] = useState(0);

  const retryMap = useCallback(() => {
    setMapFailed(false);
    setBasemapWarning(false);
    setReady(false);
    setMapEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    onPickRef.current = onPick;
    onStopClickRef.current = onStopClick;
    onToggleCatalogRef.current = onToggleCatalog;
  }, [onPick, onStopClick, onToggleCatalog]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
    for (const record of catalogMarkersRef.current) {
      record.el.classList.toggle(
        "is-selected",
        selectedIds.includes(record.placeId),
      );
    }
  }, [selectedIds]);

  const showPopup = useCallback(
    (place: Place, meta: string, note?: string, tag?: string) => {
      const map = mapRef.current;
      const popup = popupRef.current;
      if (!map || !popup) return;
      const root = document.createElement("div");
      root.className = "mc-popup";
      const title = document.createElement("h4");
      title.textContent = place.name;
      root.appendChild(title);
      const metaLine = document.createElement("p");
      metaLine.className = "mc-popup-meta";
      metaLine.textContent = meta;
      root.appendChild(metaLine);
      if (note) {
        const noteLine = document.createElement("p");
        noteLine.className = "mc-popup-note";
        noteLine.textContent = note;
        root.appendChild(noteLine);
      }
      if (tag) {
        const tagEl = document.createElement("span");
        tagEl.className = "mc-popup-tag";
        tagEl.textContent = tag;
        root.appendChild(tagEl);
      }
      popup.setLngLat(toMapPoint(place.lng, place.lat)).setDOMContent(root).addTo(map);
    },
    [],
  );

  const showCatalogPopup = useCallback((entry: CatalogEntry) => {
    const map = mapRef.current;
    const popup = popupRef.current;
    if (!map || !popup) return;
    const root = document.createElement("div");
    root.className = "mc-popup";
    const title = document.createElement("h4");
    title.textContent = entry.place.name;
    root.appendChild(title);
    const metaLine = document.createElement("p");
    metaLine.className = "mc-popup-meta";
    metaLine.textContent = `${TIER_BY_ID[entry.tier].label} · ${
      CATALOG_THEME_LABELS[entry.theme]
    } · 人气 ${entry.popularity.toFixed(1)}`;
    root.appendChild(metaLine);
    const noteLine = document.createElement("p");
    noteLine.className = "mc-popup-note";
    noteLine.textContent = entry.intro;
    root.appendChild(noteLine);
    if (entry.tags.length) {
      const tagRow = document.createElement("div");
      tagRow.className = "mc-popup-tags";
      for (const tag of entry.tags) {
        const tagEl = document.createElement("span");
        tagEl.className = "mc-popup-tag";
        tagEl.textContent = tag;
        tagRow.appendChild(tagEl);
      }
      root.appendChild(tagRow);
    }
    const action = document.createElement("button");
    action.type = "button";
    action.className = "mc-popup-action";
    let added = selectedIdsRef.current.includes(entry.place.id);
    const sync = () => {
      action.textContent = added ? "已加入行程 · 点击移除" : "加入行程";
      action.classList.toggle("is-added", added);
    };
    sync();
    action.addEventListener("click", (event) => {
      event.stopPropagation();
      added = !added;
      sync();
      onToggleCatalogRef.current(entry.place);
    });
    root.appendChild(action);
    popup
      .setLngLat(toMapPoint(entry.place.lng, entry.place.lat))
      .setDOMContent(root)
      .addTo(map);
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const releaseFrames = acquireFrameFallback();
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: {
            basemap: {
              type: "raster",
              tiles: TILE_URLS,
              tileSize: 256,
              maxzoom: 18,
              attribution:
                '&copy; <a href="https://www.amap.com/" target="_blank" rel="noreferrer">高德地图</a>',
            },
          },
          layers: [
            {
              id: "basemap-layer",
              type: "raster",
              source: "basemap",
              paint: {
                "raster-saturation": -0.08,
                "raster-brightness-min": 0.04,
                "raster-brightness-max": 0.98,
              },
            },
          ],
        },
        center: toMapPoint(hotel.lng, hotel.lat),
        zoom: 12.4,
        minZoom: 3,
        maxZoom: 18.5,
        pitchWithRotate: false,
        dragRotate: false,
        attributionControl: false,
      });
    } catch (error) {
      console.error("[map] failed to initialize", error);
      releaseFrames();
      setMapFailed(true);
      return;
    }
    mapRef.current = map;
    popupRef.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: true,
      offset: 22,
      maxWidth: "260px",
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      "bottom-right",
    );

    const styleTimer = window.setTimeout(() => {
      if (!map.isStyleLoaded()) setMapFailed(true);
    }, 9000);
    let tilesLoaded = false;
    const tileTimer = window.setTimeout(() => {
      if (!tilesLoaded) setBasemapWarning(true);
    }, 7000);

    map.on("data", (event) => {
      const sourceEvent = event as unknown as {
        sourceId?: string;
        isSourceLoaded?: boolean;
      };
      if (sourceEvent.sourceId === "basemap" && sourceEvent.isSourceLoaded) {
        tilesLoaded = true;
        window.clearTimeout(tileTimer);
        setBasemapWarning(false);
      }
    });

    map.once("style.load", () => {
      window.clearTimeout(styleTimer);
      addRouteLayers(map);
      setReady(true);
      // 隐藏页里的样式加载可能晚于看门狗；真正加载成功后要撤掉失败提示。
      setMapFailed(false);
    });
    map.on("webglcontextlost", () => setMapFailed(true));
    map.on("webglcontextrestored", () => setMapFailed(false));

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      window.clearTimeout(styleTimer);
      window.clearTimeout(tileTimer);
      observer.disconnect();
      markersRef.current.forEach((record) => record.marker.remove());
      markersRef.current = [];
      catalogMarkersRef.current.forEach((record) => record.marker.remove());
      catalogMarkersRef.current = [];
      hotelMarkerRef.current?.remove();
      hotelMarkerRef.current = null;
      walkerRef.current?.marker.remove();
      walkerRef.current = null;
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
      releaseFrames();
    };
    // 地图实例只在城市/重试变化时重建；hotel 只是初始镜头中心。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapEpoch]);

  useEffect(() => {
    if (!ready) return;
    const map = mapRef.current;
    if (!map) return;

    const api: WalkApi = {
      setWalker(pose) {
        if (!pose) {
          walkerRef.current?.marker.remove();
          walkerRef.current = null;
          return;
        }
        const point = toMapPoint(pose.lng, pose.lat);
        let record = walkerRef.current;
        if (!record) {
          const el = document.createElement("div");
          el.className = "mc-walker";
          el.innerHTML = WALKER_MARKUP;
          const marker = new maplibregl.Marker({
            element: el,
            anchor: "bottom",
            offset: [0, 4],
          })
            .setLngLat(point)
            .addTo(map);
          record = { marker, el };
          walkerRef.current = record;
        }
        record.marker.setLngLat(point);
        const bearing = pose.bearing ?? 90;
        record.el.dataset.dir =
          bearing > 120 && bearing < 300 ? "left" : "right";
        record.el.classList.toggle("is-moving", Boolean(pose.moving));

        if (followRef.current) {
          const projected = map.project(point);
          const width = map.getContainer().clientWidth;
          const height = map.getContainer().clientHeight;
          const padX = Math.max(110, width * 0.26);
          const padY = Math.max(96, height * 0.24);
          if (
            projected.x < padX ||
            projected.x > width - padX ||
            projected.y < padY ||
            projected.y > height - padY
          ) {
            map.easeTo({ center: point, duration: 520, easing: (t) => t });
          }
        }
      },
      setFollow(on) {
        followRef.current = on;
      },
      focusAt(lng, lat, zoom) {
        map.easeTo({
          center: toMapPoint(lng, lat),
          zoom: zoom ?? Math.max(map.getZoom(), 14.6),
          duration: 760,
        });
      },
    };

    onWalkApi?.(api);

    const stopFollow = () => {
      followRef.current = false;
    };
    map.on("dragstart", stopFollow);

    return () => {
      map.off("dragstart", stopFollow);
      onWalkApi?.(null);
      walkerRef.current?.marker.remove();
      walkerRef.current = null;
    };
  }, [ready, onWalkApi]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markersRef.current.forEach((record) => record.marker.remove());
    markersRef.current = [];
    if (mode !== "plan" || !plan) return;

    for (const day of plan.days) {
      day.stops.forEach((stop, index) => {
        if (stop.flexible) return;
        const el = document.createElement("div");
        el.className = `mc-stop${stop.kind === "sight" ? "" : " is-meal"}`;
        el.style.setProperty("--marker-color", day.color);
        el.style.setProperty("--marker-halo", `${day.color}2e`);
        if (activeDay !== "all" && day.index !== activeDay) {
          el.classList.add("is-dim");
        }
        if (focus && focus.placeId === stop.place.id) {
          el.classList.add("is-active");
        }

        const dot = document.createElement("div");
        dot.className = "mc-stop-dot";
        const number = document.createElement("span");
        number.textContent = String(index + 1);
        dot.appendChild(number);

        const label = document.createElement("div");
        label.className = "mc-stop-label";
        label.textContent = stop.place.name;

        el.append(dot, label);
        el.addEventListener("click", (event) => {
          event.stopPropagation();
          onStopClickRef.current(day.index, stop.place.id);
        });

        const marker = new maplibregl.Marker({ element: el, anchor: "center" })
          .setLngLat(toMapPoint(stop.place.lng, stop.place.lat))
          .addTo(map);

        markersRef.current.push({
          marker,
          el,
          day: day.index,
          placeId: stop.place.id,
          place: stop.place,
        });
      });
    }
  }, [plan, ready, activeDay, focus, mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    catalogMarkersRef.current.forEach((record) => record.marker.remove());
    catalogMarkersRef.current = [];
    if (mode !== "browse" || !catalog?.length) return;

    for (const entry of catalog) {
      const el = document.createElement("div");
      el.className = "mc-cat";
      el.dataset.tier = entry.tier;
      el.style.setProperty("--cat-color", CATALOG_THEME_COLORS[entry.theme]);
      if (selectedIdsRef.current.includes(entry.place.id)) {
        el.classList.add("is-selected");
      }

      const dot = document.createElement("div");
      dot.className = "mc-cat-dot";
      if (entry.tier === "icon") dot.textContent = "★";

      const label = document.createElement("div");
      label.className = "mc-cat-label";
      label.textContent = entry.place.name;

      el.append(dot, label);
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        showCatalogPopup(entry);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat(toMapPoint(entry.place.lng, entry.place.lat))
        .addTo(map);

      catalogMarkersRef.current.push({
        marker,
        el,
        placeId: entry.place.id,
      });
    }
  }, [catalog, ready, mode, showCatalogPopup]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const solid = emptyCollection();
    const dashed = emptyCollection();

    if (mode === "plan" && plan) {
      for (const day of plan.days) {
        const isDim = activeDay !== "all" && day.index !== activeDay;
        for (const leg of day.legs) {
          if (leg.distanceKm <= 0.06 && leg.durationMin <= 2) continue;
          const rawCoordinates =
            leg.geometry.length >= 2
              ? leg.geometry
              : [leg.from, leg.to];
          const coordinates = convertWgsPolylineToGcj(rawCoordinates);
          const feature: RouteFeature = {
            type: "Feature",
            properties: {
              color: day.color,
              opacity: isDim ? 0.16 : 0.92,
              width: isDim ? 2 : 3.4,
            },
            geometry: { type: "LineString", coordinates },
          };
          (leg.estimated ? dashed : solid).features.push(feature);
        }
      }
    }

    setRouteData(map, SOLID_SOURCE, solid);
    setRouteData(map, DASHED_SOURCE, dashed);
  }, [plan, activeDay, ready, mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (focus) return;

    const coordinates: [number, number][] = [
      toMapPoint(hotel.lng, hotel.lat),
    ];
    if (mode === "browse") {
      for (const entry of catalog ?? []) {
        coordinates.push(toMapPoint(entry.place.lng, entry.place.lat));
      }
    } else if (plan) {
      for (const day of plan.days) {
        if (activeDay !== "all" && day.index !== activeDay) continue;
        for (const stop of day.stops) {
          coordinates.push(toMapPoint(stop.place.lng, stop.place.lat));
        }
      }
    }

    if (coordinates.length === 1) {
      map.flyTo({
        center: coordinates[0],
        zoom: Math.max(map.getZoom(), 12.6),
        duration: 900,
      });
      return;
    }

    const bounds = new maplibregl.LngLatBounds(coordinates[0], coordinates[0]);
    for (const coordinate of coordinates.slice(1)) bounds.extend(coordinate);
    map.fitBounds(bounds, {
      padding: { top: 72, bottom: 84, left: 56, right: 56 },
      maxZoom: 15,
      duration: 900,
    });
  }, [plan, activeDay, ready, hotel, focus, mode, catalog]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (picking) {
      map.getCanvas().style.cursor = "crosshair";
    } else {
      map.getCanvas().style.cursor = "";
      return;
    }
    const handler = (event: MapMouseEvent) => {
      const [lng, lat] = gcj02ToWgs84(
        event.lngLat.lng,
        event.lngLat.lat,
      );
      onPickRef.current(lng, lat);
    };
    map.on("click", handler);
    return () => {
      map.off("click", handler);
      map.getCanvas().style.cursor = "";
    };
  }, [picking, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    markersRef.current.forEach((record) => {
      record.el.classList.toggle(
        "is-active",
        Boolean(focus && record.placeId === focus.placeId),
      );
    });

    if (!focus) return;
    if (mode === "browse") {
      const entry = catalog?.find(
        (candidate) => candidate.place.id === focus.placeId,
      );
      if (!entry) return;
      map.flyTo({
        center: toMapPoint(entry.place.lng, entry.place.lat),
        zoom: Math.max(map.getZoom(), 14.4),
        duration: 850,
        offset: [0, -36],
      });
      showCatalogPopup(entry);
      return;
    }
    if (!plan) return;
    let found:
      | { dayIndex: number; stop: PlanResult["days"][number]["stops"][number] }
      | null = null;
    for (const day of plan.days) {
      const stop = day.stops.find(
        (candidate) => candidate.place.id === focus.placeId,
      );
      if (stop) {
        found = { dayIndex: day.index, stop };
        break;
      }
    }
    if (!found) return;

    map.flyTo({
      center: toMapPoint(found.stop.place.lng, found.stop.place.lat),
      zoom: Math.max(map.getZoom(), 14.4),
      duration: 850,
      offset: [0, -36],
    });
    showPopup(
      found.stop.place,
      `Day ${found.dayIndex} · ${
        found.stop.flexible
          ? "用餐时段"
          : CATEGORY_LABELS[found.stop.place.category]
      } · ${clockRange(found.stop.startMin, found.stop.endMin)}`,
      found.stop.place.note,
      found.stop.flexible
        ? found.stop.slot === "lunch"
          ? "午餐 · 现场选"
          : "晚餐 · 现场选"
        : found.stop.kind === "meal"
          ? "吃饭"
          : found.stop.kind === "cafe"
            ? "咖啡 / 茶歇"
            : "停留点",
    );
  }, [focus, plan, ready, showPopup, mode, catalog, showCatalogPopup]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    hotelMarkerRef.current?.remove();
    hotelMarkerRef.current = null;

    const el = document.createElement("div");
    el.className = "mc-hotel";
    const halo = document.createElement("span");
    halo.className = "mc-hotel-halo";
    const pin = document.createElement("span");
    pin.className = "mc-hotel-pin";
    pin.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9.5 21v-6h5v6"/></svg>';
    const label = document.createElement("span");
    label.className = "mc-hotel-label";
    label.textContent = hotel.name;
    el.append(halo, pin, label);
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      showPopup(
        hotel,
        hotel.address ?? "此行的落脚点",
        hotel.note ?? "每天从这里出发，也回到这里。",
        hotel.cost ? `参考房价 ¥${Math.round(hotel.cost)} / 晚` : "酒店",
      );
    });

    const marker = new maplibregl.Marker({ element: el, anchor: "center" })
      .setLngLat(toMapPoint(hotel.lng, hotel.lat))
      .addTo(map);
    hotelMarkerRef.current = marker;

    return () => {
      marker.remove();
      if (hotelMarkerRef.current === marker) hotelMarkerRef.current = null;
    };
  }, [hotel, ready, showPopup]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[26px] border border-line/70 bg-paper-deep shadow-soft">
      <div className="absolute inset-0">
        <div
          ref={containerRef}
          className={`mc-map h-full w-full${picking ? " picking" : ""}`}
          aria-label={mode === "browse" ? "景点地图" : "行程地图"}
        />
      </div>

      {mapFailed ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper/85 p-6 text-center backdrop-blur-sm">
          <div className="max-w-xs space-y-2.5">
            <p className="font-serif text-base text-ink">地图暂时没有加载出来</p>
            <p className="text-[13px] leading-relaxed text-ink-soft">
              预览窗口、后台页面或浏览器设置都可能拦住地图渲染。点下面重新加载；行程、时间和预算不受影响。
            </p>
            <button
              type="button"
              onClick={retryMap}
              className="rounded-full border border-line bg-card px-4 py-1.5 text-[12px] text-ink transition hover:border-ink/30"
            >
              重新加载地图
            </button>
          </div>
        </div>
      ) : null}

      {!ready && !mapFailed ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-paper/60">
          <div className="flex items-center gap-2.5 rounded-full border border-white/60 bg-card/85 px-4 py-2.5 text-[13px] text-ink-soft shadow-lift backdrop-blur">
            <Spinner className="text-accent" />
            正在铺开地图
          </div>
        </div>
      ) : null}

      {basemapWarning && !mapFailed ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-white/60 bg-card/92 px-3 py-1.5 text-[10px] text-amber shadow-lift backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-amber" />
          底图瓦片加载较慢，点位与路线仍可查看
        </div>
      ) : null}

      {loading && mode === "plan" ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-paper/25 backdrop-blur-[1.5px]">
          <div className="flex items-center gap-2.5 rounded-full border border-white/60 bg-card/92 px-4 py-2.5 text-[13px] text-ink-soft shadow-lift">
            <Spinner className="text-accent" />
            正在把点连成一条顺路的线…
          </div>
        </div>
      ) : null}

      {catalogLoading && mode === "browse" ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-paper/25 backdrop-blur-[1.5px]">
          <div className="flex items-center gap-2.5 rounded-full border border-white/60 bg-card/92 px-4 py-2.5 text-[13px] text-ink-soft shadow-lift">
            <Spinner className="text-accent" />
            正在把全城景点铺到地图上…
          </div>
        </div>
      ) : null}

      {picking ? (
        <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2">
          <div className="flex items-center gap-2.5 rounded-full border border-white/60 bg-card/95 py-1.5 pl-4 pr-1.5 text-[13px] text-ink shadow-lift backdrop-blur">
            <span className="h-2 w-2 animate-soft-pulse rounded-full bg-accent" />
            在地图上点一下酒店位置
            <button
              type="button"
              onClick={onExitPick}
              className="rounded-full bg-ink px-3 py-1.5 text-[12px] text-paper transition hover:bg-ink/85"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-2 left-2 z-10 max-w-[calc(100%-1rem)] rounded-xl border border-white/60 bg-card/90 px-3 py-2 text-[10.5px] leading-relaxed text-ink-soft shadow-lift backdrop-blur">
        {mode === "browse" ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1">
                <span className="h-2.5 w-2.5 rounded-full bg-ink" />
                城市名片
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-ink/75" />
                热门必去
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-ink/55" />
                口碑不错
              </span>
              <span className="flex items-center gap-1">
                <span className="h-1 w-1 rounded-full bg-ink/40" />
                小众顺路
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-ink ring-2 ring-ink/25" />
                已选
              </span>
            </div>
            <p className="mt-1 text-[10px] text-ink-faint">
              颜色 = 主题 · 大小 = 热度 · 共 {catalog?.length ?? 0} 个景点
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-accent" />
                停留
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rotate-45 rounded-[2px] bg-accent" />
                吃饭
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-jade ring-2 ring-jade/15" />
                酒店
              </span>
              <span className="flex items-center gap-1">
                <span className="h-[2px] w-4 rounded bg-ink/45" />
                路线
              </span>
            </div>
            <p className="mt-1 text-[10px] text-ink-faint">实线 = 真实路径 · 虚线 = 估算</p>
          </>
        )}
      </div>
    </div>
  );
}
