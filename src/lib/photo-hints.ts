import { CURATED_PHOTOS } from "../content/place-photos";

// 客户端也会引用这份判断，不能把 photos.ts 的 node:https 缓存层拖进浏览器包。
const curatedKeys = new Set(
  CURATED_PHOTOS.map((item) => `${item.city.trim()}|${item.name.trim()}`),
);

const WIKI_MEDIA_HOSTS = new Set([
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
]);

/** 只判断“现在就有明确可用的图”，不触发 Wikidata/Commons 搜索。 */
export function hasDirectPhoto(
  name: string,
  city: string,
  input: { image?: string; commons?: string } = {},
): boolean {
  if (curatedKeys.has(`${city.trim()}|${name.trim()}`)) return true;
  const raw = [input.image, input.commons].find((value) => value?.trim());
  if (!raw) return false;
  const value = raw.trim();
  if (/^File:/i.test(value)) return true;
  if (/^Category:/i.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (WIKI_MEDIA_HOSTS.has(host)) return true;
    return (
      host === "commons.wikimedia.org" &&
      /\/wiki\/File:/i.test(decodeURIComponent(url.pathname))
    );
  } catch {
    return false;
  }
}