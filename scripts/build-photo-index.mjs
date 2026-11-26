/**
 * 为 1012 个已核实景点建立「本地实景图库 + 静态索引」。
 *
 * 图源优先级：
 *   1) 已人工核对的维基共享资源图（src/content/place-photos.ts，许可清晰）
 *   2) 搜狗图片搜索里标题命中景点名、来源可信的实景图
 * 图片下载到本地 public/photos/（960px 内、JPEG q78），演示时零外网依赖。
 * 索引记录原图页面 URL，界面可追溯出处。
 *
 * 断点续跑：进度写在 .tmp/photo-build-progress.json，失败项下次自动重试。
 * 跑法：node scripts/build-photo-index.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

const ROOT = process.cwd();
const ENRICH_DIR = path.join(ROOT, "data", "knowledge", "enrichment");
const PHOTO_DIR = path.join(ROOT, "public", "photos");
const INDEX_FILE = path.join(ROOT, "data", "photo-index.json");
const GENERATED_FILE = path.join(
  ROOT,
  "src",
  "content",
  "place-photos.generated.ts",
);
const PROGRESS_FILE = path.join(ROOT, ".tmp", "photo-build-progress.json");
const CURATED_FILE = path.join(ROOT, "src", "content", "place-photos.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PLACE_SUFFIX =
  /(观景平台|观景台|步行街|商业街|海鲜排档|咖啡街区|老字号小吃|岛上小吃|小吃街|码头)$/;

fs.mkdirSync(PHOTO_DIR, { recursive: true });
fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });

const progress = fs.existsSync(PROGRESS_FILE)
  ? JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"))
  : {};
let progressDirty = false;
function saveProgress() {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
  progressDirty = false;
}

function extractArray(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const bracket = text.indexOf("[", start);
  if (bracket < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = bracket; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(bracket, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function scoreCandidate(item, name, city) {
  const title = item.title || "";
  const core = name.replace(PLACE_SUFFIX, "").trim();
  let score = 0;
  if (title.includes(name)) score += 4;
  else if (core.length >= 2 && title.includes(core)) score += 2;
  if (city && title.includes(city)) score += 1;
  const host = hostOf(item.ori || item.thumb);
  if (/ctrip|qunar|mafengwo|wikimedia|gov\.cn|baike\.baidu|tuchong/.test(host)) score += 4;
  if (/douyin|weibo|xiaohongshu/.test(host)) score -= 3;
  if (item.width >= 800) score += 1;
  if (item.width >= item.height * 1.2) score += 2;
  if (item.width < 400 || item.height < 280) score -= 100;
  return score;
}

async function fetchText(url, timeout = 15000) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function searchImage(name, city) {
  const query = `${city} ${name}`;
  const html = await fetchText(
    `https://pic.sogou.com/pics?query=${encodeURIComponent(query)}`,
  );
  const list = extractArray(html, '"searchList":[');
  if (!list?.length) throw new Error("没有搜索结果");
  return list
    .map((item) => ({
      title: item.title || "",
      thumb: item.thumbUrl || "",
      ori: item.oriPicUrl || "",
      page: item.url || "",
      width: Number(item.width || item.thumbWidth || 0),
      height: Number(item.height || item.thumbHeight || 0),
    }))
    .filter((item) => item.thumb)
    .sort((a, b) => scoreCandidate(b, name, city) - scoreCandidate(a, name, city))
    .slice(0, 4);
}

async function saveImage(buffer, hash) {
  const file = path.join(PHOTO_DIR, `${hash}.jpg`);
  const output = await sharp(buffer, { failOn: "error" })
    .rotate()
    .resize({ width: 960, height: 720, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  fs.writeFileSync(file, output);
  const meta = await sharp(output).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function saveBest(candidates, hash, source = "搜狗图片") {
  const errors = [];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.thumb, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`图片 HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 8000) throw new Error("图片过小");
      const size = await saveImage(buffer, hash);
      if (size.width < 320 || size.height < 200) throw new Error("图片尺寸不足");
      return {
        url: `/photos/${hash}.jpg`,
        source,
        sourceUrl: candidate.page || candidate.ori || candidate.thumb,
        title: candidate.title,
        ...size,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(errors.slice(0, 2).join(" / ") || "候选图全部失败");
}

async function fromSogou(item, hash) {
  const candidates = await searchImage(item.name, item.city);
  return saveBest(candidates, hash, "搜狗图片");
}

// 搜狗没结果时的第二图源：360 图片的公开 JSON 接口。
async function from360(item, hash) {
  const url = `https://image.so.com/j?q=${encodeURIComponent(
    `${item.city} ${item.name}`,
  )}&pd=1&pn=30&sn=0`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`360 HTTP ${response.status}`);
  const json = await response.json();
  const list = json.list || [];
  if (!list.length) throw new Error("360 没有搜索结果");
  const candidates = list
    .map((entry) => ({
      title: entry.title || "",
      thumb: entry.thumb || "",
      ori: entry.img || entry.https || entry.http || "",
      page: entry.link || "",
      width: Number(entry.width || 0),
      height: Number(entry.height || 0),
    }))
    .filter((entry) => entry.thumb)
    .sort(
      (a, b) =>
        scoreCandidate(b, item.name, item.city) -
        scoreCandidate(a, item.name, item.city),
    )
    .slice(0, 4);
  return saveBest(candidates, hash, "360图片");
}

// 人工核对过的 9 张优先保留原许可信息，直接经 Photon 代理取回。
function curatedPhotos() {
  const text = fs.readFileSync(CURATED_FILE, "utf8");
  const pattern =
    /city:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*thumb:\s*"([^"]+)",\s*page:\s*"([^"]+)",\s*author:\s*"([^"]+)",\s*license:\s*"([^"]+)"/g;
  const map = new Map();
  for (const match of text.matchAll(pattern)) {
    const [, city, name, thumb, page, author, license] = match;
    map.set(`${city}|${name}`, { city, name, thumb, page, author, license });
  }
  return map;
}

async function fromCurated(curated, hash) {
  const proxied = `${curated.thumb.replace(
    "https://thumb.wikimedia.org",
    "https://i0.wp.com/thumb.wikimedia.org",
  )}?w=960`;
  const response = await fetch(proxied, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`代理 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const size = await saveImage(buffer, hash);
  return {
    url: `/photos/${hash}.jpg`,
    source: "维基共享资源",
    sourceUrl: curated.page,
    title: `${curated.author} · ${curated.license}`,
    ...size,
  };
}

const places = [];
for (const file of fs.readdirSync(ENRICH_DIR).filter((f) => f.endsWith(".json"))) {
  const doc = JSON.parse(fs.readFileSync(path.join(ENRICH_DIR, file), "utf8"));
  for (const [key, place] of Object.entries(doc.places || {})) {
    if (!place || !Number.isFinite(place.lng) || !Number.isFinite(place.lat)) continue;
    places.push({
      key: `${doc.city}|${key}`,
      city: doc.city,
      name: place.name || key,
    });
  }
}

const curated = curatedPhotos();
const targets = places.filter((item) => !progress[item.key]?.entry);
console.log(`总计 ${places.length} 个景点，已有 ${places.length - targets.length} 张，待处理 ${targets.length} 张`);

let ok = 0;
let failed = 0;
let cursor = 0;
const CONCURRENCY = 3;

async function worker(id) {
  while (cursor < targets.length) {
    const item = targets[cursor];
    cursor += 1;
    const hash = crypto.createHash("sha1").update(item.key).digest("hex").slice(0, 16);
    try {
      const entry = curated.has(item.key)
        ? await fromCurated(curated.get(item.key), hash)
        : await fromSogou(item, hash).catch(() => from360(item, hash));
      progress[item.key] = { entry };
      ok += 1;
    } catch (error) {
      progress[item.key] = {
        error: error instanceof Error ? error.message : String(error),
      };
      failed += 1;
    }
    progressDirty = true;
    if (ok + failed <= 20 || (ok + failed) % 25 === 0) {
      saveProgress();
      console.log(
        `[worker ${id}] ${ok + failed}/${targets.length} ok=${ok} fail=${failed} 最近：${item.key} ${progress[item.key].error || ""}`,
      );
    }
    await sleep(curated.has(item.key) ? 80 : 220);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
if (progressDirty) saveProgress();

const index = {
  generatedAt: new Date().toISOString(),
  total: places.length,
  covered: places.filter((item) => progress[item.key]?.entry).length,
  method: "curated-wikimedia + sogou-image-search",
  note: "图片为搜索结果中的真实实景，版权归原作者；界面标注来源与原始页面。",
  places: Object.fromEntries(
    places
      .filter((item) => progress[item.key]?.entry)
      .map((item) => [item.key, progress[item.key].entry]),
  ),
};
fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

const lines = [
  "// 自动生成，请勿手改。跑 scripts/build-photo-index.mjs 重建。",
  "export interface LocalPlacePhoto {",
  "  url: string;",
  "  source: string;",
  "  sourceUrl?: string;",
  "  title?: string;",
  "}",
  "export const LOCAL_PLACE_PHOTOS: Record<string, LocalPlacePhoto> = {",
  ...(() => {
    // 同名景点可能以多个 enrichment key 出现；先写精确键，别名只在没冲突时补。
    const map = new Map();
    for (const item of places) {
      const entry = index.places[item.key];
      if (!entry) continue;
      map.set(
        item.key,
        JSON.stringify({
          url: entry.url,
          source: entry.source,
          sourceUrl: entry.sourceUrl,
          title: entry.title,
        }),
      );
    }
    for (const item of places) {
      const entry = index.places[item.key];
      if (!entry) continue;
      const alias = `${item.city}|${item.name}`;
      if (alias === item.key || map.has(alias)) continue;
      map.set(
        alias,
        JSON.stringify({
          url: entry.url,
          source: entry.source,
          sourceUrl: entry.sourceUrl,
          title: entry.title,
        }),
      );
    }
    return [...map].map(([key, value]) => `  ${JSON.stringify(key)}: ${value},`);
  })(),
  "};",
];
fs.writeFileSync(GENERATED_FILE, `${lines.join("\n")}\n`);

console.log(
  `\n完成：${index.covered}/${places.length} 张（新增 ok=${ok}, fail=${failed}）`,
);
if (failed) {
  console.log("失败的键可用 node scripts/build-photo-index.mjs 重跑补齐。");
}
