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

export interface MapViewProps {
  hotel: Place;
  plan: PlanResult | null;
  activeDay: number | "all";
  focus: { placeId: string; nonce: number } | null;
  picking: boolean;
  loading: boolean;
  onPick: (lng: number, lat: number) => void;
  onExitPick: () => void;
  onStopClick: (day: number, placeId: string) => void;
}

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
  picking,
  loading,
  onPick,
  onExitPick,
  onStopClick,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const markersRef = useRef<MarkerRecord[]>([]);
  const hotelMarkerRef = useRef<Marker | null>(null);
  const onPickRef = useRef(onPick);
  const onStopClickRef = useRef(onStopClick);
  const [ready, setReady] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [basemapWarning, setBasemapWarning] = useState(false);

  useEffect(() => {
    onPickRef.current = onPick;
    onStopClickRef.current = onStopClick;
  }, [onPick, onStopClick]);

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

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
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
    });
    map.on("webglcontextlost", () => setMapFailed(true));

    const observer = new ResizeObserver(() => map.resize());
    observer.observe(containerRef.current);

    return () => {
      window.clearTimeout(styleTimer);
      window.clearTimeout(tileTimer);
      observer.disconnect();
      markersRef.current.forEach((record) => record.marker.remove());
      markersRef.current = [];
      hotelMarkerRef.current?.remove();
      hotelMarkerRef.current = null;
      popupRef.current?.remove();
      map.remove();
      mapRef.current = null;
    };
    // Map instance is created once; hotel is only the initial camera target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markersRef.current.forEach((record) => record.marker.remove());
    markersRef.current = [];
    if (!plan) return;

    for (const day of plan.days) {
      day.stops.forEach((stop, index) => {
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
  }, [plan, ready, activeDay, focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const solid = emptyCollection();
    const dashed = emptyCollection();

    if (plan) {
      for (const day of plan.days) {
        const isDim = activeDay !== "all" && day.index !== activeDay;
        for (const leg of day.legs) {
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
  }, [plan, activeDay, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    if (focus) return;

    const coordinates: [number, number][] = [
      toMapPoint(hotel.lng, hotel.lat),
    ];
    if (plan) {
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
  }, [plan, activeDay, ready, hotel, focus]);

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

    if (!focus || !plan) return;
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
      `Day ${found.dayIndex} · ${CATEGORY_LABELS[found.stop.place.category]} · ${clockRange(
        found.stop.startMin,
        found.stop.endMin,
      )}`,
      found.stop.place.note,
      found.stop.kind === "meal"
        ? "吃饭"
        : found.stop.kind === "cafe"
          ? "咖啡 / 茶歇"
          : "停留点",
    );
  }, [focus, plan, ready, showPopup]);

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
          aria-label="行程地图"
        />
      </div>

      {mapFailed ? (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-paper/85 p-6 text-center backdrop-blur-sm">
          <div className="max-w-xs space-y-2">
            <p className="font-serif text-base text-ink">地图暂时没有加载出来</p>
            <p className="text-[12px] leading-relaxed text-ink-soft">
              可能是网络或浏览器禁用了 WebGL。行程、时间和预算仍可在下方查看。
            </p>
          </div>
        </div>
      ) : null}

      {!ready && !mapFailed ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-paper/60">
          <div className="flex items-center gap-2.5 rounded-full border border-white/60 bg-card/85 px-4 py-2 text-[12px] text-ink-soft shadow-lift backdrop-blur">
            <Spinner className="text-accent" />
            正在铺开地图
          </div>
        </div>
      ) : null}

      {basemapWarning && !mapFailed ? (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-full border border-white/60 bg-card/92 px-2.5 py-1 text-[9px] text-amber shadow-lift backdrop-blur">
          <span className="h-1.5 w-1.5 rounded-full bg-amber" />
          底图瓦片加载较慢，点位与路线仍可查看
        </div>
      ) : null}

      {loading ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-paper/25 backdrop-blur-[1.5px]">
          <div className="flex items-center gap-2.5 rounded-full border border-white/60 bg-card/92 px-4 py-2.5 text-[12px] text-ink-soft shadow-lift">
            <Spinner className="text-accent" />
            正在把点连成一条顺路的线…
          </div>
        </div>
      ) : null}

      {picking ? (
        <div className="absolute left-1/2 top-4 z-30 -translate-x-1/2">
          <div className="flex items-center gap-2.5 rounded-full border border-white/60 bg-card/95 py-1.5 pl-3.5 pr-1.5 text-[12px] text-ink shadow-lift backdrop-blur">
            <span className="h-2 w-2 animate-soft-pulse rounded-full bg-accent" />
            在地图上点一下酒店位置
            <button
              type="button"
              onClick={onExitPick}
              className="rounded-full bg-ink px-2.5 py-1 text-[11px] text-paper transition hover:bg-ink/85"
            >
              取消
            </button>
          </div>
        </div>
      ) : null}

      <div className="pointer-events-none absolute bottom-2 left-2 z-10 rounded-xl border border-white/60 bg-card/88 px-2.5 py-1.5 text-[9px] leading-relaxed text-ink-soft shadow-lift backdrop-blur">
        <div className="flex items-center gap-2.5">
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
        <p className="mt-0.5 text-ink-faint">实线 = 真实路径 · 虚线 = 估算</p>
      </div>
    </div>
  );
}
