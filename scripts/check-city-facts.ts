/**
 * 城市画像回归 —— 针对「内陆城市出现海边」这个 bug 的守门测试。
 * 真相源是离线生成的 src/content/city-facts.generated.ts。
 *
 * 跑法：npx tsx scripts/check-city-facts.ts
 */
import { CITY_FACTS, NEUTRAL_FACTS } from "../src/content/city-facts.generated";
import { applyResolvedPatch, makeDraft } from "../src/lib/chat/draft";
import type { ResolvedPatch } from "../src/lib/chat/types";

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

const optionIds = (city: string) =>
  (CITY_FACTS[city] ?? NEUTRAL_FACTS).experiences.map((o) => o.id);
const stylesOf = (city: string) =>
  (CITY_FACTS[city] ?? NEUTRAL_FACTS).styles;

console.log("1) 海滨城市有海、有海边玩法");
ok("厦门有海", CITY_FACTS["厦门"]?.capabilities.sea === true);
ok("厦门有海边玩法", optionIds("厦门").includes("coast"));
ok("厦门有环海慢游风格", stylesOf("厦门").includes("coastal"));
ok("青岛有海", CITY_FACTS["青岛"]?.capabilities.sea === true);
ok("三亚有海边玩法", optionIds("三亚").includes("coast"));
ok("北海有海边玩法", optionIds("北海").includes("coast"));

console.log("2) 内陆城市：无海边、无环海慢游（用户实测 bug）");
for (const city of ["杭州", "成都", "北京", "西安", "重庆", "南京", "武汉"]) {
  ok(`${city} 无海`, CITY_FACTS[city]?.capabilities.sea === false);
  ok(`${city} 无海边玩法`, !optionIds(city).includes("coast"), optionIds(city).join(","));
  ok(`${city} 无环海慢游`, !stylesOf(city).includes("coastal"));
}
console.log("3) 湖城有船但不假装是海");
ok("杭州有湖", CITY_FACTS["杭州"]?.capabilities.lake === true);
ok("杭州无海", CITY_FACTS["杭州"]?.capabilities.sea === false);
ok("杭州有西湖泛舟", (CITY_FACTS["杭州"]?.experiences ?? []).some((o) => o.label === "西湖泛舟"));
ok("杭州无海边", !optionIds("杭州").includes("coast"));
ok("苏州有水乡摇橹", (CITY_FACTS["苏州"]?.experiences ?? []).some((o) => o.label === "水乡摇橹"));
ok("苏州无海边", !optionIds("苏州").includes("coast"));

console.log("4) 山景 cities：云海/北海景区 不算海岸");
for (const city of ["黄山", "三清山", "泰山", "华山", "峨眉山"]) {
  if (!CITY_FACTS[city]) continue;
  ok(`${city} 无海`, CITY_FACTS[city].capabilities.sea === false);
  ok(`${city} 无海边玩法`, !optionIds(city).includes("coast"));
}

console.log("5) 无海无湖城市不给坐船");
for (const city of ["成都", "重庆", "西安", "北京", "三清山"]) {
  if (!CITY_FACTS[city]) continue;
  ok(`${city} 无坐船`, !optionIds(city).includes("boat"), optionIds(city).join(","));
}

console.log("6) 不在表里的城市走中性玩法，绝不含海陆专属");
ok("中性无海", NEUTRAL_FACTS.capabilities.sea === false);
ok("中性无海边", !NEUTRAL_FACTS.experiences.some((o) => o.id === "coast"));
ok("中性无坐船", !NEUTRAL_FACTS.experiences.some((o) => o.id === "boat"));
ok("中性无环海慢游", !NEUTRAL_FACTS.styles.includes("coastal"));
ok("中性有文化玩法", NEUTRAL_FACTS.experiences.some((o) => o.id === "museum"));
ok("银川不在表也照常工作", (CITY_FACTS["银川"] ?? NEUTRAL_FACTS).experiences.length > 0);

console.log("7) 所有城市都不出现「全量兜底」的海边");
let leaked = 0;
for (const [city, facts] of Object.entries(CITY_FACTS)) {
  if (facts.capabilities.sea) continue;
  if (facts.experiences.some((o) => o.id === "coast") || facts.styles.includes("coastal")) leaked++;
}
ok("122 城无泄漏", leaked === 0, `泄漏 ${leaked} 城`);

console.log("8) 换城市时清掉旧城市专属玩法");
const draft = makeDraft("2026-12-20");
const withCoast: ResolvedPatch = {
  city: { name: "厦门", lat: 24.48, lng: 118.09, address: "福建厦门" },
  styles: ["coastal", "foodie"],
  experiences: ["coast", "food"],
};
const afterXiamen = applyResolvedPatch(draft, withCoast);
ok("厦门时勾选保留", afterXiamen.styles.includes("coastal") && afterXiamen.experiences.includes("coast"));
const toInland: ResolvedPatch = {
  city: { name: "银川", lat: 38.48, lng: 106.23, address: "宁夏银川" },
};
const afterYinchuan = applyResolvedPatch(afterXiamen, toInland);
ok("换银川后 coastal 被清掉", !afterYinchuan.styles.includes("coastal"), afterYinchuan.styles.join(","));
ok("换银川后 coast 被清掉", !afterYinchuan.experiences.includes("coast"), afterYinchuan.experiences.join(","));
ok("换银川后 food 保留", afterYinchuan.experiences.includes("food"));

console.log(`\n通过 ${passed} / 失败 ${failed}`);
process.exit(failed ? 1 : 0);
