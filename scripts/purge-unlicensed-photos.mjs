/**
 * 清理没有明确许可的本地图片（npx tsx 不适用，这是纯 .mjs）。
 *
 *   node scripts/purge-unlicensed-photos.mjs          # 只统计，不改文件
 *   node scripts/purge-unlicensed-photos.mjs --apply  # 真正删条目 + 删图片文件
 *
 * 背景：src/content/place-photos.generated.ts 里 1600 条映射中，
 * 绝大多数来自早期「图片搜索 → 抓原图页面」的自动化流程，只有来源页、没有授权。
 * 这些图可以用于本地技术演示，但不能随作品公开分发，也不能商用。
 *
 * 这个脚本把生成表裁到只剩「有明确许可的来源」，同时删掉因此不再被引用的
 * public/photos/*.jpg，并打印体积变化。裁完之后缺图的点位会回落成版式卡
 * （PlacePhoto 本来就有这个兜底），不影响排线。
 *
 * 撤不回来的风险：本脚本只改生成表与图片文件，两个都建议先提交一版再跑 --apply。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const GENERATED = join(process.cwd(), "src", "content", "place-photos.generated.ts");
const PHOTO_DIR = join(process.cwd(), "public", "photos");
const LICENSED = new Set(["维基共享资源", "维基百科"]);
const apply = process.argv.includes("--apply");

const source = readFileSync(GENERATED, "utf8");
const lines = source.split(/\r?\n/);

const kept = [];
const dropped = [];
const keptFiles = new Set();
let droppedFiles = 0;

for (const line of lines) {
  const match = line.match(/^\s*"([^"]+)\":\s*(\{.*\}),?\s*$/);
  if (!match) {
    kept.push(line);
    continue;
  }
  const [, key, json] = match;
  let entry;
  try {
    entry = JSON.parse(json);
  } catch {
    kept.push(line);
    continue;
  }
  if (LICENSED.has(entry.source)) {
    kept.push(line);
    if (entry.url?.startsWith("/photos/")) keptFiles.add(entry.url.replace("/photos/", ""));
  } else {
    dropped.push({ key, source: entry.source, url: entry.url });
    if (entry.url?.startsWith("/photos/")) droppedFiles += 1;
  }
}

const bySource = dropped.reduce((acc, item) => {
  acc[item.source] = (acc[item.source] ?? 0) + 1;
  return acc;
}, {});

let onDisk = [];
try {
  onDisk = readdirSync(PHOTO_DIR).filter((name) => /\.(jpe?g|png|webp)$/i.test(name));
} catch {
  onDisk = [];
}
const orphans = onDisk.filter((name) => !keptFiles.has(name));
const sizeOf = (names) =>
  names.reduce((sum, name) => {
    try {
      return sum + statSync(join(PHOTO_DIR, name)).size;
    } catch {
      return sum;
    }
  }, 0);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";

console.log("生成表：" + lines.length + " 行，保留 " + kept.length + " 行");
console.log("  其中引用本地图片：" + keptFiles.size + " 个文件");
console.log("  待删除：" + dropped.length + " 条 " + JSON.stringify(bySource));
console.log("磁盘上图片：" + onDisk.length + " 个，" + mb(sizeOf(onDisk)));
console.log("不再被引用（可删）：" + orphans.length + " 个，" + mb(sizeOf(orphans)));

if (!apply) {
  console.log("\n这是预演。确认无误后加 --apply 真正执行。");
  process.exit(0);
}

writeFileSync(GENERATED, kept.join("\n"), "utf8");
let removed = 0;
for (const name of orphans) {
  try {
    unlinkSync(join(PHOTO_DIR, name));
    removed += 1;
  } catch {
    // 删不掉就算了，不影响生成表
  }
}
console.log("\n已写入生成表，并删除 " + removed + " 个图片文件。");
console.log("接下来：npx tsc --noEmit && npm run checks，再手动看一眼首页图片是否回落成版式卡。");
