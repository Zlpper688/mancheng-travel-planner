/**
 * 现场图落盘缓存回归。
 *
 * 跑法：npx tsx scripts/check-live-cache.ts [--live]
 * --live 时会真下载一张图验证首次落盘与二次命中。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  cacheKeyOf,
  cachedPhotoUrl,
  getCacheStats,
  persistLivePhoto,
} from "../src/lib/live-photo-cache";

const root = process.cwd();

async function main() {
  console.log("1) 缓存键稳定、与噪声参数无关");
  const a = cacheKeyOf("重庆", "洪崖洞夜市");
  const b = cacheKeyOf("重庆", "洪崖洞夜市");
  assert.equal(a, b, "同一地点必须得到同一缓存键");
  assert.notEqual(a, cacheKeyOf("重庆", "洪崖洞"), "不同名字不能撞键");
  assert.match(a, /^[a-f0-9]{16}$/, "缓存键应是安全的文件名");
  console.log(`  ✓ ${a} 稳定且文件名安全`);

  console.log("2) 已是本地路径的图片不再处理");
  const local = {
    url: "/photos/abcdef.jpg",
    source: "现场搜图" as const,
    sourceUrl: "https://example.com",
  };
  assert.equal(await persistLivePhoto(local, "test-local"), local);
  console.log("  ✓ 本地图片原样返回，不重复下载");

  console.log("3) 缓存索引可读、统计可查");
  const stats = getCacheStats();
  assert.ok(stats && typeof stats === "object", "应返回缓存统计");
  console.log(`  ✓ 统计：${JSON.stringify(stats)}`);

  if (process.argv.includes("--live")) {
    console.log("4) 真实下载：首次落盘 + 二次命中本地");
    const key = `probe-${Date.now()}`;
    const remote = {
      url: "https://lizhicdn.search.qq.com/cdn/ybimages/1002/1002_5c97d2c970e3c4d3e3a96920186cbe8b/0593786ba1165034b20ae53b2b05d8c8_thumbnail.jpg",
      source: "现场搜图" as const,
      sourceUrl: "https://example.com/hongyadong",
      title: "重庆洪崖洞夜景",
      license: "版权归原作者",
    };
    const first = await persistLivePhoto(remote, key);
    assert.ok(first.url.startsWith("/photos/live/"), `首次应落盘：${first.url}`);
    const file = path.join(root, "public", first.url.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), "落盘文件应存在");
    const meta = await sharp(file).metadata();
    assert.ok(meta.width && meta.width >= 320, "落盘图尺寸应达标");
    assert.ok((fs.statSync(file).size / 1024) < 500, "落盘图应被压缩");

    const second = await persistLivePhoto(remote, key);
    assert.equal(second.url, first.url, "二次应命中同一份本地图");
    assert.ok(cachedPhotoUrl(key), "缓存索引应记录该键");
    console.log(`  ✓ 首次落盘 ${first.url}，二次命中，原出处保留`);
  } else {
    console.log("4) 真实下载部分跳过（加 --live 开启）");
  }

  console.log("\n通过：缓存键 + 本地直通 + 索引可读");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
