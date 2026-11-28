/**
 * 旅行记录闭环回归（npx tsx scripts/check-journal.ts）。
 * 只测纯函数：快照生成、分享文本、配方往返。
 */
import { journalFromPlan, formatJournalText, saveJournal, loadJournals, deleteJournal, updateJournalNote, type TripJournal } from "../src/lib/journal";
import { encodeRecipe, decodeRecipe, type TripRecipe } from "../src/lib/share";
import type { PlanResult } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

const recipe: TripRecipe = {
  city: { name: "成都", lng: 104.066, lat: 30.657, address: "四川省成都市" },
  hotel: { id: "h1", name: "春熙路一带", category: "hotel", lat: 30.6555, lng: 104.0772, source: "demo" },
  days: 2,
  date: "2026-12-01",
  pace: "balanced",
  styles: ["citywalk"],
  transport: "auto",
  budgetTier: "comfort",
  adults: 2,
  children: 0,
  seed: 42,
  farDays: null,
};

const fakePlan = {
  meta: {
    city: "成都",
    title: "成都 2 日 · 城区慢逛",
    subtitle: "",
    startDate: "2026-12-01",
    endDate: "2026-12-02",
    days: 2,
    travelers: 2,
    source: "open",
    sourceNote: "",
    dataNotes: [],
    isFixed: false,
    generatedAt: "2026-11-26T10:00:00.000Z",
  },
  days: [
    {
      index: 1,
      date: "2026-12-01",
      theme: "老城",
      area: "青羊区",
      color: "#2f6a52",
      stops: [
        {
          id: "s1",
          place: { id: "p1", name: "宽窄巷子", category: "street", lat: 30.66, lng: 104.05, source: "demo" },
          kind: "sight",
          order: 0,
          startMin: 9 * 60 + 30,
          endMin: 11 * 60,
          dwellMin: 90,
        },
        {
          id: "s2",
          place: { id: "p2", name: "午饭 · 奎星楼街", category: "food", lat: 30.66, lng: 104.05, source: "demo" },
          kind: "meal",
          order: 1,
          startMin: 12 * 60,
          endMin: 13 * 60,
          dwellMin: 60,
        },
      ],
      legs: [],
      stats: { stopCount: 2, sightCount: 1, distanceKm: 8.4, travelMin: 30, walkKm: 3, ticket: 0 },
      startMin: 570,
      endMin: 780,
      tip: "",
    },
    {
      index: 2,
      date: "2026-12-02",
      theme: "自由",
      area: "锦江区",
      color: "#c15a36",
      stops: [],
      legs: [],
      stats: { stopCount: 0, sightCount: 0, distanceKm: 0, travelMin: 0, walkKm: 0, ticket: 0 },
      startMin: 570,
      endMin: 900,
      tip: "",
    },
  ],
  budget: {
    totalMin: 1200,
    totalMax: 1800,
    perPersonMin: 600,
    perPersonMax: 900,
    travelers: 2,
    items: [],
  },
  warnings: [],
} as unknown as PlanResult;

console.log("1) 自动归档（不需要用户填表）");
const journal = journalFromPlan(fakePlan, encodeRecipe(recipe));
ok("有 id", Boolean(journal.id));
ok("标题来自计划", journal.title === "成都 2 日 · 城区慢逛");
ok("天数", journal.days === 2);
ok("人数", journal.travelers === 2);
ok("每天都有快照", journal.daySnapshots.length === 2);
ok("第一天 2 条停靠", journal.daySnapshots[0].stops.length === 2);
ok("停靠时间格式化", /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(journal.daySnapshots[0].stops[0].time), journal.daySnapshots[0].stops[0].time);
ok("第二天为空（自由活动）", journal.daySnapshots[1].stops.length === 0);
ok("预算带上", journal.budget.totalMin === 1200);
ok("note 可选未填", journal.note === undefined);

console.log("\n2) 分享文本（粘进微信能看懂）");
const text = formatJournalText(journal, "https://example.com/?q=成都");
ok("含标题", text.includes("成都 2 日"));
ok("含天数人数", text.includes("2 天") && text.includes("2 人"));
ok("含第一天景点", text.includes("宽窄巷子"));
ok("餐食不算景点", !text.split("Day 1")[1].split("Day 2")[0].includes("午饭 · 奎星楼街"));
ok("空天写自由活动", text.includes("自由活动"));
ok("含花费", text.includes("1,200"));
ok("含同款链接", text.includes("同款玩法：https://example.com"));

console.log("\n3) 一键导入同款（配方往返）");
const encoded = encodeRecipe(recipe);
const decoded = decodeRecipe(`?${encoded}`, recipe);
ok("能解回", Boolean(decoded));
ok("城市还原", decoded?.city.name === "成都");
ok("天数还原", decoded?.days === 2);
ok("节奏还原", decoded?.pace === "balanced");
ok("种子还原（同款关键）", decoded?.seed === 42);
ok("落点还原", decoded?.hotel.name === "春熙路一带");

console.log("\n4) 本地存储：保存/去重/删除/改感受");
// 用最小 localStorage mock 跑真实的存储函数（不需要 jsdom）
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  },
};

ok("初始为空", loadJournals().length === 0);
saveJournal(journal);
ok("保存成功", loadJournals().length === 1);
// savedAt 必须比上一条「真的大」，不能写死一个时间：
// 原来这里硬编码 2026-11-27T10:00Z，UTC 上午跑是「更晚」，下午跑就变成「更早」，
// 于是这个断言每天只在半天内通过。改成基于上一条记录往后推一分钟。
const previousSavedAt = loadJournals()[0]?.savedAt ?? new Date().toISOString();
const second: TripJournal = {
  ...journal,
  id: "j-second",
  title: "成都 3 日 · 另一版",
  // 不能写死日期：写死的时刻一旦早于实际运行时刻，倒序断言就会反转（曾踩坑）。
  // 也不能只靠 Date.now()：上一条记录若本身更晚，仍会反转。
  // 因此统一「以上一条 savedAt 为基准往后推一分钟」，两边意图合并到这里。
  savedAt: new Date(Date.parse(previousSavedAt) + 60_000).toISOString(),
};
saveJournal(second);
ok("两条记录", loadJournals().length === 2);
ok("按保存时间倒序（新的在前）", loadJournals()[0].title.includes("3 日"));
// 同城同日同名再保存应覆盖，不是又加一条
saveJournal({ ...journal, id: "j-dup", note: "覆盖测试" });
const afterDup = loadJournals();
ok("同城同日同名去重", afterDup.length === 2, `实际 ${afterDup.length}`);
ok("覆盖后内容更新", afterDup.some((j) => j.note === "覆盖测试"));
const updated = updateJournalNote("j-second", "这条不错");
ok("改感受生效", updated.find((j) => j.id === "j-second")?.note === "这条不错");
ok("删除生效", deleteJournal("j-second").length === 1);
ok("删完只剩一条", loadJournals().length === 1);

console.log("\n5) 坏链接不崩");
ok("空串返回 null", decodeRecipe("", recipe) === null);
ok("乱参数回退默认", decodeRecipe("?q=&d=999&sd=abc", recipe) === null || (decodeRecipe("?q=&d=999&sd=abc", recipe)?.days ?? 2) <= 15);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：自动归档 + 分享文本 + 配方往返 + 坏链接兜底");
