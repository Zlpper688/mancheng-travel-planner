/**
 * 连续偏好向量 —— 把「骑行爱好者 / 喜欢人少的地方 / 要给孩子拍照」这类
 * 枚举表达不了的话，变成引擎能算的数。
 *
 * 为什么要另起一层，而不是再加几个 StyleId：
 *   styles 是 6 个互斥主题（citywalk / classic / coastal …），它回答「这趟玩什么」；
 *   但「愿不愿意走 8 公里」「怕不怕人多」「要不要每两小时坐一次」不是主题，
 *   是程度。硬塞进枚举，只会得到 14×14 的组合爆炸和一堆「近似映射」。
 *
 * 设计约定（与 params.ts 同一套纪律）：
 *   1. 每一项都是 0~1，0.5 = 中性。所有打分项都写成 (x - 0.5) 的形式，
 *      因此「不传向量」时每一项都乘 0，选点结果与以前逐字节一致。
 *   2. 只影响打分与排线代价，绝不碰硬约束（日期/人数/必去点/锁定点）。
 *   3. LLM 只负责把自然语言填成这 6 个数；怎么用是引擎的事，LLM 不参与排线。
 */
import type { Place } from "../types";

export interface TripVector {
  /** 对步行的接受度：高 = 愿意走、愿意骑车穿城；低 = 能坐车就不走。 */
  walkComfort: number;
  /** 室内偏好：高 = 雨天/暴晒也想待在馆里；低 = 宁可在外头吹风。 */
  indoorBias: number;
  /** 本地小吃优先级：高 = 为吃而来，市场/小吃街权重抬起来。 */
  localFoodWeight: number;
  /** 拍照打卡优先级：高 = 出片点优先。 */
  photoScore: number;
  /** 休息频率：高 = 每两小时要坐下一次（影响茶歇插入与停留节奏）。 */
  restFreq: number;
  /**
   * 网红度：高 = 就要去最有名的那几个；低 = 专找人少的冷门。
   *
   * 方向按方案原文：字段叫 novelty，但取值表达的是「网红/小众偏好」，
   * 示例给的也是「喜欢人少的地方 → 0.2」。所以 0 端是小众，1 端是打卡。
   */
  novelty: number;
}

export const NEUTRAL_PREFS: TripVector = {
  walkComfort: 0.5,
  indoorBias: 0.5,
  localFoodWeight: 0.5,
  photoScore: 0.5,
  restFreq: 0.5,
  novelty: 0.5,
};

export const PREF_KEYS: (keyof TripVector)[] = [
  "walkComfort",
  "indoorBias",
  "localFoodWeight",
  "photoScore",
  "restFreq",
  "novelty",
];

export const PREF_LABELS: Record<keyof TripVector, string> = {
  walkComfort: "步行接受度",
  indoorBias: "室内偏好",
  localFoodWeight: "本地小吃",
  photoScore: "拍照优先",
  restFreq: "休息频率",
  novelty: "网红偏好",
};

function unit(value: unknown, fallback = 0.5): number {
  // null 会被 Number() 变成 0，那是「极度反感」，不是「没表态」。
  if (value === null || value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * 把可能是 LLM 输出的松散对象收敛成安全的向量。
 * 非法/缺失一律 0.5（中性），不是 0——0 是「极度反感」，会把这一类点位全压死。
 */
export function sanitizePrefs(raw: unknown): TripVector {
  if (!raw || typeof raw !== "object") return { ...NEUTRAL_PREFS };
  const r = raw as Record<string, unknown>;
  return {
    walkComfort: unit(r.walkComfort),
    indoorBias: unit(r.indoorBias),
    localFoodWeight: unit(r.localFoodWeight),
    photoScore: unit(r.photoScore),
    restFreq: unit(r.restFreq),
    novelty: unit(r.novelty),
  };
}

/** 草稿里逐轮累积：这一轮说了哪几维就盖哪几维，其余沿用上一轮。 */
export function mergePrefs(
  base: TripVector | undefined,
  patch: unknown,
): TripVector {
  const current = base ?? NEUTRAL_PREFS;
  if (!patch || typeof patch !== "object") return { ...current };
  const r = patch as Record<string, unknown>;
  const next: TripVector = { ...current };
  for (const key of PREF_KEYS) {
    if (r[key] !== undefined) next[key] = unit(r[key], current[key]);
  }
  return next;
}

/** 偏离中性超过 0.04 才算「用户表过态」，避免 LLM 顺手写 0.51 也触发文案。 */
export function hasPrefs(prefs?: TripVector | null): boolean {
  if (!prefs) return false;
  return PREF_KEYS.some((key) => Math.abs(prefs[key] - 0.5) > 0.04);
}

/**
 * 一句话说清引擎到底收到了什么。
 * 不是装饰：没有这句，用户永远不知道「骑行」有没有被听进去。
 */
export function describePrefs(prefs?: TripVector | null): string | null {
  if (!hasPrefs(prefs) || !prefs) return null;
  const parts: string[] = [];
  if (prefs.walkComfort >= 0.66) parts.push("愿意多走路");
  else if (prefs.walkComfort <= 0.34) parts.push("尽量少走路");
  if (prefs.indoorBias >= 0.66) parts.push("偏好室内");
  else if (prefs.indoorBias <= 0.34) parts.push("多在户外");
  if (prefs.localFoodWeight >= 0.66) parts.push("以本地小吃为主");
  if (prefs.photoScore >= 0.66) parts.push("优先出片点");
  if (prefs.restFreq >= 0.66) parts.push("常坐下来歇");
  if (prefs.novelty >= 0.66) parts.push("先看最有名的");
  else if (prefs.novelty <= 0.34) parts.push("偏小众，不挤热门");
  if (!parts.length) return null;
  return `按你的偏好：${parts.join(" · ")}。`;
}

/**
 * 名气权重：不是又一个加分项，而是「名气这个词本身值多少分」。
 *
 * 为什么必须是权重而不是加分（这条踩过坑）：
 *   早先我把它写成 `fameTerm = (0.5 - novelty) * 0.7 * (popularity - 3.6)`。
 *   但基础分里名气本身也是线性的（`popularity * 2`），两个线性项相加，
 *   斜率的正负号对整池点位是同一个值——要么全体按名气正序，要么全体反序，
 *   永远不可能只在某段区间里翻盘。实测厦门 40 个点位，novelty 从 0.05 拉到 0.95，
 *   排出来的两天一个点都没变，用户说「我偏小众」等于没说。
 *
 * 现在的做法：把名气的权重交给偏好去调。
 *   想打卡（novelty 高）→ 名气权重抬到 1.56，就是要最有名的那几个；
 *   想小众（novelty 低）→ 压到 0.44，名气不再是决定项，口碑/脚力/出片/顺路才有发言权；
 *   中性 → 恰好 1.0，与旧行为逐字节一致。
 *
 * 注意这里不动 qualityPenalty：名气低到 4.05 以下仍然要扣分。
 * 那条是「别拿冷门当借口排烂点」的地板，不该被偏好撬开。
 */
export function prestigeScale(prefs: TripVector): number {
  const lean = prefs.novelty - 0.5; // 正 = 偏网红
  // 斜率 1.25：novelty=0.95 → 1.56，novelty=0.05 → 0.44，两端都不过火。
  return Math.min(1.6, Math.max(0.36, 1 + lean * 1.25));
}

/** 打分上下文：由调用方从 Place 算好，prefs 本身不碰业务数据。 */
export interface PrefContext {
  /** 这一点要花多少脚力：0 = 下车即到，1 = 整段爬坡/长距离步行。 */
  walkBurden: number;
  /** 室内程度（博物馆/展馆为真）。 */
  indoor: boolean;
  /** 以吃为主（市场 / 小吃街 / 餐馆）。 */
  foodLed: boolean;
  /** 出片程度：0~1。 */
  photoWorthy: number;
  /** 名气：0~5（没有评分时按 3.4）。 */
  popularity: number;
  /** 小众程度：越冷门越高，0~1。 */
  niche: number;
  /** 能不能坐下来歇（咖啡馆、茶馆、能久坐的餐馆）。 */
  restful: boolean;
}

/**
 * 偏好向量对选点分的增量。
 *
 * 关键约束：每一项都乘 (prefs - 0.5)，中性向量下恒等于 0。
 * 因此这条链路可以随时关掉（不传 prefs），而不产生任何行为差异。
 */
export function prefsDelta(prefs: TripVector, ctx: PrefContext): number {
  const walk = prefs.walkComfort - 0.5;
  const indoor = prefs.indoorBias - 0.5;
  const food = prefs.localFoodWeight - 0.5;
  const photo = prefs.photoScore - 0.5;
  const novelty = prefs.novelty - 0.5;

  // 脚力只作用在「需要走路的点」上：不费脚的点位，走不走得动都无所谓。
  // 打分是「越高越好」，所以高 walkComfort 对耗脚点位是加分，低则减分。
  // 系数 1.6：这是六维里最容易让用户当场感觉到的一项，给足权重。
  const walkTerm = walk * ctx.walkBurden * 1.6;

  const indoorTerm = indoor * (ctx.indoor ? 1.5 : -0.45);
  const foodTerm = food * (ctx.foodLed ? 1.6 : -0.15);
  const photoTerm = photo * (ctx.photoWorthy * 1.7 - 0.35);

  // 名气与小众拆成两件事，别混成一个：
  //   名气的「权重」由 prestigeScale 在 scorePlace 里调（想小众就把名气看淡）；
  //   这里只补一项「低调但真有口碑」的加分——它给的是方向，不是权重。
  // 没有这一项，把名气权重压下去之后，池子里剩下的点位由谁胜出会变得随机。
  // 注意符号：novelty 高 = 偏网红，所以小众加分要取负。
  const nicheTerm = -novelty * 1.9 * ctx.niche;

  // 休息频率：需要常歇的人，茶歇点本身就是行程的一部分，不是「浪费时间」；
  // 反过来，走一天不累的人，把下午整块塞进咖啡馆是亏的。
  // 这一项之前漏了——prompt 让模型填 restFreq、界面也回显「常坐下来歇」，
  // 但引擎里没有任何地方读它，等于说了不做。
  const restTerm = (prefs.restFreq - 0.5) * (ctx.restful ? 1.4 : -0.25);

  return walkTerm + indoorTerm + foodTerm + photoTerm + nicheTerm + restTerm;
}

/**
 * 休息需求换算成「每站之后多留几分钟」。
 *
 * 不直接用 restFreq 去缩放停留（那会把博物馆逛成两小时），
 * 因为缓冲是两件事的交集：找座位、上厕所、慢慢走。给的是余量，不是景点时间。
 * 中性为 0，保证不传偏好时零回归；只有明确说「走一会要歇」才加。
 */
export function restBufferOf(prefs?: TripVector | null): number {
  if (!prefs) return 0;
  const lean = prefs.restFreq - 0.5;
  if (lean <= 0) return 0;
  // restFreq 1.0 → 8 分钟。再长就不是「缓冲」，是给每个点加了半小时。
  return Math.round(lean * 16);
}

/**
 * 从 Place 提取打分上下文。
 *
 * 这里刻意只用手上真有的信号（类别、标签、评分、是否室内），
 * 不做「语义猜测」——猜错一个点，用户看到的就是「明明说想拍照，却排了个停车场」。
 */
export function prefContextOf(
  place: Place,
  opts: { steep?: "core" | "soft" | null } = {},
): PrefContext {
  const text = `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")}`;
  const indoor = place.category === "museum";
  const foodLed =
    place.category === "market" ||
    place.category === "food" ||
    /小吃|夜市|菜市场|美食街/.test(text);
  const photoWorthy = /拍照|出片|观景|机位|夜景|打卡/.test(text)
    ? 0.9
    : place.category === "viewpoint"
      ? 0.8
      : place.category === "beach"
        ? 0.7
        : place.category === "street"
          ? 0.4
          : 0.2;
  const popularity = place.popularity ?? 3.4;
  // 小众：名气低 + 有评分（说明真有人去过，不是空壳 POI）。
  // 分母 1.6 是按真实语料定的：厦门这批点位名气集中在 3.4~5.0，
  // 旧公式拿 4.3 当零点，导致 4.3 以上一律算「不小众」——而那正是池子里的大多数。
  const niche = Math.min(1, Math.max(0, (4.7 - popularity) / 1.6)) *
    (place.rating !== undefined ? 1 : 0.6);
  const walkBurden =
    opts.steep === "core"
      ? 1
      : opts.steep === "soft"
        ? 0.65
        : place.category === "nature"
          ? 0.7
          : place.category === "attraction"
            ? 0.45
            : place.category === "museum"
              ? 0.25
              : 0.3;
  // 能坐下歇的地方：咖啡馆、正餐馆、茶馆。菜市场不算——那是站着边走边吃。
  const restful =
    place.category === "cafe" ||
    place.category === "food" ||
    /茶馆|茶室|咖啡馆|咖啡厅|歇脚/.test(text);
  return { walkBurden, indoor, foodLed, photoWorthy, popularity, niche, restful };
}
