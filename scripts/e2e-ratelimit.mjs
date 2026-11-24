// 限流与额度护栏的 HTTP 级验证。不消耗高德配额：
// 排线用非法 body（在 sanitize 阶段就被拒），搜索用空关键词（直接返回空数组）。
const BASE = "http://127.0.0.1:3000";

async function planOnce(headers = {}, body = "{}") {
  const res = await fetch(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, retryAfter: res.headers.get("retry-after"), data };
}

async function searchOnce(headers = {}) {
  const res = await fetch(`${BASE}/api/search?q=`, { headers });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, retryAfter: res.headers.get("retry-after"), data };
}

let failed = 0;
function check(ok, label) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed += 1;
}

// ---------- 1. 排线接口：突发上限 ----------
// 每轮换一个假 IP，避免上一轮窗口还没过导致计数不准。
const octet = 10 + Math.floor(Math.random() * 200);
const attacker = { "x-forwarded-for": `203.0.113.${octet}` };
const planResults = [];
for (let i = 0; i < 22; i += 1) {
  planResults.push(await planOnce(attacker));
}
const plan429 = planResults.filter((item) => item.status === 429);
check(
  planResults.slice(0, 20).every((item) => item.status !== 429) &&
    plan429.length === 2,
  `前 20 次放行、之后开始限流（22 次里 429 出现 ${plan429.length} 次）`,
);
check(
  plan429[0]?.retryAfter !== null && Number(plan429[0]?.retryAfter) > 0,
  `429 带 Retry-After: ${plan429[0]?.retryAfter}`,
);
check(
  plan429[0]?.data?.code === "RATE_LIMITED",
  `429 返回 code=RATE_LIMITED（实际 ${plan429[0]?.data?.code}）`,
);
check(
  planResults[0]?.status === 400,
  `被限流前返回的是业务错误而非限流（首个状态 ${planResults[0]?.status}）`,
);

// ---------- 2. 换一个 IP 应该不受影响 ----------
const other = await planOnce({ "x-forwarded-for": `198.51.100.${octet}` });
check(other.status !== 429, `另一个 IP 未被连带限流（状态 ${other.status}）`);

// ---------- 3. 搜索接口：更宽的突发上限 ----------
const searchResults = [];
for (let i = 0; i < 92; i += 1) {
  searchResults.push(await searchOnce(attacker));
}
const search429 = searchResults.filter((item) => item.status === 429);
check(search429.length === 2, `搜索 90 次/分后开始限流（92 次里 429 出现 ${search429.length} 次）`);
check(
  search429[0]?.data?.results?.length === 0,
  "限流响应仍是合法结构（results: []），前端不会崩",
);

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`);
process.exit(failed === 0 ? 0 : 1);
