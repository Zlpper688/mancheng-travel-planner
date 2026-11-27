/**
 * 本地城市搜索回归。
 *
 * 这套匹配的失败方式很具体：如果「南京市」搜不到「南京」，
 * 用户会以为这地方没被支持；如果「南」把「南京」排在「湖南」前面错位，
 * 用户会选错城市。所以排序规则要能被逐条验证。
 *
 * 跑法：npx tsx scripts/check-city-search.ts
 */
import assert from "node:assert/strict";
import { LOCAL_CITIES } from "../src/content/cities.generated";
import { searchLocalCities } from "../src/lib/city-search";

function names(query: string, limit?: number): string[] {
  return searchLocalCities(query, limit).map((city) => city.name);
}

function main() {
  console.log("1) 索引本身非空（反空转：生成脚本没跑就等于什么都没搜到）");
  assert.ok(LOCAL_CITIES.length >= 100, `本地索引应覆盖上百个目的地，实际 ${LOCAL_CITIES.length}`);
  assert.ok(
    LOCAL_CITIES.every((city) => Number.isFinite(city.lat) && Number.isFinite(city.lng)),
    "每个条目都必须有有效坐标",
  );
  console.log(`  ✓ ${LOCAL_CITIES.length} 个目的地，坐标完整`);

  console.log("2) 精确名排第一");
  assert.equal(names("南京")[0], "南京");
  assert.equal(names("杭州")[0], "杭州");
  assert.equal(names("厦门")[0], "厦门");
  console.log("  ✓ 精确匹配优先");

  console.log("3) 带「市」也能命中（用户习惯写全称）");
  assert.ok(names("南京市").includes("南京"), `「南京市」应命中南京，实际 ${names("南京市")}`);
  assert.ok(names("杭州市").includes("杭州"));
  console.log("  ✓ 全称容错");

  console.log("4) 前缀匹配");
  const prefix = names("南");
  assert.ok(prefix.includes("南京"), `「南」应包含南京，实际 ${prefix}`);
  assert.ok(prefix.includes("南昌") || prefix.length > 0, "前缀应有结果");
  console.log(`  ✓ 「南」→ ${prefix.slice(0, 5).join(" / ")}`);

  console.log("5) 精确匹配必须排在模糊匹配之前");
  const ranked = names("大理");
  assert.equal(ranked[0], "大理", `「大理」应把大理排第一，实际 ${ranked}`);
  console.log("  ✓ 精确优先于包含");

  console.log("6) 空查询返回空（不能把整个城市表倒给用户）");
  assert.deepEqual(names(""), []);
  assert.deepEqual(names("   "), []);
  console.log("  ✓ 空查询不返回任何结果");

  console.log("7) 完全不相关时返回空，而不是瞎猜");
  assert.deepEqual(names("zzzzzz"), []);
  assert.deepEqual(names("完全不存在的城市名"), []);
  console.log("  ✓ 无匹配就是空，不硬凑");

  console.log("8) limit 生效");
  const limited = names("州", 3);
  assert.ok(limited.length <= 3, `limit=3 时不该超过 3 条，实际 ${limited.length}`);
  console.log(`  ✓ limit 生效（${limited.length} 条）`);

  console.log("9) 结果里带坐标与地区，前端可直接用");
  const first = searchLocalCities("南京")[0];
  assert.ok(first, "应命中南京");
  assert.equal(typeof first.lat, "number");
  assert.equal(typeof first.lng, "number");
  assert.ok(first.region.length > 0, "地区用于消歧，不能为空");
  console.log(`  ✓ 南京 → ${first.region} (${first.lat}, ${first.lng})`);

  console.log("\n通过：反空转 / 精确优先 / 全称容错 / 前缀 / 排序 / 空查询 / 无匹配 / limit / 字段完整");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
