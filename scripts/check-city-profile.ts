/**
 * 城市画像回归：确认"城市对后续选项真的有影响"。
 * 用真实知识库点位跑，不用造数据。
 */
import fs from "node:fs";
import path from "node:path";
import { buildCityProfile, formatCityProfile } from "../src/lib/city-profile";
import type { Place } from "../src/lib/types";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function loadPlaces(city: string): Place[] {
  const file = path.join(process.cwd(), "data/knowledge/enrichment", `${city}.json`);
  if (!fs.existsSync(file)) return [];
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as {
    places?: Record<string, Record<string, unknown>>;
  };
  return Object.entries(doc.places ?? {})
    .filter(([, p]) => p && p.verified !== false)
    .map(([name, p]) => ({
      id: `${city}-${name}`,
      name,
      category: (p.category as Place["category"]) ?? "attraction",
      lat: Number(p.lat) || 0,
      lng: Number(p.lng) || 0,
      rating: Number(p.rating) || undefined,
      city,
      source: "demo" as const,
    }));
}

console.log("=== 1) 厦门：海滨城市，海边必须在且排前面 ===");
const xm = buildCityProfile("厦门", loadPlaces("厦门"));
console.log(formatCityProfile(xm).split("\n").slice(0, 4).join("\n"));
ok("有海边选项", xm.options.some((o) => o.id === "coast"));
ok("海边文案城市化", xm.options.find((o) => o.id === "coast")?.label === "海边漫步");
ok("有轮渡", xm.options.some((o) => o.id === "boat"));

console.log("\n=== 2) 杭州：内陆有湖，海边必须消失，船要变成湖里划船 ===");
const hz = buildCityProfile("杭州", loadPlaces("杭州"));
console.log(formatCityProfile(hz).split("\n").slice(0, 4).join("\n"));
ok("海边被过滤", !hz.options.some((o) => o.id === "coast"), hz.hidden.join(","));
ok("海边在 hidden 列表", hz.hidden.includes("coast"));
ok("有坐船", hz.options.some((o) => o.id === "boat"));
ok("船变成西湖泛舟", hz.options.find((o) => o.id === "boat")?.label === "西湖泛舟");
ok("补入夜游特色", hz.options.some((o) => o.id === "night" && o.featured));
ok("补入茶山徒步", hz.options.find((o) => o.id === "hike")?.label === "茶山徒步");

console.log("\n=== 3) 排序：匹配度高的在前 ===");
for (let i = 1; i < hz.options.length; i++) {
  ok(`${hz.options[i].label} 不高于前一项`, hz.options[i - 1].score >= hz.options[i].score);
}

console.log("\n=== 4) 空城市兜底：不崩、给出说明 ===");
const empty = buildCityProfile("不存在市", []);
ok("无选项", empty.options.length === 0);
ok("有兜底说明", empty.summary.includes("整理中"));

console.log("\n=== 5) 内陆城市通用规则（造少量点位验证过滤）===");
const inland: Place[] = [
  { id: "1", name: "西湖", category: "park", lat: 30, lng: 120, city: "杭州", source: "demo" },
  { id: "2", name: "博物馆", category: "museum", lat: 30, lng: 120, city: "杭州", source: "demo" },
];
const inlandProfile = buildCityProfile("内陆城", inland);
ok("没有海就不出现海边", !inlandProfile.options.some((o) => o.id === "coast"));
ok("有博物馆", inlandProfile.options.some((o) => o.id === "museum"));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
