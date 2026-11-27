import { cached } from "./cache";

/**
 * 图片守门的 LLM 判定层。
 *
 * 为什么需要它：字符串标题匹配是"认名字"，不是"认地方"。
 *  - 用户大概记得名字（"洪崖洞夜市"），搜到的确实是洪崖洞，字符串守门会误杀；
 *  - 完全编造的地名，搜索引擎照样返回图，字符串守门只能事后挡，白搜一趟。
 * LLM 在搜图前判存在性、搜图后判语义相关性，两个方向都覆盖。
 *
 * 设计纪律：LLM 只是增强，不是唯一依赖。不可用时退回字符串守门（见 live-search），
 * 绝不因为模型抖动让本来能看的图全丢。
 */

export interface ExistenceJudgement {
  exists: boolean;
  confidence: number;
  corrected: string;
}

export interface JudgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

// 判定只用于增强守门，超时必须短：模型抖动不该让用户等十几秒。
const TIMEOUT = 6_000;
const EXIST_TTL = 7 * 24 * 60 * 60 * 1000;
let unavailableUntil = 0;

export function photoJudgeConfig(): JudgeConfig | null {
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

export function judgeReady(): boolean {
  return Date.now() >= unavailableUntil;
}

/**
 * 确定性前置拦截：明显的占位符/乱码不需要问 LLM，直接判不存在。
 * LLM 负责语义层面的模糊判断；这一层负责它偶尔漏判的低级情况。
 */
export function isObviouslyFake(city: string, name: string): boolean {
  const text = `${city} ${name}`;
  return (
    /(xyz|abc|qwerty|asdf|test\d*|不存在|随便编|胡编|瞎编|乱写|不是景点|假景点)/i.test(
      text,
    ) || !/[\u4e00-\u9fff]/.test(name)
  );
}

function coolDown(): void {
  unavailableUntil = Date.now() + 60_000;
}

/** 模型有时会把 JSON 包在 ``` 里，或前后带解释文字；这里容错提取对象。 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(cleaned.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function ask(config: JudgeConfig, prompt: string): Promise<Record<string, unknown> | null> {
  const payload = {
    model: config.model,
    temperature: 0.1,
    max_tokens: 220,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
  };
  type Payload = Omit<typeof payload, "response_format"> & {
    response_format?: { type: string };
  };
  const run = (body: Payload) =>
    fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });

  try {
    let response = await run(payload);
    // 少数兼容端点不认 response_format，去掉再试一次（与 chat/model.ts 一致）。
    if (response.status === 400) {
      response = await run({ ...payload, response_format: undefined });
    }
    if (!response.ok) {
      coolDown();
      return null;
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return parseJsonObject(data.choices?.[0]?.message?.content ?? "");
  } catch {
    coolDown();
    return null;
  }
}

/**
 * 搜图前判定：这个城市里的这个名字是不是真实存在的地点。
 * 名字记岔时给出 corrected，用它去搜；明显编造时 exists=false，直接不搜。
 */
export async function judgeExistence(
  city: string,
  name: string,
): Promise<ExistenceJudgement | null> {
  const config = photoJudgeConfig();
  if (!config || !judgeReady()) return null;
  const key = `photo-judge:exist:${city}|${name}`;
  return cached(key, EXIST_TTL, async () => {
    const prompt = [
      "你是旅游地点核验员。判断给定城市里的景点名是否指向一个真实存在的、值得旅游的地点。",
      "名字可能记错、有错别字或用了简称；如果能认出是哪个真实地点，给出它的标准名，并把 exists 设为 true。",
      "重要：只要你能给出具体、 recognizable 的标准景点名，就说明这地方真实存在，exists 必须为 true；不能一边给出真实标准名一边说不存在。",
      "只有完全认不出、明显是编造的乱码或虚构词时，才设 exists=false，corrected 原样返回。",
      "只输出 JSON：{\"exists\":true或false,\"confidence\":0到1,\"corrected\":\"标准名，认不出就原样\"}。",
      `城市：${city}`,
      `名称：${name}`,
    ].join("\n");
    const result = await ask(config, prompt);
    if (!result) return null;
    const exists = result.exists === true;
    const confidence = Number(result.confidence);
    const corrected = typeof result.corrected === "string" ? result.corrected.trim() : "";
    const cleanCorrected = corrected.slice(0, 80) || name;
    // 模型偶尔自相矛盾：给出真实标准名却把 exists 标 false。
    // 只要它认出了一个不同的、像真实地名的标准名，就按"记错名"处理。
    // 约束：必须含 2 个以上汉字、不含 xyz/测试 等占位词，避免编造地名被"纠正"后蒙混过关。
    const looksLikePlace =
      /[\u4e00-\u9fff]{2,}/.test(cleanCorrected) &&
      !/xyz|abc|不存在|随便|测试|test/i.test(cleanCorrected);
    const changedToRealName =
      cleanCorrected !== name && cleanCorrected.length >= 2 && looksLikePlace;
    return {
      exists: exists || changedToRealName,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      corrected: cleanCorrected,
    };
  }, { cacheIf: (value) => value !== null });
}

/**
 * 搜图后判定：候选标题里哪些确实拍的是这个景点。
 * 返回相关的下标数组；返回 null 表示 LLM 不可用，调用方退回字符串守门。
 */
export async function judgeRelevance(
  name: string,
  corrected: string,
  titles: string[],
): Promise<number[] | null> {
  const config = photoJudgeConfig();
  if (!config || !judgeReady() || titles.length === 0) return null;
  const result = await ask(
    config,
    [
      "你是图片相关性审核员。用户想看的是这个地点，标题可能用别名、简称、英文或不含完整地名。",
      "逐条判断：只要语义上确实是这个地点就算相关；别的地方、或只是含了某个字但讲的是别的事，算不相关。",
      `用户写的名称：${name}`,
      `核验后的标准名：${corrected}`,
      "只输出 JSON：{\"relevant\":[相关标题的数字下标数组]}。",
      "标题列表：",
      ...titles.slice(0, 12).map((title, index) => `${index}: ${title.slice(0, 140)}`),
    ].join("\n"),
  );
  const raw = result?.relevant;
  if (!Array.isArray(raw)) return null;
  return raw
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < titles.length);
}
