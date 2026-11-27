/**
 * 图片持久化回归 —— 针对用户反馈「图片来回切换不在 / 有的地方没图」。
 *
 * 覆盖：
 *  - 成功结果落盘、跨刷新可读（localStorage mock）
 *  - 失败不落盘（冷缓存超时后能重试，不被永久钉死）
 *  - 坏数据/写满/SSR 容错
 *  - 容量上限
 *
 * 跑法：npx tsx scripts/check-photo-storage.ts
 */
import {
  clearPhotoCache,
  getStoredPhoto,
  loadPhotoCache,
  storePhoto,
} from "../src/lib/photo-storage";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

// 最小 localStorage mock（与 check-journal 同风格，不引 jsdom）
const box = new Map<string, string>();
let throwOnWrite = false;
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => box.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (throwOnWrite) throw new Error("QuotaExceeded");
      box.set(k, v);
    },
    removeItem: (k: string) => box.delete(k),
  },
};

console.log("1) 成功结果落盘、可持久读取");
clearPhotoCache();
const photo = {
  url: "/photos/日光岩.jpg",
  source: "维基共享资源",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:日光岩.jpg",
  author: "Webridge",
  license: "CC BY 3.0",
};
storePhoto("厦门|日光岩|||||viewpoint", photo);
ok("写入后能读单条", getStoredPhoto("厦门|日光岩|||||viewpoint")?.url === photo.url);
ok("整表可读", Object.keys(loadPhotoCache()).length === 1);
// 模拟刷新：内存清空，localStorage 还在
const afterReload = getStoredPhoto("厦门|日光岩|||||viewpoint");
ok("刷新后仍在（持久）", afterReload?.source === "维基共享资源");
ok("版权字段保留", afterReload?.license === "CC BY 3.0");

console.log("2) 失败不落盘（对抗性：冷缓存超时后能重试）");
clearPhotoCache();
// 模拟失败：storePhoto 收到无 url 的结果应直接忽略
storePhoto("厦门|冷门点", { url: "", source: "" });
ok("空 url 不写入", getStoredPhoto("厦门|冷门点") === null);
ok("空表", Object.keys(loadPhotoCache()).length === 0);
// 成功后又能写回（重试成功）
storePhoto("厦门|冷门点", { url: "/photos/category/attraction.jpg", source: "通用示意图", generic: true });
ok("重试成功后可持久", getStoredPhoto("厦门|冷门点")?.generic === true);

console.log("3) 坏数据容错");
box.set("mancheng.photoCache.v1", "not-json");
ok("坏 JSON 返回空", Object.keys(loadPhotoCache()).length === 0);
box.set("mancheng.photoCache.v1", JSON.stringify({ a: { url: "", source: "x" }, b: null, c: "str" }));
ok("过滤坏条目", Object.keys(loadPhotoCache()).length === 0);
box.set("mancheng.photoCache.v1", JSON.stringify({ a: { url: "/a.jpg", source: "s" }, b: { bad: 1 } }));
ok("保留好条目", Object.keys(loadPhotoCache()).length === 1);

console.log("4) 写入失败不影响主流程");
clearPhotoCache();
throwOnWrite = true;
let threw = false;
try {
  storePhoto("k", { url: "/x.jpg", source: "s" });
} catch {
  threw = true;
}
ok("QuotaExceeded 不抛错", !threw);
throwOnWrite = false;

console.log("5) 容量上限（防 localStorage 撑爆）");
clearPhotoCache();
for (let i = 0; i < 700; i++) {
  storePhoto(`key-${i}`, { url: `/photos/${i}.jpg`, source: "s" });
}
ok("不超过 600 条", Object.keys(loadPhotoCache()).length <= 600, String(Object.keys(loadPhotoCache()).length));
ok("最新条目保留", getStoredPhoto("key-699")?.url === "/photos/699.jpg");
ok("最旧条目被淘汰", getStoredPhoto("key-0") === null);

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
