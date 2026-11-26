/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import { CATEGORY_ICONS, CATEGORY_LABELS } from "@/lib/constants";
import type { Category } from "@/lib/types";
import { Icon } from "./Icon";
import { cn } from "./ui";

interface PhotoInfo {
  url: string;
  source: string;
  sourceUrl?: string;
  author?: string;
  license?: string;
}

const photoCache = new Map<string, PhotoInfo | null>();
const photoPending = new Map<string, Promise<PhotoInfo | null>>();

function loadPhoto(key: string, params: URLSearchParams): Promise<PhotoInfo | null> {
  if (photoCache.has(key)) return Promise.resolve(photoCache.get(key) ?? null);
  const inflight = photoPending.get(key);
  if (inflight) return inflight;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9_000);
  const promise = fetch(`/api/photo?${params.toString()}`, {
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) return null;
      const data = (await response.json()) as { photo?: PhotoInfo | null };
      return data.photo ?? null;
    })
    .catch(() => null)
    .then((photo) => {
      photoCache.set(key, photo);
      photoPending.delete(key);
      return photo;
    })
    .finally(() => clearTimeout(timer));
  photoPending.set(key, promise);
  return promise;
}

const TINTS = [
  { bg: "#ecefe4", ink: "#5a6a4f", glow: "#d9e1c9" },
  { bg: "#f3ecdd", ink: "#8a6a3f", glow: "#e7d7b7" },
  { bg: "#e8ede8", ink: "#456553", glow: "#d0ddd2" },
  { bg: "#ece8e1", ink: "#6c6252", glow: "#ded5c6" },
];

function tintFor(name: string) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 997;
  }
  return TINTS[hash % TINTS.length];
}

export default function PlacePhoto({
  name,
  city,
  lat,
  lng,
  qid,
  image,
  commons,
  category,
  aspect = "aspect-[16/9]",
  className,
  priority = false,
  compact = false,
}: {
  name: string;
  city: string;
  lat?: number;
  lng?: number;
  qid?: string;
  image?: string;
  commons?: string;
  category: Category;
  aspect?: string;
  className?: string;
  priority?: boolean;
  compact?: boolean;
}) {
  const key = `${city}|${name}|${lat?.toFixed(4) ?? ""}|${lng?.toFixed(4) ?? ""}|${qid ?? ""}|${image ?? ""}|${commons ?? ""}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(priority);
  const [photo, setPhoto] = useState<PhotoInfo | null>(() => photoCache.get(key) ?? null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (priority || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const node = containerRef.current;
    if (!node) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [key, priority]);

  useEffect(() => {
    setFailed(false);
    setLoaded(false);
    const cached = photoCache.get(key);
    setPhoto(cached ?? null);
    if (!visible || cached !== undefined) return;

    let cancelled = false;
    const params = new URLSearchParams({ name, city });
    if (lat !== undefined) params.set("lat", String(lat));
    if (lng !== undefined) params.set("lng", String(lng));
    if (qid) params.set("qid", qid);
    if (image) params.set("image", image);
    if (commons) params.set("commons", commons);
    void loadPhoto(key, params).then((next) => {
      if (!cancelled) setPhoto(next);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, key, name, city, lat, lng, qid, image, commons]);

  useEffect(() => {
    // 图片可能在上面的 onLoad 绑定前就已缓存命中，补一次完成态检查。
    if (imageRef.current?.complete) setLoaded(true);
  }, [photo]);

  const tint = tintFor(name);
  const showImage = Boolean(photo?.url) && !failed;
  const credit = photo?.author
    ? `${photo.author}${photo.license ? ` · ${photo.license}` : ""}`
    : photo?.license;

  return (
    <div
      ref={containerRef}
      className={cn("relative overflow-hidden bg-paper-deep", aspect, className)}
    >
      <div className="absolute inset-0" aria-hidden="true">
        <div className="h-full w-full" style={{ backgroundColor: tint.bg }}>
          <div
            className="h-full w-full opacity-70"
            style={{
              backgroundImage: `radial-gradient(circle at 18% 22%, ${tint.glow} 0, transparent 46%), radial-gradient(circle at 82% 74%, ${tint.glow} 0, transparent 42%)`,
            }}
          />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span
              className={cn(
                "font-serif leading-none",
                compact ? "text-[20px]" : "text-[38px]",
              )}
              style={{ color: tint.ink, opacity: 0.5 }}
            >
              {name.slice(0, 1)}
            </span>
            {compact ? null : (
              <span
                className="mt-2 text-micro tracking-[0.3em]"
                style={{ color: tint.ink, opacity: 0.6 }}
              >
                MANCHENG
              </span>
            )}
          </div>
          {compact ? null : (
            <span
              className="absolute bottom-2.5 left-3 inline-flex items-center gap-1 text-[10px]"
              style={{ color: tint.ink, opacity: 0.8 }}
            >
              <Icon name={CATEGORY_ICONS[category]} size={10} />
              {CATEGORY_LABELS[category]}
            </span>
          )}
        </div>
      </div>

      {showImage ? (
        <img
          ref={imageRef}
          src={photo!.url}
          alt={name}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition duration-700",
            loaded ? "scale-100 opacity-100" : "scale-[1.03] opacity-0",
          )}
        />
      ) : null}

      {showImage && photo?.source ? (
        <a
          href={photo.sourceUrl ?? "#"}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => event.stopPropagation()}
          title={credit ? `${photo.source} · ${credit}` : photo.source}
          className="absolute bottom-2 right-2 rounded-full bg-ink/60 px-2 py-1 text-micro text-paper/95 backdrop-blur-sm transition hover:bg-ink/80"
        >
          {photo.source}
        </a>
      ) : null}
    </div>
  );
}