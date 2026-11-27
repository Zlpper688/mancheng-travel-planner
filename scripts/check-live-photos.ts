/**
 * 现场找图 + 分类兜底回归。
 *
 * 纯逻辑部分（标题守门）离线可测；网络部分按需跑，用 --live 开启。
 * 跑法：npx tsx scripts/check-live-photos.ts [--live]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { titleMatches, searchLivePhoto } from "../src/lib/live-search";

const root = process.cwd();

async function main() {
  console.log("1) 标题守门：真景点名必须命中，瞎编地名必须挡住");
  const hits = [
    ["重庆洪崖洞凭什么能成为网红景点", "洪崖洞", "重庆"],
    ["贵州荔波小七孔，醉美喀斯特地貌！", "荔波小七孔", "贵州"],
    ["中国甘肃省张掖市,张掖七彩丹霞地质公园", "张掖七彩丹霞", "甘肃"],
    ["演武大桥观景平台", "演武大桥观景平台", "厦门"],
    ["泉州开元寺", "开元寺", "泉州"],
  ];
  for (const [title, name, city] of hits) {
    assert.equal(titleMatches(title, name, city), true, `应命中：${title} / ${name}`);
  }
  console.log(`  ✓ ${hits.length} 个真景点标题全部命中`);

  const misses = [
    ["吴恩达圣诞寄语：回顾2020年AI大事件", "不存在的景点xyz", "随便编的城市"],
    ["奔驰导航地名搜索功能教程", "胡编乱造的地方", "测试"],
    ["全国各地奇葩的地名.", "不存在的地方", "测试"],
  ];
  for (const [title, name, city] of misses) {
    assert.equal(titleMatches(title, name, city), false, `应挡住：${title} / ${name}`);
  }
  console.log(`  ✓ ${misses.length} 个瞎编地名全部被挡住（不会拿错图冒充）`);

  console.log("2) 分类通用图：13 类全部有可解码的本地示意图");
  const index = JSON.parse(
    fs.readFileSync(path.join(root, "data", "category-photos.json"), "utf8"),
  ) as {
    categories: Record<string, { url: string; source: string; sourceUrl?: string }>;
  };
  const categories = [
    "attraction", "museum", "park", "viewpoint", "beach", "street", "temple",
    "market", "nature", "food", "cafe", "hotel", "other",
  ];
  for (const category of categories) {
    const entry = index.categories[category];
    assert.ok(entry, `缺少分类图：${category}`);
    const file = path.join(root, "public", entry.url.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), `分类图文件不存在：${file}`);
    const meta = await sharp(file).metadata();
    assert.ok(meta.width && meta.width >= 320, `${category} 宽度不足`);
    assert.ok(entry.sourceUrl?.startsWith("http"), `${category} 缺出处`);
  }
  console.log(`  ✓ ${categories.length} 类图存在、可解码、有出处`);

  console.log("3) 生成表与索引一致，前端能识别");
  const generated = fs.readFileSync(
    path.join(root, "src", "content", "category-photos.generated.ts"),
    "utf8",
  );
  for (const category of categories) {
    assert.ok(generated.includes(`"${category}"`), `生成表缺少 ${category}`);
  }
  console.log("  ✓ 13 类键都在生成表里");

  if (process.argv.includes("--live")) {
    console.log("4) 现场搜图（真实网络）");
    const real = await searchLivePhoto({ name: "洪崖洞", city: "重庆" });
    assert.ok(real, "真景点应该能现场搜到图");
    assert.equal(real.source, "现场搜图");
    assert.ok(real.url.startsWith("https://"), "现场图应是直链 CDN");
    console.log(`  ✓ 洪崖洞现场搜到：${real.title?.slice(0, 40)}`);

    const fake = await searchLivePhoto({ name: "完全不存在的xyz地点", city: "测试city" });
    assert.equal(fake, null, "瞎编地点不应搜到图（应落到分类兜底）");
    console.log("  ✓ 瞎编地点被守门挡住");
  } else {
    console.log("4) 现场搜图网络部分跳过（加 --live 开启）");
  }

  console.log("\n通过：标题守门 + 分类兜底 + 生成表");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
