/**
 * 城市画像：选完城市，先算出这座城市"能玩什么、最适合玩什么"。
 *
 * 为什么需要这一层：
 *   玩法选项原本是写死的 8 项全局常量，内陆城市也能选「海边」——
 *   城市只是个名字，对后续没有任何影响。这一层把知识库里已有的点位
 *   （category / 名字 / 标签 / 评分）汇总成城市画像，让选项做到：
 *     1. 过滤：这座城市没有的玩法不出现（内陆无海 → 无「海边」）
 *     2. 排序：点位多、评分高、必去的玩法排前面
 *     3. 补特色：启用原本就支持但没露出的 soak/show，并按城市改文案
 *        （杭州的 boat →「西湖泛舟」，让用户看到"湖"）
 *
 * 数据源：本地知识库（离线、零成本）+ 少量人工核实的城市特色文案。
 * 不联网、不依赖 Key——调研过的特色直接写进 FEATURE_LABELS，运行期零延迟。
 */
import type { ExperienceId } from "./types";
import type { Category, Place } from "./types";

export interface CityProfileOption {
  /** 玩法 id，直接可写进 draft.experiences */
  id: ExperienceId;
  /** 城市化文案，如「西湖泛舟」 */
  label: string;
  /** 匹配度 0-100，用于排序 */
  score: number;
  /** 命中的点位数 */
  count: number;
  /** 代表点位，用于解释"为什么推荐" */
  samples: string[];
  /** 是否为这座城市补进来的特色（原本 8 项里没有） */
  featured?: boolean;
}

export interface CityProfile {
  city: string;
  /** 排序后的玩法，city 没有的已被过滤 */
  options: CityProfileOption[];
  /** 被过滤掉的玩法 id */
  hidden: ExperienceId[];
  /** 一句话城市特色 */
  summary: string;
}

/** 每种玩法的识别规则：名字/标签命中关键词，或 category 命中。 */
const RULES: Record<
  ExperienceId,
  { pattern: RegExp; categories?: Category[] }
> = {
  coast: {
    pattern: /海|沙滩|海岸|海滨|海湾|海滩|看海|海边|浪/i,
    categories: ["beach"],
  },
  boat: { pattern: /游船|船|码头|轮渡|渡口|泛舟|摇橹|画舫/i },
  hike: { pattern: /山|峰|岭|徒步|爬山|栈道|森林公园|登高/i },
  oldtown: {
    pattern: /古城|古镇|老街|古街|胡同|巷|里弄|古村|老城|牌坊/i,
    categories: ["street"],
  },
  museum: { pattern: /博物馆|纪念馆|美术馆|科技馆|展览|博物院/i, categories: ["museum"] },
  temple: { pattern: /寺|庙|教堂|道观|庵|佛|塔/i, categories: ["temple"] },
  food: {
    pattern: /小吃|美食|夜市|菜市场|老字号|餐馆|茶|咖啡|味道/i,
    categories: ["food", "market"],
  },
  sunrise: { pattern: /日出|观日|晨曦|清晨|早霞/i },
  sunset: { pattern: /日落|夕阳|夕照|晚霞|落日|黄昏/i },
  night: { pattern: /夜景|夜游|夜市|灯光|夜色|灯火|夜宴/i },
  photo: { pattern: /拍照|摄影|出片|打卡|观景台|取景/i, categories: ["viewpoint"] },
  ride: { pattern: /骑行|缆车|索道|自行车|观光车|骑马/i },
  soak: { pattern: /温泉|汤泉|泡汤|泉眼|热泉|汤池/i },
  show: { pattern: /演出|剧场|实景|表演|话剧|变脸|晚会/i },
};

/** 这 8 项是原本展示面板里就有的；其余为"补特色"候选。 */
const BASE_IDS: ExperienceId[] = [
  "sunset",
  "sunrise",
  "coast",
  "oldtown",
  "food",
  "hike",
  "boat",
  "photo",
];
const FEATURE_IDS: ExperienceId[] = [
  "night",
  "museum",
  "temple",
  "ride",
  "soak",
  "show",
];

/**
 * 人工核实的城市特色文案 —— 来自公开文旅资料与票务平台实测，
 * 只覆盖"能一眼看出这座城市性格"的少数城市，其余城市用通用标签。
 * 不写票价、不写班次（会过时），只写玩法名。
 */
const FEATURE_LABELS: Record<string, Partial<Record<ExperienceId, string>>> = {
  杭州: { boat: "西湖泛舟", hike: "茶山徒步", night: "宋韵夜游", food: "龙井茶香" },
  厦门: { coast: "海边漫步", boat: "鼓浪屿轮渡", food: "闽南小吃" },
  青岛: { coast: "海岸线漫步", food: "海鲜与啤酒", boat: "海湾游船" },
  成都: {
    food: "茶馆小吃",
    show: "川剧变脸",
    oldtown: "宽窄巷子",
    museum: "博物馆",
    night: "锦里夜游",
    photo: "拍照",
  },
  三亚: { coast: "海滩戏水", boat: "海岛游船", soak: "温泉泡汤", photo: "拍照", food: "海鲜" },
  重庆: { hike: "山城步道", night: "山城夜景", food: "火锅" },
  北京: { oldtown: "胡同漫游", museum: "博物院", show: "剧场演出" },
  丽江: { oldtown: "古城闲逛", hike: "雪山远眺", show: "纳西古乐" },
  苏州: { oldtown: "园林老街", boat: "水乡摇橹", show: "昆曲评弹" },
  桂林: { boat: "漓江游船", hike: "喀斯特山水" },
  大理: { boat: "洱海骑行", coast: "洱海边", hike: "苍山徒步" },
  西安: { oldtown: "古城墙", museum: "博物院", show: "实景演出" },
  南京: { oldtown: "老城南", museum: "博物院", night: "秦淮夜游" },
  武汉: { boat: "长江轮渡", night: "江城夜景", food: "过早" },
  大理古城: { oldtown: "古城闲逛", boat: "洱海骑行" },
  腾冲: { soak: "温泉泡汤", hike: "火山徒步" },
  长白山: { soak: "温泉泡汤", hike: "天池徒步" },
};

const GENERIC_LABELS: Record<ExperienceId, string> = {
  sunrise: "看日出",
  sunset: "看日落",
  night: "夜游",
  coast: "海边",
  boat: "坐船",
  hike: "登山徒步",
  oldtown: "老街古城",
  museum: "博物馆",
  temple: "古寺",
  food: "当地小吃",
  ride: "骑行索道",
  photo: "拍照",
  soak: "泡温泉",
  show: "看演出",
};

function placeText(place: Place): string {
  return `${place.name} ${place.note ?? ""} ${(place.tags ?? []).join(" ")} ${place.address ?? ""}`;
}

function matches(place: Place, id: ExperienceId): boolean {
  const rule = RULES[id];
  if (rule.categories?.includes(place.category)) return true;
  return rule.pattern.test(placeText(place));
}

/**
 * 从点位算城市画像。places 来自 readLocalKnowledge(city).places。
 * 纯函数、无 IO，便于回归测试。
 */
export function buildCityProfile(city: string, places: Place[]): CityProfile {
  const labelFor = (id: ExperienceId) =>
    FEATURE_LABELS[city]?.[id] ?? GENERIC_LABELS[id];

  const candidates: CityProfileOption[] = [];
  for (const id of [...BASE_IDS, ...FEATURE_IDS]) {
    const hits = places.filter((place) => matches(place, id));
    if (!hits.length) continue;

    // 评分 = 数量（封顶）+ 口碑 + 是否必去/高人气。
    // 数量决定"这座城市这方面强不强"，口碑和必去决定"值不值得排"。
    const count = hits.length;
    const avgRating =
      hits.reduce((sum, p) => sum + (p.rating ?? 0), 0) /
      hits.filter((p) => Number.isFinite(p.rating)).length || 0;
    const mustCount = hits.filter(
      (p) => (p.popularity ?? 0) >= 4.3 || p.tags?.includes("必去"),
    ).length;
    const score = Math.min(
      100,
      Math.round(
        Math.min(count, 12) * 5 + (avgRating - 3.5) * 12 + mustCount * 6,
      ),
    );

    const samples = hits
      .slice()
      .sort((a, b) => (b.popularity ?? b.rating ?? 0) - (a.popularity ?? a.rating ?? 0))
      .slice(0, 3)
      .map((p) => p.name);

    candidates.push({
      id,
      label: labelFor(id),
      score: Math.max(1, score),
      count,
      samples,
      featured: !BASE_IDS.includes(id),
    });
  }

  // 排序：匹配度优先，同分按点位多者优先。
  const options = candidates.sort(
    (a, b) => b.score - a.score || b.count - a.count,
  );

  // 城市特色注入：本地点位稀薄时（如杭州只有「西湖」一个名字，
  // 没有游船/茶山明细），调研过的特色照样要出现——这是"城市不只是名字"。
  // 只注入 FEATURE_LABELS 里人工核实过的项，且该城市确实有对应底子
  // （杭州有西湖才有泛舟，不会给内陆无水城市硬塞船）。
  const cityFeatures = FEATURE_LABELS[city] ?? {};
  const waterText = places.map((p) => p.name + (p.note ?? "")).join(" ");
  // 海和湖要分开：内陆城市有西湖 ≠ 有海边，不能因为有水就补「海边」。
  const hasSea = /海|湾|沙滩|岛/.test(waterText);
  const hasWater = /湖|江|河|海|湾|溪|水/.test(waterText);
  for (const [rawId, label] of Object.entries(cityFeatures) as [
    ExperienceId,
    string,
  ][]) {
    if (options.some((option) => option.id === rawId)) {
      const option = options.find((option) => option.id === rawId)!;
      option.label = label; // 用城市化文案覆盖通用标签
      continue;
    }
    // 水类玩法要城市确实有水；山类玩法若点位里没写山名，
    // 但 FEATURE_LABELS 里人工核实过（如杭州茶山），也照样放行——
    // 本地点位稀疏是数据问题，不该把调研结论抹掉。
    const needsWater = rawId === "boat" || rawId === "soak";
    if (needsWater && !hasWater) continue;
    if (rawId === "coast" && !hasSea) continue;
    options.push({
      id: rawId,
      label,
      score: 44, // 调研确认的特色，给中上位置，但不超过本地强项
      count: 0,
      samples: [],
      featured: true,
    });
  }

  // 最少选项兜底：点位稀薄的城市（成都只有 5 个点位）不该只剩 4 个按钮。
  // 从通用玩法补到 6 项，但跳过这座城市明确没有的水类玩法。
  const MIN_OPTIONS = 6;
  const presentIds = new Set(options.map((option) => option.id));
  // 完全没有点位时保持空，让前端回退到全量玩法（说明是"还在整理中"）。
  for (const id of options.length ? BASE_IDS : []) {
    if (options.length >= MIN_OPTIONS) break;
    if (presentIds.has(id)) continue;
    if (id === "coast" && !hasSea) continue;
    if (id === "boat" && !hasWater) continue;
    options.push({
      id,
      label: labelFor(id),
      score: 20,
      count: 0,
      samples: [],
    });
    presentIds.add(id);
  }

  options.sort((a, b) => b.score - a.score || b.count - a.count);
  const present = new Set(options.map((option) => option.id));
  // 注入的特色不再算"隐藏"；其余没有的就是这座城市没有的玩法。
  const hidden = [...BASE_IDS, ...FEATURE_IDS].filter(
    (id) => !present.has(id) && !(id in cityFeatures),
  );

  const top = options.slice(0, 3).map((option) => option.label);
  const summary = top.length
    ? `${city}适合${top.join("、")}。`
    : `${city}的特色玩法还在整理中，先按通用玩法安排。`;

  return { city, options, hidden, summary };
}

/** 回归/诊断用：把画像压成易读的一行行文本。 */
export function formatCityProfile(profile: CityProfile): string {
  const lines = profile.options.map(
    (option, index) =>
      `${index + 1}. ${option.label} [${option.id}] 分${option.score} · ${option.count}点 · ${option.samples.join("/")}${option.featured ? " · 特色" : ""}`,
  );
  return `${profile.summary}\n${lines.join("\n")}\n隐藏: ${profile.hidden.join("、") || "无"}`;
}
