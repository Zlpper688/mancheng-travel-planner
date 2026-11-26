/** 区域分段回归（npx tsx scripts/check-segments.ts）。 */
import { segmentPlaces, isRegionSpan } from "../src/lib/plan/segments";
import { readLocalKnowledge } from "../src/lib/providers/knowledge";
import type { Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

(async () => {
console.log("1) 用真实本地包验证区域分段");
const cases = [
  { city: "北疆", days: 3, expect: ["喀纳斯", "禾木", "那拉提"] },
  { city: "川藏", days: 4, expect: ["成都", "拉萨"] },
  { city: "广西", days: 3, expect: ["桂林", "北海"] },
];

for (const c of cases) {
  const kb = await readLocalKnowledge(c.city);
  const places = kb.places.slice(0, 24);
  console.log(`\n  --- ${c.city} (${places.length}点, ${kb.places.length}总) ---`);
  ok(`${c.city} 判为区域跨度`, isRegionSpan(places));
  const segs = segmentPlaces(places, c.days, kb.center ?? undefined);
  console.log(`  分成 ${segs.length} 段:`);
  for (const seg of segs) {
    console.log(
      `    [${seg.index}] ${seg.label} 中心[${seg.center.map((n) => n.toFixed(1)).join(",")}] ` +
      `${seg.places.length}点 跨度${seg.spanKm}km: ${seg.places.map((p) => p.name).slice(0, 8).join("/")}`,
    );
  }
  ok(`${c.city} 段数 = 天数`, segs.length === c.days, `实际 ${segs.length}`);
  const allNames = segs.flatMap((s) => s.places.map((p) => p.name));
  ok(`${c.city} 所有点都被分配`, allNames.length === places.length, `${allNames.length}/${places.length}`);
  const unique = new Set(allNames);
  ok(`${c.city} 没有点被重复分配`, unique.size === allNames.length);
  for (const e of c.expect) {
    ok(`${c.city} 含「${e}」`, allNames.some((n) => n.includes(e)));
  }
}

console.log("\n2) 单城不应被判区域");
const cd = await readLocalKnowledge("成都");
ok("成都不判区域跨度", !isRegionSpan(cd.places, 400));
const seg1 = segmentPlaces(cd.places, 2);
ok("成都强行分段也能分（不崩）", seg1.length === 2);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：区域判定 + 分段覆盖 + 不重不漏 + 单城兜底");
})();
