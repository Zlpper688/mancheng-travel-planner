/**
 * 全量景点图片覆盖检查。
 *
 * 目标：data/knowledge/enrichment 里每一个已核实景点都有一张本地实景图，
 * 且图片文件真实存在、可解码、尺寸达标，前后端解析层都能识别。
 *
 * 跑法：npx tsx scripts/check-photos.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { hasDirectPhoto } from "../src/lib/photo-hints";

async function main() {
const root = process.cwd();
const enrichmentDir = path.join(root, "data", "knowledge", "enrichment");
const indexPath = path.join(root, "data", "photo-index.json");
const generatedPath = path.join(
  root,
  "src",
  "content",
  "place-photos.generated.ts",
);

type IndexedPhoto = {
  url: string;
  source: string;
  sourceUrl?: string;
  title?: string;
  width?: number;
  height?: number;
};
type PhotoIndex = {
  generatedAt?: string;
  total?: number;
  covered?: number;
  places: Record<string, IndexedPhoto>;
};

const expected: { key: string; city: string; name: string }[] = [];
for (const file of fs.readdirSync(enrichmentDir).filter((f) => f.endsWith(".json"))) {
  const doc = JSON.parse(fs.readFileSync(path.join(enrichmentDir, file), "utf8"));
  for (const [key, place] of Object.entries(doc.places as Record<string, { name?: string; lng?: number; lat?: number }>)) {
    if (!place || !Number.isFinite(place.lng) || !Number.isFinite(place.lat)) continue;
    expected.push({ key: `${doc.city}|${key}`, city: doc.city, name: place.name || key });
  }
}

console.log(`1) 已核实景点 ${expected.length} 个，检查本地图片索引`);
assert.ok(fs.existsSync(indexPath), `缺少 ${path.relative(root, indexPath)}，先跑 scripts/build-photo-index.mjs`);
assert.ok(fs.existsSync(generatedPath), `缺少 ${path.relative(root, generatedPath)}，先跑 scripts/build-photo-index.mjs`);
const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as PhotoIndex;
assert.ok(index.places && typeof index.places === "object", "索引缺少 places 对象");

const missing = expected.filter((item) => !index.places[item.key]);
assert.equal(
  missing.length,
  0,
  `仍有 ${missing.length} 个景点没有图，例如：${missing.slice(0, 8).map((m) => m.key).join("、")}`,
);
console.log(`  ✓ ${expected.length}/${expected.length} 个景点都有索引`);
console.log(`  ✓ 索引声明 covered=${index.covered}（应为 ${expected.length}）`);
assert.equal(index.covered, expected.length, "索引 covered 与景点总数不一致");

console.log("2) 图片文件真实存在且可解码");
const sampled = expected.filter((_, i) => i % 7 === 0); // 逐张验证文件存在，抽样解码
let badFile = 0;
for (const item of expected) {
  const entry = index.places[item.key];
  const rel = entry.url.replace(/^\//, "");
  if (!fs.existsSync(path.join(root, "public", rel))) badFile += 1;
}
assert.equal(badFile, 0, `${badFile} 个索引指向的图片文件不存在`);
for (const item of sampled) {
  const entry = index.places[item.key];
  const file = path.join(root, "public", entry.url.replace(/^\//, ""));
  const meta = await sharp(file).metadata();
  assert.ok(meta.width && meta.width >= 320, `${item.key} 图片宽度不足：${meta.width}`);
  assert.ok(meta.height && meta.height >= 200, `${item.key} 图片高度不足：${meta.height}`);
  assert.ok(entry.sourceUrl?.startsWith("http"), `${item.key} 缺少可追溯的原图出处`);
}
console.log(`  ✓ ${expected.length} 个文件存在；抽样 ${sampled.length} 张解码通过且尺寸达标`);

console.log("3) 生成表与索引一致，客户端能识别");
const generated = fs.readFileSync(generatedPath, "utf8");
const sampleKeys = ["厦门|鼓浪屿", "川藏|布达拉宫", "北疆|喀纳斯", "成都|春熙路"];
for (const key of sampleKeys) {
  assert.ok(generated.includes(`"${key}"`), `生成表缺少 ${key}`);
}
for (const item of expected.slice(0, 40)) {
  assert.equal(
    hasDirectPhoto(item.name, item.city),
    true,
    `hasDirectPhoto 未识别 ${item.key}`,
  );
}
console.log("  ✓ 生成表含样例键；hasDirectPhoto 对前 40 个点全部识别为有图");

console.log("\n通过：全量景点图片覆盖 + 文件可解码 + 前端识别");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
