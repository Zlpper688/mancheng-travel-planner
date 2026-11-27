/**
 * 为 13 个景点类别建立「通用示意图」。
 *
 * 这是最后一层兜底：现场搜图拿不到该景点本身的照片时，按类别给一张明确标注
 * 「通用示意图」的图，绝不冒充具体景点实景。每张仍记录搜索来源与原图页面。
 *
 * 跑法：node scripts/build-category-photos.mjs
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "public", "photos", "category");
const INDEX_FILE = path.join(ROOT, "data", "category-photos.json");
const GENERATED_FILE = path.join(
  ROOT,
  "src",
  "content",
  "category-photos.generated.ts",
);

const CATEGORIES = [
  { id: "attraction", query: "著名地标景点建筑", must: ["地标", "景点", "建筑"] },
  { id: "museum", query: "博物馆建筑外观", must: ["博物馆"] },
  { id: "park", query: "城市公园风景", must: ["公园"] },
  { id: "viewpoint", query: "山顶观景台风景", must: ["观景", "山顶", "山"] },
  { id: "beach", query: "海边沙滩风景", must: ["海", "沙滩"] },
  { id: "street", query: "城市步行街街景", must: ["步行街", "街道", "街区"] },
  { id: "temple", query: "寺庙古建筑", must: ["寺", "庙", "道观"] },
  { id: "market", query: "传统集市市场", must: ["集市", "市场"] },
  { id: "nature", query: "高山山峰自然风景", must: ["山", "峰"] },
  { id: "food", query: "中式美食品尝", must: ["美食", "菜"] },
  { id: "cafe", query: "咖啡馆咖啡", must: ["咖啡"] },
  { id: "hotel", query: "酒店建筑客房", must: ["酒店", "宾馆"] },
  { id: "other", query: "旅行风景", must: ["风景", "旅行"] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractArray(text, marker) {
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const bracket = text.indexOf("[", start);
  if (bracket < 0) return null;
  let depth = 0, inString = false, escaped = false;
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
        try { return JSON.parse(text.slice(bracket, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

async function sogouCandidates(query) {
  const res = await fetch(
    `https://pic.sogou.com/pics?query=${encodeURIComponent(query)}`,
    {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) throw new Error(`搜狗 HTTP ${res.status}`);
  const html = await res.text();
  const list = extractArray(html, '"searchList":[') || [];
  return list
    .map((x) => ({
      title: x.title || "",
      thumb: x.thumbUrl || "",
      ori: x.oriPicUrl || "",
      page: x.url || "",
      width: Number(x.width || 0),
      height: Number(x.height || 0),
    }))
    .filter((x) => x.thumb)
    .sort((a, b) => {
      const rank = (x) => (x.width >= x.height * 1.2 ? 2 : 0) + (x.width >= 800 ? 1 : 0);
      return rank(b) - rank(a);
    });
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const index = {
  generatedAt: new Date().toISOString(),
  note: "通用示意图：仅表示类别，不冒充具体景点实景；版权归原作者。",
  categories: {},
};

for (const category of CATEGORIES) {
  let saved = null;
  try {
    const candidates = await sogouCandidates(category.query);
    const matched = candidates.filter((x) =>
      category.must.some((word) => x.title.includes(word)),
    );
    const errors = [];
    for (const candidate of matched.slice(0, 5)) {
      try {
        const res = await fetch(candidate.thumb, {
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`图片 HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length < 8000) throw new Error("图片过小");
        const out = await sharp(buffer, { failOn: "error" })
          .rotate()
          .resize({ width: 720, height: 540, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 72 })
          .toBuffer();
        const meta = await sharp(out).metadata();
        if (!meta.width || meta.width < 320 || !meta.height || meta.height < 200) {
          throw new Error("尺寸不足");
        }
        const url = `/photos/category/${category.id}.jpg`;
        fs.writeFileSync(path.join(OUT_DIR, `${category.id}.jpg`), out);
        saved = {
          url,
          source: "通用示意图",
          sourceUrl: candidate.page || candidate.ori || candidate.thumb,
          title: candidate.title,
          width: meta.width,
          height: meta.height,
        };
        break;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!saved) throw new Error(errors.slice(0, 2).join(" / ") || "没有匹配候选");
  } catch (error) {
    console.log(`[${category.id}] 失败：${error instanceof Error ? error.message : error}`);
  }
  if (saved) {
    index.categories[category.id] = saved;
    console.log(`[${category.id}] ${saved.title.slice(0, 40)} -> ${saved.url}`);
  }
  await sleep(250);
}

fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));

const generated = [
  "// 自动生成，请勿手改。跑 scripts/build-category-photos.mjs 重建。",
  "export interface CategoryPhoto {",
  "  url: string;",
  "  source: string;",
  "  sourceUrl?: string;",
  "  title?: string;",
  "}",
  "export const CATEGORY_PHOTOS: Record<string, CategoryPhoto> = {",
  ...Object.entries(index.categories).map(
    ([id, entry]) =>
      `  ${JSON.stringify(id)}: ${JSON.stringify({
        url: entry.url,
        source: entry.source,
        sourceUrl: entry.sourceUrl,
        title: entry.title,
      })},`,
  ),
  "};",
];
fs.writeFileSync(GENERATED_FILE, `${generated.join("\n")}\n`);

console.log(
  `\n完成：${Object.keys(index.categories).length}/${CATEGORIES.length} 类通用示意图`,
);
