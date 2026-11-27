/**
 * 服务端草稿规范化对抗性审查 —— 前后端状态漂移是「逻辑混乱」的重灾区：
 * 前端传来的枚举值/开关若没被安全恢复，服务端会拿默认值生成自相矛盾的对话。
 *
 * 跑法：npx tsx scripts/check-safe-draft.ts
 */
import { safeDraft } from "../src/lib/chat/safe-draft";

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

console.log("1) 用户实际选过的枚举值必须保留（核心 bug）");
const chosen = safeDraft({
  pace: "chill",
  transport: "transit",
  budgetTier: "premium",
  hotelUndecided: false,
  confirmed: { pace: true, transport: true, hotel: true },
});
ok("节奏 chill 被保留", chosen.pace === "chill", chosen.pace);
ok("交通 transit 被保留", chosen.transport === "transit", chosen.transport);
ok("预算 premium 被保留", chosen.budgetTier === "premium", chosen.budgetTier);
ok("已定酒店状态 false 被保留", chosen.hotelUndecided === false);
ok("confirmed 同步恢复", chosen.confirmed.pace && chosen.confirmed.transport && chosen.confirmed.hotel);

console.log("2) 恶意/乱值收敛到默认，不污染模型上下文");
const junk = safeDraft({
  pace: "光速",
  transport: "火箭",
  budgetTier: "无敌",
  days: 999,
  adults: -5,
  lat: "NaN",
  confirmed: { city: "yes", date: 1 },
});
ok("非法 pace 回默认", junk.pace === "balanced", junk.pace);
ok("非法 transport 回默认", junk.transport === "auto", junk.transport);
ok("非法 budget 回默认", junk.budgetTier === "comfort", junk.budgetTier);
ok("days 收敛到 10", junk.days === 10, String(junk.days));
ok("adults 收敛到 0", junk.adults === 0, String(junk.adults));
ok("非法坐标回默认", Number.isFinite(junk.city.lat), String(junk.city.lat));
ok("confirmed 只认 true，不认 'yes'/1", !junk.confirmed.city && !junk.confirmed.date);

console.log("3) 边界：空输入 / null / 非对象");
ok("null 回安全草稿", safeDraft(null).confirmed.city === false);
ok("字符串回安全草稿", safeDraft("hack").city.name.length > 0);
ok("空对象回安全草稿", safeDraft({}).hotelUndecided === true);

console.log("4) 数组字段长度与类型收敛");
const arrays = safeDraft({
  styles: ["citywalk", "foodie", "culture", "coastal", 123],
  experiences: ["food", "museum", "night", "sunset", "sunrise", null],
  selectedPlaces: [null, "x", { id: "p1", name: "测试点" }],
});
ok("styles 截断到 3 且过滤非字符串", arrays.styles.length === 3 && arrays.styles.every((s) => typeof s === "string"), JSON.stringify(arrays.styles));
ok("experiences 截断到 4", arrays.experiences.length === 4, JSON.stringify(arrays.experiences));
ok("selectedPlaces 过滤脏数据", arrays.selectedPlaces.length === 1 && arrays.selectedPlaces[0].name === "测试点", JSON.stringify(arrays.selectedPlaces));

console.log("5) 字符串字段超长截断（防提示词注入膨胀）");
const clipped = safeDraft({
  city: { name: "x".repeat(200) },
  notes: "n".repeat(1000),
});
ok("城市名截断到 30", clipped.city.name.length === 30, String(clipped.city.name.length));
ok("备注截断到 200", clipped.notes.length === 200, String(clipped.notes.length));

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
