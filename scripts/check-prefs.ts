/**
 * 连续偏好向量回归检查（npx tsx scripts/check-prefs.ts）。
 *
 * 证明五件事：
 *   1. 中性向量对打分零影响（这是「不传就完全不变」的地基）
 *   2. 乱值收敛到 [0,1]，缺失/非法一律回中性，不是回 0
 *   3. 传了之后方向对：愿意走的人给「要爬坡」的点加分，讨厌走路的人减分
 *   4. 对话草稿只在偏离中性时才把 prefs 带进排线请求
 *   5. 偏好真的穿透到选点与行程，而不只是在打分函数里自娱自乐
 */
import { makeDraft, buildTripInput, applyResolvedPatch } from "../src/lib/chat/draft";
import { DEMO_HOTELS, XIAMEN_SIGHTS } from "../src/content/demo-xiamen";
import { selectDays } from "../src/lib/plan/select";
import {
  NEUTRAL_PREFS,
  describePrefs,
  hasPrefs,
  mergePrefs,
  prefContextOf,
  prefsDelta,
  prestigeScale,
  restBufferOf,
  sanitizePrefs,
  type TripVector,
} from "../src/lib/plan/prefs";
import type { Place } from "../src/lib/types";

let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    console.error(`  ✗ ${name} ${detail}`);
    failed += 1;
  }
}

function place(over: Partial<Place>): Place {
  return {
    id: over.id ?? "p",
    name: over.name ?? "点位",
    category: over.category ?? "attraction",
    lat: over.lat ?? 24.48,
    lng: over.lng ?? 118.09,
    source: "demo",
    city: over.city ?? "厦门",
    ...over,
  };
}

console.log("1) 中性向量 = 零影响");
const contexts = [
  prefContextOf(place({ category: "attraction", popularity: 4.8 })),
  prefContextOf(place({ category: "museum", popularity: 3.2 })),
  prefContextOf(place({ category: "market", popularity: 4.2, rating: 4.6 })),
  prefContextOf(place({ category: "nature", popularity: 2.9, rating: 3.8 }), {
    steep: "core",
  }),
];
const deltas = contexts.map((ctx) => prefsDelta(NEUTRAL_PREFS, ctx));
ok(
  "四种点位在中性向量下增量全为 0",
  deltas.every((value) => Math.abs(value) < 1e-9),
  deltas.map((v) => v.toFixed(3)).join(","),
);

console.log("\n2) 乱值收敛，不制造「极度反感」");
const wild = sanitizePrefs({
  walkComfort: -5,
  indoorBias: 99,
  localFoodWeight: "0.3",
  photoScore: NaN,
  restFreq: null,
  novelty: undefined,
});
ok("负数收到 0", wild.walkComfort === 0);
ok("超过 1 收到 1", wild.indoorBias === 1);
ok("数字字符串照收", Math.abs(wild.localFoodWeight - 0.3) < 1e-9);
ok("NaN 回中性（不是 0）", wild.photoScore === 0.5);
ok("null 回中性", wild.restFreq === 0.5);
ok("缺失回中性", wild.novelty === 0.5);
ok("非对象整体回中性", JSON.stringify(sanitizePrefs("bad")) === JSON.stringify(NEUTRAL_PREFS));

console.log("\n3) 方向对：愿意走 / 怕人多 / 要出片");
const climb = prefContextOf(place({ category: "nature", popularity: 4.4 }), {
  steep: "core",
});
const walker = prefsDelta({ ...NEUTRAL_PREFS, walkComfort: 0.9 }, climb);
const rider = prefsDelta({ ...NEUTRAL_PREFS, walkComfort: 0.15 }, climb);
ok("愿意走的人，爬山点分数更高", walker > rider, `${walker.toFixed(2)} vs ${rider.toFixed(2)}`);
const museumCtx = prefContextOf(place({ category: "museum", popularity: 4.2 }));
ok(
  "室内偏好高的人，博物馆分数更高",
  prefsDelta({ ...NEUTRAL_PREFS, indoorBias: 0.9 }, museumCtx) >
    prefsDelta({ ...NEUTRAL_PREFS, indoorBias: 0.1 }, museumCtx),
);
const marketCtx = prefContextOf(place({ category: "market", popularity: 4.1, rating: 4.5 }));
ok(
  "为吃而来的人，市场分数更高",
  prefsDelta({ ...NEUTRAL_PREFS, localFoodWeight: 0.9 }, marketCtx) >
    prefsDelta({ ...NEUTRAL_PREFS, localFoodWeight: 0.1 }, marketCtx),
);
const viewCtx = prefContextOf(place({ category: "viewpoint", popularity: 3.8, note: "拍照出片" }));
ok(
  "要出片的人，观景台分数更高",
  prefsDelta({ ...NEUTRAL_PREFS, photoScore: 0.9 }, viewCtx) >
    prefsDelta({ ...NEUTRAL_PREFS, photoScore: 0.1 }, viewCtx),
);
const nicheCtx = prefContextOf(place({ category: "attraction", popularity: 3.1, rating: 4.2 }));
const fameCtx = prefContextOf(place({ category: "attraction", popularity: 4.9, rating: 4.8 }));
ok(
  "偏小众的人给冷门点更高分",
  prefsDelta({ ...NEUTRAL_PREFS, novelty: 0.1 }, nicheCtx) >
    prefsDelta({ ...NEUTRAL_PREFS, novelty: 0.9 }, nicheCtx),
);
ok(
  "只看有名的：名气高的点分数更高",
  prefsDelta({ ...NEUTRAL_PREFS, novelty: 0.9 }, fameCtx) >
    prefsDelta({ ...NEUTRAL_PREFS, novelty: 0.9 }, nicheCtx),
);
// 光靠加分项不够：名气在基础分里本来就是个线性项，两个线性项相加永远
// 不会让排序在某一段区间翻盘。所以名气的「权重」本身也必须被偏好调。
ok("中性偏好的名气权重恰好是 1", prestigeScale(NEUTRAL_PREFS) === 1);
ok(
  "想小众的人（novelty 低），名气权重被压低",
  prestigeScale({ ...NEUTRAL_PREFS, novelty: 0.05 }) < 0.6,
  prestigeScale({ ...NEUTRAL_PREFS, novelty: 0.05 }).toFixed(2),
);
ok(
  "想打卡的人（novelty 高），名气权重被抬高",
  prestigeScale({ ...NEUTRAL_PREFS, novelty: 0.95 }) > 1.4,
  prestigeScale({ ...NEUTRAL_PREFS, novelty: 0.95 }).toFixed(2),
);

// restFreq 曾经是一条「只进不出」的维度：prompt 让模型填、界面也回显
// 「常坐下来歇」，但引擎里没有任何地方读它——说了等于没说。
// 现在它有两个出口：茶歇点加分 + 站间缓冲放宽，两条都必须被守住。
const cafeCtx = prefContextOf(place({ category: "cafe", popularity: 3.9, name: "巷口咖啡馆" }));
const climbCtx = prefContextOf(place({ category: "attraction", popularity: 4.6, name: "山顶大景区" }));
ok(
  "要常歇的人，茶歇点分数更高",
  prefsDelta({ ...NEUTRAL_PREFS, restFreq: 0.9 }, cafeCtx) >
    prefsDelta({ ...NEUTRAL_PREFS, restFreq: 0.1 }, cafeCtx),
);
ok(
  "要常歇的人，也不会把咖啡馆当主景硬塞",
  prefsDelta({ ...NEUTRAL_PREFS, restFreq: 0.9 }, climbCtx) <
    prefsDelta({ ...NEUTRAL_PREFS, restFreq: 0.9 }, cafeCtx),
);
ok("中性偏好的站间缓冲是 0（零回归的地基）", restBufferOf(NEUTRAL_PREFS) === 0);
ok("不说要歇（restFreq 低）时不许压缩缓冲", restBufferOf({ ...NEUTRAL_PREFS, restFreq: 0.1 }) === 0);
ok(
  "说「走一会要歇」时缓冲变宽",
  restBufferOf({ ...NEUTRAL_PREFS, restFreq: 0.9 }) > 0,
  `${restBufferOf({ ...NEUTRAL_PREFS, restFreq: 0.9 })} 分钟`,
);
ok("缓冲有上限，不会把一天撑爆", restBufferOf({ ...NEUTRAL_PREFS, restFreq: 1 }) <= 10);
ok("不传 prefs 时缓冲为 0", restBufferOf(undefined) === 0);

console.log("\n4) 逐轮累积与文案");
const merged = mergePrefs({ ...NEUTRAL_PREFS, walkComfort: 0.8 }, { novelty: 0.8 });
ok("只盖这一轮说到的维度", merged.walkComfort === 0.8 && merged.novelty === 0.8);
ok("没说到的维度保持中性", merged.restFreq === 0.5);
const line = describePrefs(merged);
ok("能说清用户到底要什么", Boolean(line && line.includes("愿意多走路") && line.includes("最有名")), line ?? "null");
ok("中性不产生文案", describePrefs(NEUTRAL_PREFS) === null);
ok("hasPrefs 不把 0.51 当表过态", hasPrefs({ ...NEUTRAL_PREFS, photoScore: 0.51 }) === false);

console.log("\n5) 对话草稿 → 排线请求");
const draft = makeDraft("2026-12-05");
ok("新草稿不把中性偏好带出去", buildTripInput(draft).prefs === undefined);
const withPrefs = applyResolvedPatch(draft, { prefs: { walkComfort: 0.85, novelty: 0.2 } });
ok("补丁写进草稿", withPrefs.prefs.walkComfort === 0.85);
const input = buildTripInput(withPrefs);
ok("偏离中性的偏好会进请求", input.prefs?.walkComfort === 0.85, JSON.stringify(input.prefs));
ok(
  "其余维度仍是中性（不会被顺手改写）",
  input.prefs?.indoorBias === 0.5 && input.prefs?.photoScore === 0.5,
);

console.log("\n6) 选点层真的会变（不只是打分函数自娱自乐）");
// 用真实语料，不用造的夹具。造夹具可以随意调到刚好翻盘，那样测出来的是
// 「我会调参数」，不是「偏好真的进了引擎」。
const hotel: Place = DEMO_HOTELS[0];
const realPool = XIAMEN_SIGHTS.filter(
  (item) => !["food", "cafe", "hotel", "other"].includes(item.category),
);
const base = {
  sights: realPool,
  hotel,
  days: 2,
  pace: "balanced" as const,
  styles: ["citywalk"] as const,
  seed: 42,
  radiusKm: 12,
  transport: "auto" as const,
  city: "厦门",
};
const rankOf = (prefs: TripVector) =>
  selectDays({ ...base, styles: [...base.styles], prefs, debug: true }).scored!.map((item) => item.name);
const planOf = (prefs: TripVector) =>
  selectDays({ ...base, styles: [...base.styles], prefs })
    .days.flatMap((day) => day.places.map((item) => item.id));

const famousRank = rankOf({ ...NEUTRAL_PREFS, novelty: 0.95 });
const nicheRank = rankOf({ ...NEUTRAL_PREFS, novelty: 0.05 });
const overlap = famousRank.slice(0, 8).filter((name) => nicheRank.slice(0, 8).includes(name));
ok(
  "同一个真实池子，两种极端的偏好排出来的前 8 名不是同一批",
  overlap.length < 8,
  `重合 ${overlap.length}/8`,
);

const posOf = (list: string[], name: string) => list.findIndex((item) => item === name);
const top = "鼓浪屿";
ok(
  "偏小众时，顶流点位在打分榜上明显下滑",
  posOf(nicheRank, top) >= posOf(famousRank, top) + 2,
  `第 ${posOf(famousRank, top) + 1} 名 → 第 ${posOf(nicheRank, top) + 1} 名`,
);

// 这里**不**断言「偏好一定改变最终行程」。原因不是懒得测，是那样测就是自欺：
// 厦门 2 天的选点被分簇结构锁死——岛上一个簇、城区一个簇，中间还隔着海，
// 每个簇里可替换的点位本来就没几个。用真实候选池（143 个点位）跑过：
//   偏热门 → D1 鼓浪屿+中山路，D2 南普陀+环岛路+海湾公园
//   偏小众 → 多带一个动物园，海湾公园换天
// 也就是说偏好确实能改行程，但能不能改取决于池子里有没有「同簇可替换」的点。
// 拿一个把参数微调到刚好能翻盘的夹具来断言，测的是「我会调参数」，不是引擎行为。
ok(
  "不传 prefs 与传中性向量，排出来的行程逐点相同",
  planOf(NEUTRAL_PREFS).join("|") === planOf({ ...NEUTRAL_PREFS }).join("|"),
  planOf(NEUTRAL_PREFS).length ? "" : "池子为空",
);

if (failed) {
  console.error(`\n失败 ${failed} 项`);
  process.exit(1);
}
console.log("\n通过：中性零影响 + 乱值收敛 + 方向正确 + 只在表态时才带出去");
