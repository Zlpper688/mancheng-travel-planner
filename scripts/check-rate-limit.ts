/**
 * 接口保护回归（npx tsx scripts/check-rate-limit.ts）。
 *
 * 限流是"没感觉"的功能：写错了不会报错，只会在某天被人刷爆额度时才发现。
 * 所以这里把四个不变量钉死：
 *   1. 阈值真的会触发（第 N+1 次被拒，且给出 Retry-After）
 *   2. 不同 IP 互不影响
 *   3. 不同接口互不影响（对话额度低，不能顺带把搜索卡死）
 *   4. 排线接口的老护栏没有被改坏
 */
import { checkRoute, consume, rateLimitResponse } from "../src/lib/rate-limit";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

// 用一个不可能与真实请求撞车的 IP 段，避免污染其它检查脚本的内存计数。
console.log("1) 对话接口：12 次/分");
let allowed = 0;
let deniedAt = -1;
for (let i = 1; i <= 15; i += 1) {
  const decision = checkRoute("chat", "10.99.0.1");
  if (decision.ok) allowed += 1;
  else if (deniedAt < 0) deniedAt = i;
}
ok("放行 12 次", allowed === 12, `实际 ${allowed}`);
ok("第 13 次被拒", deniedAt === 13, `实际 ${deniedAt}`);

console.log("\n2) 拒绝时给出 Retry-After");
const blocked = checkRoute("chat", "10.99.0.1");
ok("不再放行", blocked.ok === false);
if (!blocked.ok) {
  ok("retryAfterSec > 0", blocked.retryAfterSec > 0, String(blocked.retryAfterSec));
  ok("不超过窗口 60s", blocked.retryAfterSec <= 60, String(blocked.retryAfterSec));
  const response = rateLimitResponse(blocked);
  ok("429 响应", response?.status === 429);
  ok("带 Retry-After 头", response?.headers.get("Retry-After") !== null);
}

console.log("\n3) 不同 IP 互不影响");
ok("另一个 IP 仍可放行", checkRoute("chat", "10.99.0.2").ok === true);

console.log("\n4) 不同接口互不影响");
ok("搜索不受对话额度影响", checkRoute("search", "10.99.0.1").ok === true);
ok("图片不受对话额度影响", checkRoute("photo", "10.99.0.1").ok === true);

console.log("\n5) 贵的接口阈值更低");
let catalogAllowed = 0;
for (let i = 0; i < 10; i += 1) {
  if (checkRoute("catalog", "10.99.0.3").ok) catalogAllowed += 1;
}
ok("全城扫描 6 次/分", catalogAllowed === 6, `实际 ${catalogAllowed}`);

console.log("\n6) 通用 consume 的窗口语义");
const first = consume("unit:test", 2, 1000);
const second = consume("unit:test", 2, 1000);
const third = consume("unit:test", 2, 1000);
ok("前两次放行", first.ok && second.ok);
ok("第三次拒绝", third.ok === false);
ok("剩余计数递减", first.remaining === 1 && second.remaining === 0);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：阈值触发 + Retry-After + IP 隔离 + 接口隔离 + 窗口语义");
