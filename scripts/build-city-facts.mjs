/**
 * 生成城市能力画像：把 122 城「能玩什么、适合怎么玩」一次性算好，
 * 变成前端可直接 import 的静态表（city-facts.generated.ts）。
 *
 * 为什么要离线生成，而不是前端 fetch / 运行时算：
 *   1. 之前画像靠前端异步拉 /api/city-profile，失败就回退「全量 8 项」，
 *      内陆城市因此露出「海边」「坐船」——用户实测踩中。
 *   2. 城市选项有两行（风格 STYLES + 心愿 EXPERIENCE），过去各写一套、
 *      只有第二行接了画像，第一行「环海慢游」永远显示。
 *   3. 排线核心本来就有 cityHasSea() 判定，但选项层自己另写正则，
 *      两套真相源必然打架。
 *
 * 这一版：一个真相源（本脚本）→ 一张静态表 → 两行选项同源 →
 *          永不回退全量（空城市给中性玩法，绝不含海陆专属）。
 *
 * 跑法：node scripts/build-city-facts.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ENRICH_DIR = path.join(ROOT, "data/knowledge/enrichment");
const INDEX_FILE = path.join(ROOT, "data/knowledge/index.json");
const OUT_FILE = path.join(ROOT, "src/content/city-facts.generated.ts");

// ---- 与 src/lib/water.ts 一致的判定（海 / 湖分开， beach 单字词不算海）----
const STRONG_SEA =
  /海滩|海滨|海边|海岸|海景|海风|看海|海浪|海面|海上|海湾|海港|海岛|滨海|潮汐|潮声|浪花|港湾|入海口|出海口/i;
const LAKE =
  /湖|池|水库|潭|溪|湿地|洱海|什刹海|后海|滇池|纳木错|日月潭|千岛湖|太湖|巢湖|瘦西湖|大明湖|东钱湖|镜湖|鉴湖|月牙泉/i;
const COASTAL_CATEGORY = new Set(["beach", "viewpoint", "attraction", "park", "nature", "street"]);
// 山景里的「云海 / 观海 / 西海岸 / 北海景区」是景名或比喻，不是真海岸。
// 黄山「猴子观海」在山里看云海、「北海景区」是景区名；三清山「西海岸」是栈道名。
const MOUNTAIN_SEA_METAPHOR = /云海|观海|望海|西海岸|东海岸|观景台.*海|海.*观景台|北海景区|南海景区|北海公园|中海|南海/;
// 明显的内陆山岳/景区城市：即便点位文案里有海词，也是景名（北海、云海），不是海岸。
const INLAND_MOUNTAIN_CITIES = new Set([
  "黄山", "三清山", "泰山", "华山", "衡山", "峨眉山", "庐山", "武夷山",
  "张家界", "九寨沟", "稻城亚丁", "长白山", "雁荡山", "龙虎山", "武当山",
]);
// 人工核实的海滨城市：点位文案可能没写海词（如北海的银滩在 unverified 里），
// 但地理事实确定靠海，用白名单兜住，避免正则漏判。
const VERIFIED_COASTAL_CITIES = new Set([
  "北海", "厦门", "青岛", "三亚", "大连", "海口", "珠海", "深圳", "烟台",
  "威海", "日照", "连云港", "舟山", "秦皇岛", "宁波", "惠州", "香港",
  "澳门", "高雄", "台湾", "长岛", "鼓浪屿", "平潭", "霞浦", "汕头", "湛江",
  "北海市", "防城港", "东戴河", "北戴河", "南澳岛", "涠洲岛", "崇明",
]);

function isLakePlace(p) {
  const text = `${p.name ?? ""} ${p.intro ?? ""} ${(p.tags ?? []).join(" ")}`;
  if (LAKE.test(text)) return true;
  return /[河江]/.test(p.name ?? "");
}
function isSeaPlace(p) {
  if (isLakePlace(p)) return false;
  const name = p.name ?? "";
  // 名字是「观海/望海/云海/西海岸」这类山景比喻时，即便简介含「海景」也不算海岸。
  if (MOUNTAIN_SEA_METAPHOR.test(name)) return false;
  const text = `${name} ${p.intro ?? ""} ${(p.tags ?? []).join(" ")}`;
  return STRONG_SEA.test(text) || (p.tags ?? []).some((t) => /^coast$/i.test(t));
}
function cityHasSea(city, places) {
  if (INLAND_MOUNTAIN_CITIES.has(city)) return false;
  if (VERIFIED_COASTAL_CITIES.has(city)) return true;
  return places.some((p) => COASTAL_CATEGORY.has(p.category) && isSeaPlace(p));
}

// ---- 玩法识别（点位级）----
const RULES = {
  coast: { re: STRONG_SEA, cats: ["beach"], need: "sea" },
  boat: { re: /游船|船|码头|轮渡|渡口|泛舟|摇橹|画舫|漕运/i, need: "water" },
  hike: { re: /山|峰|岭|徒步|爬山|栈道|森林公园|登高/i, cats: ["nature"] },
  oldtown: { re: /古城|古镇|老街|古街|胡同|巷|里弄|古村|老城|牌坊/i, cats: ["street"] },
  museum: { re: /博物馆|纪念馆|美术馆|科技馆|展览|博物院/i, cats: ["museum"] },
  temple: { re: /寺|庙|教堂|道观|庵|佛|塔/i, cats: ["temple"] },
  food: { re: /小吃|美食|夜市|菜市场|老字号|餐馆|茶|咖啡|味道/i, cats: ["food", "market"] },
  sunrise: { re: /日出|观日|晨曦|清晨|早霞/i },
  sunset: { re: /日落|夕阳|夕照|晚霞|落日|黄昏/i },
  night: { re: /夜景|夜游|夜市|灯光|夜色|灯火|夜宴/i },
  photo: { re: /拍照|摄影|出片|打卡|观景台|取景/i, cats: ["viewpoint"] },
  ride: { re: /骑行|缆车|索道|自行车|观光车|骑马/i },
  soak: { re: /温泉|汤泉|泡汤|泉眼|热泉|汤池/i, need: "water" },
  show: { re: /演出|剧场|实景|表演|话剧|变脸|晚会/i },
};
const GENERIC = {
  coast: "海边", boat: "坐船", hike: "登山徒步", oldtown: "老街古城",
  museum: "博物馆", temple: "古寺", food: "当地小吃", sunrise: "看日出",
  sunset: "看日落", night: "夜游", photo: "拍照", ride: "骑行索道",
  soak: "泡温泉", show: "看演出",
};
// 城市化文案：人工核实过、能一眼看出城市性格的少数城市。
// 只写玩法名，不写票价/班次（会过时）。海/湖类玩法受能力门槛约束。
const FEATURE = {
  杭州: { boat: "西湖泛舟", hike: "茶山徒步", night: "宋韵夜游", food: "龙井茶香" },
  厦门: { coast: "海边漫步", boat: "鼓浪屿轮渡", food: "闽南小吃" },
  青岛: { coast: "海岸线漫步", food: "海鲜与啤酒", boat: "海湾游船" },
  成都: { food: "茶馆小吃", show: "川剧变脸", oldtown: "宽窄巷子", museum: "博物馆", night: "锦里夜游", photo: "拍照" },
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
  腾冲: { soak: "温泉泡汤", hike: "火山徒步" },
  长白山: { soak: "温泉泡汤", hike: "天池徒步" },
  北戴河: { coast: "海滨浴场", sunrise: "鸽子窝日出" },
  北海: { coast: "银滩戏水", boat: "涠洲岛轮渡" },
  大连: { coast: "滨海路", boat: "海湾游船" },
  海口: { coast: "假日海滩", food: "骑楼小吃" },
  哈尔滨: { oldtown: "中央大街", show: "冰雪演出" },
  洛阳: { museum: "龙门石窟", oldtown: "隋唐洛阳城", show: "汉服夜游" },
  敦煌: { museum: "莫高窟", hike: "鸣沙山" },
};

function hitsOf(places, id) {
  const rule = RULES[id];
  return places.filter((p) => {
    const text = `${p.name ?? ""} ${p.intro ?? ""} ${(p.tags ?? []).join(" ")}`;
    if (rule.cats?.includes(p.category)) return true;
    return rule.re.test(text);
  });
}

function buildFacts(city, places) {
  const sea = cityHasSea(city, places);
  const lake = places.some((p) => isLakePlace(p)) && !sea;
  const mountain = hitsOf(places, "hike").length > 0;
  const caps = { sea, lake, mountain };

  const feats = FEATURE[city] ?? {};
  const opts = [];
  for (const [id, rule] of Object.entries(RULES)) {
    // 能力门槛：海类只给真有海的城市，水类只给有海或有湖的城市。
    // 这是这次修复的核心——内陆城市在计算层就拿不到 coast/boat。
    if (rule.need === "sea" && !sea) continue;
    if (rule.need === "water" && !sea && !lake) continue;

    let hits = hitsOf(places, id);
    // 白名单海滨城市即便点位文案没写海词，也要有海边玩法（如北海银滩）。
    if (id === "coast" && VERIFIED_COASTAL_CITIES.has(city) && !hits.length) {
      hits = [{ name: `${city}海岸`, category: "beach", rating: 4.6 }];
    }
    if (!hits.length && !(id in feats)) continue;

    const count = hits.length;
    const rating = hits.filter((p) => typeof p.rating === "number");
    const avg = rating.length ? rating.reduce((s, p) => s + p.rating, 0) / rating.length : 0;
    const must = hits.filter((p) => (p.rating ?? 0) >= 4.6).length;
    const score = Math.max(12, Math.min(100,
      Math.round(Math.min(count, 12) * 5 + (avg - 3.5) * 12 + must * 6 + (id in feats ? 40 : 0))));
    const samples = hits.slice().sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)).slice(0, 3).map((p) => p.name);
    opts.push({ id, label: feats[id] ?? GENERIC[id], score, count, samples, featured: id in feats });
  }
  opts.sort((a, b) => b.score - a.score || b.count - a.count);
  const ids = new Set(opts.map((o) => o.id));

  // 中性玩法兜底：任何城市都成立的文化/吃/拍照类，绝不含海陆专属。
  // 空城市（无点位）也至少给这一组，永远不让前端走「全量」。
  const NEUTRAL = ["oldtown", "museum", "food", "photo", "temple", "night", "citywalk"];
  for (const id of NEUTRAL) {
    if (id === "citywalk" || opts.length >= 8) break;
    if (ids.has(id)) continue;
    if (!(id in RULES)) continue;
    opts.push({ id, label: feats[id] ?? GENERIC[id], score: 10, count: 0, samples: [], featured: id in feats });
    ids.add(id);
  }
  // 城市漫步是风格不是心愿，心愿列表里去掉占位。
  const experiences = opts.filter((o) => o.id !== "citywalk").slice(0, 9);

  // ---- 第一行风格：与心愿同源 ----
  // coastal（环海慢游）只在真有海时出现；有湖给「湖畔慢游」；
  // 都没有就不出现这个风格，改由 citywalk/culture/foodie/family 兜住。
  const styles = ["citywalk", "classic", "culture", "foodie", "family"];
  if (sea) styles.splice(2, 0, "coastal");

  const top = experiences.slice(0, 3).map((o) => o.label);
  const summary = top.length
    ? `${city}适合${top.join("、")}。`
    : `${city}按经典路线安排。`;
  return { capabilities: caps, styles, experiences, summary };
}

async function main() {
  const index = JSON.parse(await fs.readFile(INDEX_FILE, "utf8"));
  const cities = (index.cities ?? []).map((c) => c.city).filter(Boolean).sort();
  const lines = [
    "/**",
    " * 城市能力画像 —— 自动生成，请勿手改。",
    " * 生成脚本：scripts/build-city-facts.mjs",
    " * 数据源：data/knowledge/enrichment/*.json（联网核实点位）+ 城市化文案。",
    " * 作用：聊天选项的单一真相源。两行风格/心愿同城同源，空城市给中性玩法，",
    " *      永不回退到含海陆专属的全量清单。",
    " */",
    "",
    "export interface CityFactOption {",
    "  id: string; label: string; score: number; count: number;",
    "  samples: string[]; featured?: boolean;",
    "}",
    "export interface CityFacts {",
    "  capabilities: { sea: boolean; lake: boolean; mountain: boolean };",
    "  styles: string[];",
    "  experiences: CityFactOption[];",
    "  summary: string;",
    "}",
    "",
    "export const CITY_FACTS: Record<string, CityFacts> = {",
  ];

  let seaCount = 0;
  let emptyCount = 0;
  const problems = [];
  const notes = [];
  for (const city of cities) {
    const file = path.join(ENRICH_DIR, `${city}.json`);
    let places = [];
    try {
      const data = JSON.parse(await fs.readFile(file, "utf8"));
      places = Object.values(data.places ?? {}).filter((p) => p && p.verified);
    } catch {
      /* 没文件就当中性城市 */
    }
    const facts = buildFacts(city, places);
    if (facts.capabilities.sea) seaCount++;
    if (!places.length) emptyCount++;
    // 致命项：无海城市绝不能出现 coast / 海边；有海城市绝不能出现「环海慢游」以外的混乱。
    if (!facts.capabilities.sea && facts.experiences.some((o) => o.id === "coast")) {
      problems.push(`${city}: 无海却出现 coast（严重）`);
    }
    if (!facts.capabilities.sea && facts.styles.includes("coastal")) {
      problems.push(`${city}: 无海却出现 coastal 风格（严重）`);
    }
    if (!facts.capabilities.sea && !facts.capabilities.lake && facts.experiences.some((o) => o.id === "boat")) {
      problems.push(`${city}: 无海无湖却出现坐船（严重）`);
    }
    if (facts.capabilities.sea && facts.experiences.some((o) => o.id === "coast" && o.label === "海边")) {
      notes.push(city);
    }
    lines.push(`  ${JSON.stringify(city)}: ${JSON.stringify(facts)},`);
  }
  lines.push("};", "");
  lines.push("/** 查不到城市时的中性画像：可玩的通用玩法，绝不含海边/坐船。 */");
  lines.push("export const NEUTRAL_FACTS: CityFacts = {");
  lines.push("  capabilities: { sea: false, lake: false, mountain: false },");
  lines.push('  styles: ["citywalk", "classic", "culture", "foodie", "family"],');
  lines.push("  experiences: [");
  for (const id of ["oldtown", "museum", "food", "photo", "temple", "night"]) {
    lines.push(`    { id: ${JSON.stringify(id)}, label: ${JSON.stringify(GENERIC[id])}, score: 10, count: 0, samples: [] },`);
  }
  lines.push("  ],");
  lines.push('  summary: "按经典路线安排。",');
  lines.push("};", "");

  await fs.writeFile(OUT_FILE, lines.join("\n"), "utf8");
  console.log(`生成 ${cities.length} 城 → ${path.relative(ROOT, OUT_FILE)}`);
  console.log(`有海 ${seaCount} 城 / 无点位 ${emptyCount} 城`);
  if (problems.length) {
    console.error("质检失败:\n" + problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("质检通过：无海城市无 coast/coastal，无海无湖城市无 boat");
    if (notes.length) console.log(`有海但用通用「海边」文案（${notes.length} 城）：${notes.join("、")}`);
  }
}

await main();
