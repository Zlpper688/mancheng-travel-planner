import { fetchJson, mapLimit } from "@/lib/cache";
import { QUICK_CITIES } from "@/lib/constants";
import { todayISOLocal } from "@/lib/geo";
import { getProvider } from "@/lib/providers";
import { nameSimilarity } from "@/lib/providers/normalize";
import type {
  BudgetTier,
  CityOption,
  ExperienceId,
  PaceId,
  Place,
  StyleId,
  TransportPref,
} from "@/lib/types";
import { draftSummary, hotelForCity } from "./draft";
import {
  gateDefaultDimensions,
  gateHardConstraints,
  gatePlacesClaim,
  shouldAcceptCity,
} from "./gate";
import type {
  ChatCard,
  ChatCardKind,
  ChatDraft,
  ChatPatch,
  ChatReply,
  ResolvedPatch,
} from "./types";

export interface ChatModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function chatModelConfig(): ChatModelConfig | null {
  const apiKey =
    process.env.AI_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (
    process.env.AI_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = process.env.AI_MODEL?.trim() || "gpt-4o-mini";
  return { baseUrl, apiKey, model };
}

export class ChatModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatModelError";
  }
}

let probeCache: { ok: boolean; reason?: string; at: number } | null = null;

// 页面打开时探一次 /models，避免明明 Key 失效还显示“对话模式”。
export async function probeChatModel(
  config: ChatModelConfig,
): Promise<{ ok: boolean; reason?: string }> {
  if (probeCache && Date.now() - probeCache.at < 10 * 60_000) {
    return { ok: probeCache.ok, reason: probeCache.reason };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
      cache: "no-store",
    });
    if (response.ok) {
      probeCache = { ok: true, at: Date.now() };
      return { ok: true };
    }
    const reason =
      response.status === 401 || response.status === 403
        ? "模型 Key 无效或被拒绝"
        : `模型接口返回 ${response.status}`;
    probeCache = { ok: false, reason, at: Date.now() };
    return { ok: false, reason };
  } catch {
    probeCache = { ok: false, reason: "模型接口连不上", at: Date.now() };
    return { ok: false, reason: "模型接口连不上" };
  } finally {
    clearTimeout(timer);
  }
}

const STYLE_IDS: StyleId[] = [
  "citywalk",
  "classic",
  "coastal",
  "culture",
  "foodie",
  "family",
];
const EXPERIENCE_IDS: ExperienceId[] = [
  "sunrise",
  "sunset",
  "night",
  "coast",
  "boat",
  "hike",
  "oldtown",
  "museum",
  "temple",
  "food",
  "ride",
  "photo",
  "soak",
  "show",
];
const PACE_IDS: PaceId[] = ["chill", "balanced", "packed"];
const TRANSPORT_IDS: TransportPref[] = ["auto", "walk", "transit", "drive"];
const BUDGET_IDS: BudgetTier[] = ["economy", "comfort", "premium"];
const CARD_KINDS: ChatCardKind[] = [
  "city",
  "date",
  "party",
  "style",
  "pace",
  "transport",
  "budget",
  "hotel",
  "confirm",
];

function systemPrompt(draft: ChatDraft): string {
  return `你是「漫城」的行程对话搭档。你的职责不是自己排线，而是通过对话把一趟旅行必须的约束收齐，然后交给确定性行程引擎。绝对不要编造坐标、营业时间、票价、路线耗时或餐厅名称；吃饭只安排时段，具体吃什么到现场再选。

工作规则：
1. 一次只问 1 个问题，最多附 1 张卡片。用户已经说过的不要再问；一次给出多条信息就一次收下，不要拆成多轮重问。
2. 排线前按顺序收齐 7 个维度，严格按这个顺序，前一个没确认不要跳到下一个，缺哪个问哪个：
   城市 → 出发日期与天数 → 同行人数（含儿童、老人）→ 玩法与心愿 → 每日节奏 → 出行方式 → 住处。
   对应卡片：city / date / party / style / pace / transport / hotel。
3. 城市、日期天数、人数必须由用户说清，不能用默认值蒙混；玩法、节奏、出行方式、住处可以按默认值来，但必须让用户表过态（点卡片或口头说“随便”）。用户说“住处还没定 / 帮我推荐住处 / 住哪都行”时，视为已经表态，写 hotelUndecided:true，不要再追问具体酒店。
4. 用户说“随便 / 都行 / 你定 / 看着办”时，该维度用默认值收下并写进 patch：玩法 styles 用 citywalk，节奏 pace 用 balanced，交通 transport 用 auto，住处 hotelUndecided 填 true（交给行程引擎按景点分布推荐落脚片区）。同一维度只问一次，不要反复确认。
5. 7 项收齐后还有最后一问：附 confirm 卡，用一句话问“有没有点名一定要去、或者完全不想去的地方？”。
   - 用户回答后：想去的名字写进 selectedNames；不想去的不要写进 selectedNames，用 styles/experiences 的相反偏好表达（例如不想人文就少选 culture/museum）。
   - 如果最近一条助手消息已经在问这件事，用户这轮回答后直接 action:"plan"，不要重复问。
6. 用户明确说“别问了，直接排 / 你安排”时，剩余玩法、节奏、交通、住处按默认值收下，直接 action:"plan"；城市、日期天数和人数仍然必须问清。
7. 用户这一轮提到的任何信息（城市、日期天数、人数、老人、玩法、节奏、交通、住处、想去的点）都必须当轮写进 patch，不能只放在 say 里；即使准备 action:"plan"，也要一起带上，不能丢。说“别太赶、轻松、慢一点”时 pace 用 chill，说“多玩多看、充实”时 pace 用 packed。
8. 用户用自己的话描述玩法时，先翻译成参数再写 patch，不能只复述：
   - “想看海/出海/日落/夜景/逛老街/博物馆/寺庙/拍照”等 → 对应 experiences；
   - “主要吃什么/逛吃/小吃” → styles 加 foodie、experiences 加 food；
   - “带小孩/亲子” → styles 加 family；“成人”只数 60 岁以下的同行者，老人单独填 seniors；“爸妈/父母”按 2 位老人记，只说“有老人”没给数字先按 1 位记；队伍全是老人时 adults 填 0（例如“我和老伴都七十多了” → adults:0, seniors:2）；
   - 只要这一轮写了 seniors，就必须同时写 adults（哪怕成年人数和草稿一样），两者相加才是总人数；“我们五个人，其中一位老人” → adults:4, seniors:1；老人同行时 pace 不高于 balanced；
   - 用户明确说“不爬山/腿脚不便/膝盖不好/不想走长台阶”时，avoidSteep 填 true，不要选 hike、不要选 packed，节奏用 chill 收住；“不想太累/不想人挤人”只降节奏，不必填 avoidSteep；
   - 原话里还有没被参数吸收的细节（口味、纪念日、行动限制、必须避开的时段），压缩成 60 字以内写进 notes。
   即使用户的自由描述很碎，也要把能映射的字段都填上，剩余部分留在 notes；绝不能因为听不懂就清空玩法或只回一句空话。
9. 预算 budgetTier 不单独问，用户主动提及时才记录。
10. 枚举字段只能取下列值，不要自创：
pace: chill | balanced | packed
styles: citywalk | classic | coastal | culture | foodie | family
experiences: sunrise | sunset | night | coast | boat | hike | oldtown | museum | temple | food | ride | photo | soak | show
transport: auto | walk | transit | drive（auto = 按距离自动混合，不要说成“自驾”）
budgetTier: economy | comfort | premium
11. 用户说的是模糊日期（下周末、月底、过几天）时，先在 say 里复述你推算的具体日期并追问确认，action 用 "none"；用户明确说出或确认日期后才算确认。
12. city 只能取自用户原话或当前草稿；用户没有明确要求换城市时，不要在 patch 或 say 里改写城市名。
13. 只输出一个 JSON 对象，不要 Markdown，不要代码块。

输出格式：
{
  "say": "给用户看的短句",
  "patch": { "city": "城市名", "days": 3, "date": "YYYY-MM-DD", "pace": "chill|balanced|packed", "styles": ["citywalk"], "experiences": ["sunset"], "transport": "auto", "budgetTier": "comfort", "adults": 2, "children": 0, "seniors": 0, "avoidSteep": false, "notes": "用户原话里的补充要求", "hotelQuery": "住处或片区名", "hotelUndecided": true, "selectedNames": ["景点名"] },
  "cards": [{ "kind": "city|date|party|style|pace|transport|budget|hotel|confirm", "title": "卡片标题", "hint": "一句提示" }],
  "action": "none" | "plan"
}
patch 只放这一轮用户明确说出的信息或选中的选项；没变化就省略，不要提前把默认值写进 patch。cards 最多 1 张。

示例 1（刚开始，只给了城市/天数/人数）：
用户：“厦门，三天，两个人”，其余都没确认 →
{"say":"好的，厦门3天2人。哪天出发？","patch":{"city":"厦门","days":3,"adults":2},"cards":[{"kind":"date","title":"哪天出发，玩几天？","hint":"天数会直接决定能塞进几个大景"}],"action":"none"}

示例 2（信息不齐，只收下已说的，继续问下一个维度）：
用户：“厦门三天两人，11月22日出发，想吃本地小吃，别太赶”，草稿已确认城市、日期、人数，玩法、节奏未确认 →
{"say":"好的，厦门3天2人，11月22日出发，多排本地小吃，节奏放松。平时更愿意坐地铁公交、打车还是开车？","patch":{"styles":["foodie"],"experiences":["food"],"pace":"chill"},"cards":[{"kind":"transport","title":"更愿意怎么出行？","hint":"自动会按距离混着排"}],"action":"none"}

示例 3（带老人或自由描述玩法，要翻译成参数）：
用户：“带我爸妈一起，腿脚不太好，不想爬山，想看看海和日落，吃点清淡的海鲜” →
{"say":"好的，2 位老人同行会放慢节奏、避开爬坡，多安排海边平路和日落，海鲜挑清淡做法。人数不对可以随时改。","patch":{"adults":2,"seniors":2,"pace":"chill","styles":["coastal","foodie"],"experiences":["coast","sunset","food"],"avoidSteep":true,"notes":"老人腿脚不便，避开爬山；清淡海鲜"},"cards":[],"action":"none"}

示例 4（7 项齐了，问最后一问）：
草稿已确认城市、日期、人数、玩法、节奏、交通、住处，还没问过必去点 →
{"say":"信息齐了。有没有点名一定要去、或者完全不想去的地方？没有我就按现在这些开始排。","patch":{},"cards":[{"kind":"confirm","title":"信息齐了，开始安排？","hint":"有必去点也可以直接打字说"}],"action":"none"}

示例 5（用户回答最后一问后开始排）：
用户：“没有了，你安排吧” →
{"say":"好，那就按现在的偏好排，经典点和本地小吃都会照顾到。","patch":{},"cards":[],"action":"plan"}

示例 6（用户不知道住哪，不要追问酒店名）：
用户：“酒店还没定，你帮我看着办” →
{"say":"好，住处先不定，我会按景点分布给你推荐落脚片区。","patch":{"hotelUndecided":true},"cards":[],"action":"none"}

今天日期：${todayISOLocal()}
当前草稿：
${draftSummary(draft)}`;
}

interface ModelChoice {
  message?: { content?: string | null };
}

interface ModelResponse {
  choices?: ModelChoice[];
}

interface ModelRequestBody {
  model: string;
  temperature: number;
  max_tokens: number;
  response_format?: { type: string };
  messages: { role: string; content: string }[];
}

async function callModel(
  config: ChatModelConfig,
  draft: ChatDraft,
  messages: { role: "user" | "assistant"; text: string }[],
): Promise<string> {
  const history = messages.slice(-12).map((message) => ({
    role: message.role,
    content: message.text.slice(0, 1200),
  }));
  const payload: ModelRequestBody = {
    model: config.model,
    temperature: 0.1,
    max_tokens: 700,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt(draft) },
      ...history,
    ],
  };
  const run = (body: ModelRequestBody) =>
    fetchJson<ModelResponse>(
      `${config.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      28_000,
    );

  let data: ModelResponse;
  try {
    data = await run(payload);
  } catch (error) {
    const message = `${(error as Error)?.message ?? error}`;
    // 少数兼容端点不认 response_format，去掉再试一次。
    if (message.includes("400")) {
      data = await run({
        model: payload.model,
        temperature: payload.temperature,
        max_tokens: payload.max_tokens,
        messages: payload.messages,
      });
    } else {
      throw new ChatModelError(message);
    }
  }

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new ChatModelError("模型没有返回内容");
  return content;
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function intIn(value: unknown, min: number, max: number): number | undefined {
  const number = typeof value === "number" ? Math.round(value) : NaN;
  return Number.isFinite(number) && number >= min && number <= max
    ? number
    : undefined;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }
  const time = Date.parse(`${value}T00:00:00`);
  return Number.isFinite(time) ? value : undefined;
}

// 模型只看到“出发日期未定”，仍可能凭直觉编日期；用户原话里没证据就不采信。
function userStatedDate(text: string, iso: string): boolean {
  const [year, month, day] = iso.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return false;
  if (text.includes(iso)) return true;
  const bounded = (pattern: string) =>
    new RegExp(`(?:^|[^0-9])${pattern}(?:[^0-9]|$)`).test(text);
  if (bounded(`${year}/${month}/${day}`)) return true;
  if (bounded(`${month}月${day}(?:日|号)?`)) return true;
  if (bounded(`${month}[-/.]${day}`)) return true;
  if (bounded(`${day}(?:日|号)`)) return true;
  const offset = Math.round(
    (Date.parse(`${iso}T00:00:00`) - Date.parse(`${todayISOLocal()}T00:00:00`)) /
      86_400_000,
  );
  if (offset === 0 && /今天|今日/.test(text)) return true;
  if (offset === 1 && /明天|明日/.test(text)) return true;
  if (offset === 2 && /后天/.test(text) && !/大后天/.test(text)) return true;
  if (offset === 3 && /大后天/.test(text)) return true;
  return false;
}

function oneOf<T extends string>(value: unknown, allowed: T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

function someOf<T extends string>(value: unknown, allowed: T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const picked = value
    .filter((item): item is T => typeof item === "string" && allowed.includes(item as T))
    .slice(0, 4);
  return picked.length ? picked : undefined;
}

function sanitizePatch(raw: unknown): ChatPatch {
  if (!raw || typeof raw !== "object") return {};
  const record = raw as Record<string, unknown>;
  const patch: ChatPatch = {};
  const city = clip(record.city, 20);
  const days = intIn(record.days, 1, 10);
  const date = isoDate(record.date);
  const pace = oneOf(record.pace, PACE_IDS);
  const styles = someOf(record.styles, STYLE_IDS);
  const experiences = someOf(record.experiences, EXPERIENCE_IDS);
  const transport = oneOf(record.transport, TRANSPORT_IDS);
  const budgetTier = oneOf(record.budgetTier, BUDGET_IDS);
  const adults = intIn(record.adults, 0, 9);
  const children = intIn(record.children, 0, 9);
  const seniors = intIn(record.seniors, 0, 9);
  const avoidSteep =
    typeof record.avoidSteep === "boolean" ? record.avoidSteep : undefined;
  const notes = clip(record.notes, 160);
  const hotelQuery = clip(record.hotelQuery, 30);
  const hotelUndecided = record.hotelUndecided === true ? true : undefined;
  const selectedNames = Array.isArray(record.selectedNames)
    ? record.selectedNames
        .map((item) => clip(item, 30))
        .filter((item): item is string => Boolean(item))
        .slice(0, 6)
    : [];

  if (city) patch.city = city;
  if (days !== undefined) patch.days = days;
  if (date) patch.date = date;
  if (pace) patch.pace = pace;
  if (styles) patch.styles = styles.slice(0, 3);
  if (experiences) patch.experiences = experiences.slice(0, 4);
  if (transport) patch.transport = transport;
  if (budgetTier) patch.budgetTier = budgetTier;
  if (adults !== undefined) patch.adults = adults;
  if (children !== undefined) patch.children = children;
  if (seniors !== undefined) patch.seniors = seniors;
  if (avoidSteep !== undefined) patch.avoidSteep = avoidSteep;
  if (notes) patch.notes = notes;
  if (hotelQuery) patch.hotelQuery = hotelQuery;
  if (hotelUndecided) patch.hotelUndecided = true;
  if (selectedNames.length) patch.selectedNames = selectedNames;
  return patch;
}

function sanitizeCards(raw: unknown): ChatCard[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cards = raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item, index): ChatCard | null => {
      const kind = oneOf(item.kind, CARD_KINDS);
      if (!kind) return null;
      return {
        id: `ai-${index}`,
        kind,
        title: clip(item.title, 40) ?? "接着选一下",
        hint: clip(item.hint, 80),
      };
    })
    .filter((item): item is ChatCard => item !== null)
    .slice(0, 1);
  return cards.length ? cards : undefined;
}

function parseReply(content: string): {
  say: string;
  patch: ChatPatch;
  cards?: ChatCard[];
  action: ChatReply["action"];
} {
  let text = content.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ChatModelError("模型返回的不是 JSON");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ChatModelError("模型返回的 JSON 无法解析");
  }
  const record = (raw ?? {}) as Record<string, unknown>;
  const say = clip(record.say, 300) ?? "我在，接着来。";
  const action = record.action === "plan" ? "plan" : "none";
  return {
    say,
    patch: sanitizePatch(record.patch),
    cards: action === "plan" ? undefined : sanitizeCards(record.cards),
    action,
  };
}

/**
 * 城市/酒店解析结果的小缓存。
 *
 * 键里带用户输入的城市名——不做上限的话，一个脚本用随机字符串就能让它
 * 无限增长（Map 不会自己忘）。这里按「写入顺序淘汰最旧」封顶，
 * 语义上够用：热门城市会反复被写回，冷门条目自然被挤掉。
 */
const RESOLVE_CACHE_MAX = 200;
const resolveCache = new Map<string, { value: CityOption | Place | null; at: number }>();

function rememberResolved(key: string, value: CityOption | Place | null): void {
  if (resolveCache.size >= RESOLVE_CACHE_MAX) {
    const oldest = resolveCache.keys().next().value;
    if (oldest) resolveCache.delete(oldest);
  }
  resolveCache.set(key, { value, at: Date.now() });
}

async function resolveCity(name: string): Promise<CityOption | undefined> {
  const key = `city:${name}`;
  const hit = resolveCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) {
    return (hit.value as CityOption | null) ?? undefined;
  }
  const local = QUICK_CITIES.find(
    (option) =>
      option.name === name ||
      option.name.includes(name) ||
      name.includes(option.name),
  );
  if (local) {
    rememberResolved(key, local);
    return local;
  }
  try {
    const results = await getProvider().search(name, { kind: "city" });
    const best = [...results].sort(
      (a, b) => nameSimilarity(name, b.name) - nameSimilarity(name, a.name),
    )[0];
    const value = best
      ? {
          name: best.name.replace(/市$/, "") || best.name,
          lat: best.lat,
          lng: best.lng,
          address: best.address,
        }
      : null;
    rememberResolved(key, value);
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

async function resolveHotel(
  query: string,
  city: CityOption,
): Promise<Place | undefined> {
  try {
    const results = await getProvider().search(query, {
      kind: "hotel",
      city: city.name,
      center: [city.lng, city.lat],
    });
    if (!results.length) return undefined;
    const best = [...results].sort(
      (a, b) => nameSimilarity(query, b.name) - nameSimilarity(query, a.name),
    )[0];
    return { ...best, category: "hotel" };
  } catch {
    return undefined;
  }
}

async function resolvePlaces(
  names: string[],
  city: CityOption,
): Promise<Place[]> {
  const results = await mapLimit(names.slice(0, 6), 3, async (name) => {
    try {
      const found = await getProvider().search(name, {
        kind: "any",
        city: city.name,
        center: [city.lng, city.lat],
      });
      if (!found.length) return null;
      const best = [...found].sort(
        (a, b) => nameSimilarity(name, b.name) - nameSimilarity(name, a.name),
      )[0];
      // 同名地物太多时宁可不要，也不把别的城市塞进行程。
      return nameSimilarity(name, best.name) >= 0.25 ? best : null;
    } catch {
      return null;
    }
  });
  return results.filter((item): item is Place => Boolean(item));
}

export async function askChatModel(
  config: ChatModelConfig,
  draft: ChatDraft,
  messages: { role: "user" | "assistant"; text: string }[],
): Promise<ChatReply> {
  const content = await callModel(config, draft, messages);
  const parsed = parseReply(content);

  const patch: ResolvedPatch = {};
  const lastUserText =
    [...messages].reverse().find((message) => message.role === "user")?.text ?? "";
  const lastAssistantText =
    [...messages].reverse().find((message) => message.role === "assistant")?.text ?? "";
  let city = draft.city;
  if (parsed.patch.city) {
    const nextName = parsed.patch.city;
    // 城市是硬约束：用户没点名就不许模型换城（原实现 !confirmed 无条件放行，
    // 用户只说「三天两人」时城市会被模型擅自改掉）。值不变=补确认，照常接受。
    if (shouldAcceptCity(nextName, draft.city.name, draft.confirmed.city, lastUserText)) {
      const resolved = await resolveCity(nextName);
      // 同名地物很多，地址里对不上城市名就宁可不用。
      if (
        resolved &&
        nameSimilarity(nextName, resolved.name) >= 0.6 &&
        (!resolved.address || resolved.address.includes(nextName))
      ) {
        city = resolved;
        patch.city = resolved;
      }
    }
  }
  // 草稿城市名出现在用户原话里就算确认，防止模型因为“值没变”漏写 city。
  if (!draft.confirmed.city && !patch.city && lastUserText.includes(draft.city.name)) {
    patch.city = draft.city;
  }
  if (parsed.patch.hotelQuery) {
    const query = parsed.patch.hotelQuery;
    // 用户说“随便/市中心”时不用再搜酒店，直接落到城市中心。
    const hotel = /市中心|默认|随便|都行|你定/.test(query)
      ? hotelForCity(city)
      : await resolveHotel(query, city);
    if (hotel) patch.hotel = hotel;
  }
  if (parsed.patch.hotelUndecided) patch.hotelUndecided = true;
  if (
    parsed.patch.selectedNames?.length &&
    gatePlacesClaim(parsed.patch.selectedNames, lastUserText)
  ) {
    // 点名景点是硬约束：只有用户原话真提了景点名才收，否则模型会把凭空列的
    // 景点塞进行程（用户说「没有，你安排」时尤其容易中招）。
    const places = await resolvePlaces(parsed.patch.selectedNames, city);
    if (places.length) patch.selectedPlaces = places;
  }
  if (parsed.patch.days !== undefined) patch.days = parsed.patch.days;
  if (parsed.patch.date !== undefined) {
    const affirmed =
      /^(对|是|是的|没错|嗯|好|行|可以|没问题|就这个|就这天)/.test(lastUserText.trim()) &&
      userStatedDate(lastAssistantText, parsed.patch.date);
    if (
      draft.confirmed.date ||
      userStatedDate(lastUserText, parsed.patch.date) ||
      affirmed
    ) {
      patch.date = parsed.patch.date;
    }
  }
  if (parsed.patch.pace !== undefined) patch.pace = parsed.patch.pace;
  if (parsed.patch.styles !== undefined) patch.styles = parsed.patch.styles;
  if (parsed.patch.experiences !== undefined) {
    patch.experiences = parsed.patch.experiences;
  }
  if (parsed.patch.transport !== undefined) {
    patch.transport = parsed.patch.transport;
  }
  if (parsed.patch.budgetTier !== undefined) {
    patch.budgetTier = parsed.patch.budgetTier;
  }
  if (parsed.patch.adults !== undefined) patch.adults = parsed.patch.adults;
  if (parsed.patch.children !== undefined) {
    patch.children = parsed.patch.children;
  }
  if (parsed.patch.seniors !== undefined) {
    patch.seniors = parsed.patch.seniors;
  }
  if (parsed.patch.avoidSteep !== undefined) {
    patch.avoidSteep = parsed.patch.avoidSteep;
  }
  if (parsed.patch.notes) patch.notes = parsed.patch.notes;

  // 两道守门，都以「用户本轮原话」为准，不信模型自报的默认值：
  // 1) 硬约束：人数模型常自己脑补，必须用户说过才收（城市/日期另有各自校验）。
  // 2) 可默认维度：节奏/出行/住处必须用户表过态或明确授权，否则会被打包塞进
  //    patch 让向导跳到 confirm，吞掉节奏和住处两轮（实测「这里少一轮问」）。
  const gated = gateHardConstraints(
    gateDefaultDimensions(patch, lastUserText),
    lastUserText,
  );

  return {
    say: parsed.say,
    patch: Object.keys(gated).length ? gated : undefined,
    cards: parsed.cards,
    action: parsed.action,
  };
}