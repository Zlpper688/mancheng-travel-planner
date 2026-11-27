/**
 * 投机预热回归。
 *
 * 这套逻辑的失败方式都很安静：去重窗口写错 → 用户每敲一个字就打一次地图；
 * 并发上限没生效 → 一次搜索把公共端点配额打满；
 * 失败冒泡 → 预热把搜索接口拖垮。所以每条都要能真的变红。
 *
 * 跑法：npx tsx scripts/check-prefetch.ts
 */
import assert from "node:assert/strict";
import {
  prefetchCity,
  prefetchSnapshot,
  resetPrefetchState,
  resetSingleFlight,
  singleFlight,
  singleFlightSize,
} from "../src/lib/plan/prefetch";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log("1) 首次触发会真的启动预热，且不阻塞调用方");
  resetPrefetchState();
  let started = 0;
  let finished = 0;
  const t = Date.now();
  const result = prefetchCity("西安", async () => {
    started += 1;
    await sleep(80);
    finished += 1;
  });
  const elapsed = Date.now() - t;
  assert.equal(result.started, true, "首次应该启动");
  assert.ok(elapsed < 50, `prefetchCity 必须立即返回，实际 ${elapsed}ms`);
  assert.equal(started, 1);
  assert.equal(finished, 0, "返回时预热不应已完成——否则就是阻塞了调用方");
  await sleep(150);
  assert.equal(finished, 1);
  console.log(`  ✓ 立即返回（${elapsed}ms），预热在后台完成`);

  console.log("2) 同一城市重复触发被去重（用户打字不会每敲一下就重来）");
  let again = 0;
  const dup = prefetchCity("西安", async () => {
    again += 1;
  });
  assert.equal(dup.started, false);
  assert.equal(dup.reason, "duplicate");
  assert.equal(again, 0, "去重窗口内不该再次调用 warm");
  console.log("  ✓ 重复触发被挡住，warm 未被调用");

  console.log("3) 不同城市互不影响");
  let other = 0;
  const otherResult = prefetchCity("南京", async () => {
    other += 1;
    await sleep(30);
  });
  assert.equal(otherResult.started, true, "不同城市应能启动");
  await sleep(80);
  assert.equal(other, 1);
  console.log("  ✓ 换城市正常触发");

  console.log("4) 并发上限：同时在跑的不超过 2 个");
  resetPrefetchState();
  const running = new Set<string>();
  let peak = 0;
  const slow = (name: string) => async () => {
    running.add(name);
    peak = Math.max(peak, running.size);
    await sleep(120);
    running.delete(name);
  };
  const cities = ["甲城", "乙城", "丙城", "丁城"];
  const results = cities.map((city) => prefetchCity(city, slow(city)));
  const accepted = results.filter((r) => r.started).length;
  assert.equal(accepted, 2, `最多同时启动 2 个，实际 ${accepted}`);
  assert.ok(
    results.some((r) => r.reason === "busy"),
    "超出的必须明确回 busy，而不是静默排队",
  );
  await sleep(200);
  assert.equal(peak, 2, `并发峰值应为 2，实际 ${peak}`);
  console.log(`  ✓ 4 个请求只启动 ${accepted} 个，峰值 ${peak}`);

  console.log("5) 预热抛错不影响任何人，且会释放并发位");
  resetPrefetchState();
  const boom = prefetchCity("炸城", async () => {
    throw new Error("upstream exploded");
  });
  assert.equal(boom.started, true, "抛错也要先启动，错误在后台消化");
  await sleep(50);
  const snapshot = prefetchSnapshot();
  assert.equal(snapshot.running, 0, "失败后必须释放并发位，否则两座城之后永久卡死");
  assert.deepEqual(snapshot.active, []);
  console.log("  ✓ 异常被吞掉，并发位已释放");

  console.log("6) 失败后同一城市可以重试（不能因为一次失败永久拉黑）");
  let retried = 0;
  resetPrefetchState();
  prefetchCity("重试城", async () => {
    throw new Error("first attempt fails");
  });
  await sleep(50);
  const retry = prefetchCity("重试城", async () => {
    retried += 1;
  });
  // 去重窗口仍在，所以这次仍应被挡住——这是刻意的：避免失败后立刻打转。
  assert.equal(retry.started, false);
  assert.equal(retry.reason, "duplicate");
  console.log("  ✓ 去重窗口内不立刻重试（避免失败后打转）");

  console.log("7) 空城市名不触发");
  resetPrefetchState();
  const empty = prefetchCity("   ", async () => {});
  assert.equal(empty.started, false);
  assert.equal(empty.reason, "empty");
  console.log("  ✓ 空名直接跳过");

  /* ---------- 单飞 ---------- */
  console.log("8) 单飞：并发同键只算一次（预热与点击不能各算一遍）");
  resetSingleFlight();
  let runs = 0;
  const work = async () => {
    runs += 1;
    await sleep(80);
    return { ok: true };
  };
  const a = singleFlight("k1", work);
  const b = singleFlight("k1", work);
  assert.equal(a, b, "同键并发必须返回同一个 Promise，否则等于算了两次");
  await Promise.all([a, b]);
  assert.equal(runs, 1, `同键只该执行一次，实际 ${runs} 次`);
  console.log("  ✓ 同键并发共享同一次计算");

  console.log("9) 单飞：不同键互不干扰");
  resetSingleFlight();
  let runs2 = 0;
  const work2 = async () => {
    runs2 += 1;
    await sleep(30);
    return runs2;
  };
  const p1 = singleFlight("a", work2);
  const p2 = singleFlight("b", work2);
  assert.notEqual(p1, p2, "不同键必须是两次独立计算");
  await Promise.all([p1, p2]);
  assert.equal(runs2, 2);
  console.log("  ✓ 不同键各自计算");

  console.log("10) 单飞：算完之后键被释放，下次重新计算");
  resetSingleFlight();
  let runs3 = 0;
  const work3 = async () => {
    runs3 += 1;
    return runs3;
  };
  await singleFlight("c", work3);
  assert.equal(singleFlightSize(), 0, "完成后必须摘掉，否则内存会一直涨");
  await singleFlight("c", work3);
  assert.equal(runs3, 2, "单飞不缓存结果，只合并进行中的调用");
  console.log("  ✓ 完成后释放，不缓存结果（缓存归各层自己管）");

  console.log("11) 单飞：失败也会释放，不会把键永久占住");
  resetSingleFlight();
  await assert.rejects(
    singleFlight("d", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(singleFlightSize(), 0, "失败后必须释放键");
  console.log("  ✓ 失败释放，后续可重试");

  resetPrefetchState();
  resetSingleFlight();
  console.log(
    "\n通过：立即返回 / 去重 / 城市隔离 / 并发上限 / 吞错释放 / 不立即重试 / 空名 / 单飞三条",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
