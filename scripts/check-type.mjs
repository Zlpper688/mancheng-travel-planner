// 字号护栏：正文不许再用 8–9px。
// 中文在手机上 9px 基本看不清，「正文 12 / 辅助 11 / 角标 10」这套三档
// 写在 globals.css 的 @theme 里（text-body / text-meta / text-micro）。
// 这里拦的是有人图省事又写回 text-[9px]。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["src/components", "src/app"];
const MIN_PX = 10;
const PATTERN = /text-\[(\d+(?:\.\d+)?)px\]/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (/\.(tsx|ts)$/.test(name)) out.push(path);
  }
  return out;
}

const violations = [];
for (const root of ROOTS) {
  let files = [];
  try {
    files = walk(root);
  } catch {
    continue;
  }
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(PATTERN)) {
        const px = Number(match[1]);
        if (px < MIN_PX) {
          violations.push({
            file: relative(process.cwd(), file),
            line: index + 1,
            token: match[0],
          });
        }
      }
    });
  }
}

if (violations.length) {
  console.error(`字号过小（< ${MIN_PX}px）：`);
  for (const item of violations) {
    console.error(`  ${item.file}:${item.line}  ${item.token}`);
  }
  console.error(
    `\n改用 text-body（12px）/ text-meta（11px）/ text-micro（10px）。`,
  );
  process.exit(1);
}

console.log(`字号检查通过：没有小于 ${MIN_PX}px 的硬编码字号。`);
