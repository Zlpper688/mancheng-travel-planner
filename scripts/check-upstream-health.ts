/**
 * 上游端点健康记忆（熔断器）回归。
 *
 * 背景：overpass-api.de 在本机网络下已完全不可达（40s 无响应），而镜像
 * maps.mail.ru 7.7s 就能返回同样 60 条点位。原实现每次都要先等主站 6s 超时
 * 再换镜像，于是每个冷启动请求都白烧 6 秒。熔断器把「这个端点刚挂过」记下来，
 * 下次直接走镜像——数据源一个没少，只是不再为已知死掉的端点排队。
 *
 * 跑法：npx tsx scripts/check-upstream-health.ts
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  allEndpointsDown,
  forgetUpstreamHealthMemory,
  isEndpointDown,
  noteEndpointFailure,
  noteEndpointSuccess,
  orderTargets,
  reloadUpstreamHealth,
  resetUpstreamHealth,
  upstreamHealthSnapshot,
} from "../src/lib/upstream-health";

const MAIN = "https://overpass-api.de/api/interpreter";
const MIRROR = "https://maps.mail.ru/osm/tools/overpass/api/interpreter";

/** 独立缓存根，避免污染开发时真正的 .cache/。 */
const TEST_ROOT = path.join(process.cwd(), ".cache-health-check");
process.env.MC_CACHE_ROOT = TEST_ROOT;

function main() {
  console.log("1) 无记录时端点视为健康，顺序不变");
  resetUpstreamHealth();
  assert.equal(isEndpointDown(MAIN), false);
  const order = orderTargets([{ url: MAIN }, { url: MIRROR }]);
  assert.deepEqual(
    order.map((t) => t.url),
    [MAIN, MIRROR],
  );
  console.log("  ✓ 冷启动保持原顺序");

  console.log("2) 失败一次后，该端点被排到队尾");
  noteEndpointFailure(MAIN);
  assert.equal(isEndpointDown(MAIN), true);
  assert.equal(isEndpointDown(MIRROR), false);
  const reordered = orderTargets([{ url: MAIN }, { url: MIRROR }]);
  assert.deepEqual(
    reordered.map((t) => t.url),
    [MIRROR, MAIN],
    "健康的端点必须排在前面",
  );
  console.log("  ✓ 镜像被提前，主站退到后面");

  console.log("3) 熔断不删端点：仍留在候选里，只是不再先试");
  assert.equal(reordered.length, 2);
  console.log("  ✓ 候选数不减少（不因健康记录丢数据源）");

  console.log("4) 成功一次即清零，顺序恢复");
  noteEndpointSuccess(MAIN);
  assert.equal(isEndpointDown(MAIN), false);
  assert.deepEqual(
    orderTargets([{ url: MAIN }, { url: MIRROR }]).map((t) => t.url),
    [MAIN, MIRROR],
  );
  console.log("  ✓ 恢复后重新排到前面");

  console.log("5) 连续失败会拉长冷却时间（指数退避，有上限）");
  resetUpstreamHealth();
  noteEndpointFailure(MAIN);
  const first = upstreamHealthSnapshot()[MAIN]?.downForMs ?? 0;
  noteEndpointFailure(MAIN);
  const second = upstreamHealthSnapshot()[MAIN]?.downForMs ?? 0;
  noteEndpointFailure(MAIN);
  const third = upstreamHealthSnapshot()[MAIN]?.downForMs ?? 0;
  assert.ok(first > 0, "首次失败就应进入冷却");
  assert.ok(second > first, `第二次冷却应更长：${first} → ${second}`);
  assert.ok(third >= second, `第三次不应短于第二次：${second} → ${third}`);
  for (let i = 0; i < 10; i++) noteEndpointFailure(MAIN);
  const capped = upstreamHealthSnapshot()[MAIN]?.downForMs ?? 0;
  assert.ok(capped <= 60 * 60 * 1000, `冷却上限不该超过 1 小时，实际 ${capped}`);
  console.log(`  ✓ ${first}ms → ${second}ms → ${third}ms，封顶 ${capped}ms`);

  console.log("6) 全部端点都判定故障时，保持原顺序（宁可多试一次也不断流）");
  resetUpstreamHealth();
  noteEndpointFailure(MAIN);
  noteEndpointFailure(MIRROR);
  const allDown = orderTargets([{ url: MAIN }, { url: MIRROR }]);
  assert.deepEqual(
    allDown.map((t) => t.url),
    [MAIN, MIRROR],
    "全故障时必须回到原顺序，不能返回空数组",
  );
  console.log("  ✓ 全故障降级为原顺序，不返回空");

  console.log("7) 冷却到期后自动恢复健康");
  resetUpstreamHealth();
  noteEndpointFailure(MAIN);
  assert.equal(isEndpointDown(MAIN), true);
  // 直接把 now 往前推：用真实的 sleep 会让这条测试变慢且脆弱。
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 60 * 1000;
  try {
    assert.equal(isEndpointDown(MAIN), false, "冷却到期后应自动恢复");
  } finally {
    Date.now = realNow;
  }
  console.log("  ✓ 冷却到期自动恢复");

  /* ---------- 落盘：跨进程记忆 ---------- */
  // 为什么必须落盘：Next.js 每次重启、每个 worker 都是新进程。
  // 只存在内存里的话，「overpass-api.de 是死的」这条结论每个新进程都要重学一遍，
  // 代价就是每个冷请求白等 6 秒——而这条结论本该只学一次。

  console.log("8) 失败记录落盘：清空内存后重新加载仍然生效");
  resetUpstreamHealth();
  noteEndpointFailure(MAIN);
  const healthDir = path.join(TEST_ROOT, "health");
  assert.ok(existsSync(healthDir), `熔断状态应写入 ${healthDir}`);
  const written = readdirSync(healthDir).filter((n) => n.endsWith(".json"));
  assert.ok(written.length >= 1, "反空转：必须真的写出文件，而不是只改内存");
  // 模拟重启：只清内存，磁盘保留。
  // 注意不能断言「清内存后先变成未知」——ensureLoaded 是懒加载，
  // 下一次访问就会把磁盘读回来，那正是我们要的行为。
  forgetUpstreamHealthMemory();
  assert.equal(
    isEndpointDown(MAIN),
    true,
    "新进程的第一次访问就该从磁盘恢复「这个端点刚挂过」",
  );
  reloadUpstreamHealth();
  assert.equal(isEndpointDown(MAIN), true, "显式重载后同样成立");
  assert.deepEqual(
    orderTargets([{ url: MAIN }, { url: MIRROR }]).map((t) => t.url),
    [MIRROR, MAIN],
    "重启后的第一个请求就该走镜像，而不是再等主站超时一次",
  );
  console.log(`  ✓ 重启后仍记得（落盘文件 ${written.length} 个）`);

  console.log("9) 成功一次后，磁盘上的失败记录也被清掉");
  noteEndpointSuccess(MAIN);
  forgetUpstreamHealthMemory();
  reloadUpstreamHealth();
  assert.equal(isEndpointDown(MAIN), false, "成功过的端点重启后不该被当成故障");
  console.log("  ✓ 成功即清盘，不会把已恢复的端点永久拉黑");

  console.log("10) 落盘文件损坏时当作空记录，不抛错");
  resetUpstreamHealth();
  mkdirSync(healthDir, { recursive: true });
  for (const name of readdirSync(healthDir)) {
    if (name.endsWith(".json")) {
      writeFileSync(path.join(healthDir, name), "{ this is not json", "utf8");
    }
  }
  forgetUpstreamHealthMemory();
  reloadUpstreamHealth();
  assert.equal(isEndpointDown(MAIN), false, "损坏文件应退化为「没有记录」");
  assert.deepEqual(
    orderTargets([{ url: MAIN }, { url: MIRROR }]).map((t) => t.url),
    [MAIN, MIRROR],
    "没有可用记录时保持原顺序",
  );
  console.log("  ✓ 损坏降级为无记录，排序回到原样");

  console.log("11) allEndpointsDown：可选补充源的全故障判定");
  resetUpstreamHealth();
  assert.equal(allEndpointsDown([]), false, "空列表不该被当成「全挂」");
  assert.equal(allEndpointsDown([MAIN]), false, "没有记录时不算挂");
  noteEndpointFailure(MAIN);
  assert.equal(allEndpointsDown([MAIN]), true, "唯一端点挂了就该判定为全挂");
  assert.equal(allEndpointsDown([MAIN, MIRROR]), false, "还有一个健康就不能说全挂");
  noteEndpointFailure(MIRROR);
  assert.equal(allEndpointsDown([MAIN, MIRROR]), true, "两个都挂才是全挂");
  noteEndpointSuccess(MIRROR);
  assert.equal(allEndpointsDown([MAIN, MIRROR]), false, "有端点恢复后立即不再全挂");
  console.log("  ✓ 全挂判定与恢复都正确");

  console.log("12) 餐饮这类可选源必须真的用上「全挂就跳过」");
  // 守卫要能变红：把 open.ts 里的 skipIfAllDown 删掉，这条就该失败。
  // 没有这条，第 11 条测的只是一个没人调用的函数。
  const openSource = readFileSync(
    path.join(process.cwd(), "src", "lib", "providers", "open.ts"),
    "utf8",
  );
  const optionalCalls = openSource.match(
    /overpassQuery\([^)]*skipIfAllDown:\s*true[^)]*\)/g,
  );
  assert.ok(
    optionalCalls && optionalCalls.length >= 1,
    "至少有一个 overpassQuery 调用要带 skipIfAllDown: true（餐饮等可选补充源）",
  );
  // 关键源（景点）绝不能开这个开关：那里宁可多试一次也不能断流。
  const scenicCall = openSource.match(
    /overpassQuery\(scenicQuery,[^)]*\)/,
  );
  assert.ok(scenicCall, "反空转：必须能找到景点查询的调用点");
  assert.ok(
    !/skipIfAllDown/.test(scenicCall[0]),
    "景点是关键数据源，不能因为熔断就跳过——那会让整座城市没有点位",
  );
  console.log(`  ✓ 可选源 ${optionalCalls.length} 处开启跳过，关键源未开`);

  resetUpstreamHealth();
  console.log(
    "\n通过：排序 / 不丢源 / 恢复 / 退避 / 全故障降级 / 自动过期 / 跨进程落盘 / 损坏降级 / 可选源跳过",
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
