/**
 * 端到端验证「少一轮问」修复：用真实模型跑用户的驻马店序列，
 * 观察每一步 wizardStep 是否按 城市→日期→人数→玩法→节奏→出行→住处→确认 推进。
 * 前置：dev server 在 3131 端口。
 * 跑法：node scripts/e2e-wizard-gate.mjs
 */
const BASE = `http://127.0.0.1:${process.env.PORT ?? "3131"}`;

const today = new Date().toISOString().slice(0, 10);
// 与 makeDraft 一致的初始草稿
let draft = {
  city: { name: "厦门", lat: 24.48, lng: 118.09, address: "福建省厦门市" },
  hotel: { id: "x", name: "厦门市中心", lat: 24.48, lng: 118.09, address: "福建省厦门市", city: "厦门", category: "hotel", source: "demo" },
  hotelUndecided: true,
  days: 3,
  date: today,
  pace: "balanced",
  styles: [],
  experiences: [],
  transport: "auto",
  budgetTier: "comfort",
  adults: 2,
  children: 0,
  seniors: 0,
  avoidSteep: false,
  notes: "",
  selectedPlaces: [],
  confirmed: { city: false, date: false, party: false, style: false, pace: false, transport: false, hotel: false },
};
const messages = [];

const STEPS = ["city", "date", "party", "style", "pace", "transport", "hotel", "confirm"];
function step() {
  return STEPS.find((k) => !draft.confirmed[k]) ?? "confirm";
}

const turns = [
  "驻马店",
  "2026-11-28，玩3天",
  "1个成人",
  "想逛老街古城、古寺、博物馆，吃本地小吃",
  "轻松点，别太赶",
  "坐地铁公交就行",
  "住处还没定，按景点推荐",
];

async function applyPatch(p) {
  if (!p) return;
  Object.assign(draft, p);
  const c = draft.confirmed;
  if (p.city) c.city = true;
  if (p.date !== undefined) c.date = true;
  if (p.adults !== undefined || p.children !== undefined || p.seniors !== undefined) c.party = true;
  if (p.styles !== undefined || p.experiences !== undefined) c.style = true;
  if (p.pace !== undefined) c.pace = true;
  if (p.transport !== undefined) c.transport = true;
  if (p.hotel !== undefined || p.hotelUndecided) c.hotel = true;
}

console.log("初始 step:", step());
for (const text of turns) {
  messages.push({ role: "user", text });
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft, messages: messages.slice(-16) }),
  });
  const data = await res.json();
  if (!data.ai || !data.reply) {
    console.log(`\n[${text}] 模型未接通:`, data.reason);
    break;
  }
  await applyPatch(data.reply.patch);
  messages.push({ role: "assistant", text: data.reply.say });
  const cards = (data.reply.cards ?? []).map((c) => c.kind).join(",");
  console.log(`\n用户: ${text}`);
  console.log(`  模型: ${data.reply.say}`);
  console.log(`  patch: ${JSON.stringify(data.reply.patch ?? {})}`);
  console.log(`  cards: ${cards || "(无)"} | action: ${data.reply.action}`);
  console.log(`  → 下一步: ${step()}  (confirmed: ${JSON.stringify(draft.confirmed)})`);
  if (data.reply.action === "plan") break;
}
console.log("\n最终草稿维度:", JSON.stringify(draft.confirmed));
