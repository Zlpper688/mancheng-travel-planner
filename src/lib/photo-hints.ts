import { CURATED_PHOTOS } from "../content/place-photos";
import {
  LOCAL_PLACE_PHOTOS,
  type LocalPlacePhoto,
} from "../content/place-photos.generated";

// 客户端也会引用这份判断，不能把 photos.ts 的 node:https 缓存层拖进浏览器包。
const curatedKeys = new Set(
  CURATED_PHOTOS.map((item) => `${item.city.trim()}|${item.name.trim()}`),
);

const WIKI_MEDIA_HOSTS = new Set([
  "upload.wikimedia.org",
  "thumb.wikimedia.org",
]);

const LOCAL_SUFFIX =
  /(观景平台|观景台|步行街|商业街|海鲜排档|咖啡街区|老字号小吃|岛上小吃|小吃街|码头)$/;

/** 本地静态图库按「城市|景点名」直接命中，无需联网。 */
export function localPhotoFor(
  name: string,
  city: string,
): LocalPlacePhoto | null {
  const cleanCity = city.trim();
  const cleanName = name.trim();
  const direct = LOCAL_PLACE_PHOTOS[`${cleanCity}|${cleanName}`];
  if (direct) return direct;
  const bare = cleanName.replace(LOCAL_SUFFIX, "").trim();
  return bare && bare !== cleanName
    ? LOCAL_PLACE_PHOTOS[`${cleanCity}|${bare}`] ?? null
    : null;
}

/** 只判断“现在就有明确可用的图”，不触发 Wikidata/Commons 搜索。 */
export function hasDirectPhoto(
  name: string,
  city: string,
  input: { image?: string; commons?: string } = {},
): boolean {
  if (localPhotoFor(name, city)) return true;
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