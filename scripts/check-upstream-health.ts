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
import {
  isEndpointDown,
  noteEndpointFailure,
  noteEndpointSuccess,
  orderTargets,
  resetUpstreamHealth,
  upstreamHealthSnapshot,
} from "../src/lib/upstream-health";

const MAIN = "https://overpass-api.de/api/interpreter";
const MIRROR = "https://maps.mail.ru/osm/tools/overpass/api/interpreter";

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

  resetUpstreamHealth();
  console.log("\n通过：排序 / 不丢源 / 恢复 / 退避 / 全故障降级 / 自动过期");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
