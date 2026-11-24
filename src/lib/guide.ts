import { placeDistance } from "./geo";
import { nameSimilarity } from "./providers/normalize";
import type { GuideParseResult, GuideStop, Place } from "./types";

interface Section {
  day: number;
  text: string;
}

interface RawMatch {
  place: Place;
  position: number;
  matched: string;
  confidence: number;
}

const CN_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const GENERIC_TOKENS = new Set([
  "博物馆",
  "纪念馆",
  "美术馆",
  "步行街",
  "观景台",
  "观景平台",
  "风景区",
  "景区",
  "公园",
  "广场",
  "市场",
  "码头",
  "沙滩",
  "海滩",
  "海水浴场",
  "艺术区",
  "文化村",
  "咖啡馆",
  "餐厅",
  "酒店",
  "小吃",
  "海鲜",
  "日落",
  "日出",
  "拍照",
  "散步",
  "休息",
  "早餐",
  "午餐",
  "晚餐",
  "轮渡",
  "坐船",
  "返程",
  "街",
  "路",
  "巷",
]);

const GENERIC_SUFFIXES = [
  "海水浴场",
  "观景平台",
  "步行街",
  "博物馆",
  "纪念馆",
  "美术馆",
  "文化村",
  "艺术区",
  "风景区",
  "小吃街",
  "咖啡街",
  "观景台",
  "沙滩",
  "海滩",
  "公园",
  "广场",
  "市场",
  "码头",
  "花园",
  "教堂",
  "大桥",
  "景区",
  "寺",
  "庙",
];

const BLACKLISTED_QUERIES =
  /^(酒店|民宿|住处|房间|当地|这里|那里|附近|周边|市区|老城|老城区|街头|巷子|小店|地方|路线|行程|攻略|早餐|午餐|晚餐|日落|日出|海边|沙滩|山顶|岛上|车站|机场|码头)$/;

const TIME_WORDS = [
  "上午",
  "下午",
  "中午",
  "傍晚",
  "晚上",
  "早上",
  "清晨",
  "夜里",
  "白天",
  "早餐后",
  "午餐后",
  "晚餐后",
  "然后",
  "接着",
  "之后",
  "最后",
  "先",
  "再",
  "顺便",
  "顺路",
  "可以",
  "建议",
  "记得",
  "不要",
  "别",
];

const LEADING_VERBS = [
  "步行前往",
  "打车前往",
  "坐船前往",
  "前往",
  "走到",
  "逛逛",
  "参观",
  "游览",
  "打卡",
  "坐船",
  "乘船",
  "返回",
  "回到",
  "入住",
  "出发",
  "吃",
  "喝",
  "逛",
  "看",
  "游",
  "去",
  "到",
  "在",
  "从",
];

const HEADER_START =
  /^(?:[#>*\-\s]*)(?:(?:day|d)\s*0?(\d{1,2})|第\s*([一二三四五六七八九十两0-9]{1,3})\s*天)\s*(?:[｜|:：\-—·、.]\s*)?(.*)$/i;

function parseCnNumber(value: string): number | null {
  const token = value.trim();
  if (!token) return null;
  if (/^\d+$/.test(token)) return Number(token);
  if (token === "十") return 10;
  if (token.includes("十")) {
    const [left, right] = token.split("十");
    const tens = left ? CN_DIGITS[left] ?? 0 : 1;
    const ones = right ? CN_DIGITS[right] ?? 0 : 0;
    return tens * 10 + ones;
  }
  const values = [...token]
    .map((char) => CN_DIGITS[char])
    .filter((entry) => entry !== undefined);
  return values.length === 1 ? values[0] : null;
}

function splitSections(text: string): Section[] {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(
      /([。；;！!?])\s*(?=(?:day|d)\s*\d|第\s*[一二三四五六七八九十两0-9]+\s*天)/gi,
      "$1\n",
    );
  const sections: Section[] = [];
  let currentDay = 0;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (currentDay === 0 && !body) return;
    sections.push({ day: Math.min(14, currentDay || 1), text: body });
    buffer = [];
  };

  for (const line of normalized.split("\n")) {
    const match = line.match(HEADER_START);
    if (match) {
      const parsed = parseCnNumber(match[1] ?? match[2] ?? "");
      if (parsed && parsed >= 1) {
        flush();
        currentDay = parsed;
        const rest = (match[3] ?? "").trim();
        if (rest) buffer.push(rest);
        continue;
      }
    }
    if (!currentDay) currentDay = 1;
    buffer.push(line);
  }
  flush();
  return sections.filter((section) => section.text || section.day > 0);
}

function guideClean(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s·•|｜\-—_,，。.:：;；'"“”‘’!！?？、/\\<>《》]/g, "")
    .trim();
}

function buildNameCandidates(name: string): string[] {
  const set = new Set<string>();
  const add = (value: string) => {
    const clean = guideClean(value);
    if (clean.length < 2 || GENERIC_TOKENS.has(clean)) return;
    set.add(clean);
  };
  add(name);
  const raw = name.toLowerCase();
  for (const match of raw.matchAll(/[（(【\[]([^）)】\]]+)[）)】\]]/g)) {
    add(match[1]);
  }
  const withoutParen = raw.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, "");
  for (const part of withoutParen.split(/[·•|｜/\-—]/)) add(part);
  const base = guideClean(withoutParen);
  for (const suffix of GENERIC_SUFFIXES) {
    if (base.endsWith(suffix) && base.length - suffix.length >= 3) {
      add(base.slice(0, -suffix.length));
    }
  }
  if (base.length > 5) {
    for (let length = base.length - 1; length >= 4; length--) {
      const suffix = base.slice(-length);
      if (!GENERIC_TOKENS.has(suffix)) add(suffix);
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

function matchPlaces(text: string, pool: Place[]): RawMatch[] {
  const matches: RawMatch[] = [];
  const seenIds = new Set<string>();
  for (const place of pool) {
    if (seenIds.has(place.id)) continue;
    seenIds.add(place.id);
    if (place.category === "hotel" || place.category === "other") continue;
    const candidates = buildNameCandidates(place.name);
    const base = guideClean(place.name);
    let best: { candidate: string; position: number } | null = null;
    for (const candidate of candidates) {
      const position = text.indexOf(candidate);
      if (position < 0) continue;
      if (
        !best ||
        candidate.length > best.candidate.length ||
        (candidate.length === best.candidate.length && position < best.position)
      ) {
        best = { candidate, position };
      }
    }
    if (!best) continue;
    const exact = base === best.candidate || best.candidate.length >= base.length;
    matches.push({
      place,
      position: best.position,
      matched: best.candidate,
      confidence: exact
        ? 0.96
        : Math.min(0.9, 0.68 + best.candidate.length * 0.025),
    });
  }

  const accepted: RawMatch[] = [];
  for (const match of matches.sort(
    (a, b) =>
      b.matched.length - a.matched.length || b.confidence - a.confidence,
  )) {
    const start = match.position;
    const end = start + match.matched.length;
    const overlaps = accepted.some((existing) => {
      const existingStart = existing.position;
      const existingEnd = existingStart + existing.matched.length;
      const intersection = Math.max(
        0,
        Math.min(end, existingEnd) - Math.max(start, existingStart),
      );
      const smaller = Math.min(
        end - start,
        existingEnd - existingStart,
      );
      return intersection > 0.6 * smaller;
    });
    if (!overlaps) accepted.push(match);
  }

  const deduped: RawMatch[] = [];
  for (const match of accepted.sort((a, b) => a.position - b.position)) {
    const duplicate = deduped.some(
      (existing) =>
        existing.place.id === match.place.id ||
        (placeDistance(existing.place, match.place) < 0.3 &&
          nameSimilarity(existing.place.name, match.place.name) > 0.55),
    );
    if (!duplicate) deduped.push(match);
  }
  return deduped;
}

function cleanQuery(clause: string): string {
  let value = clause.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of [...TIME_WORDS, ...LEADING_VERBS]) {
      if (value.startsWith(word)) {
        value = value.slice(word.length).trim();
        changed = true;
      }
    }
  }
  value = value
    .replace(
      /(附近|一带|周边|方向|转转|走走|逛逛|看看|吃点|喝点|休息一下|拍照|打卡|看日落|看日出|吃午饭|吃晚饭|吃饭|早餐|午餐|晚餐|后返回|然后返回|再回|回酒店|回住处|后)$/,
      "",
    )
    .trim();
  return value.replace(/[「」“”"'《》]/g, "");
}

function extractQueries(residue: string): string[] {
  const clauses = residue
    .split(/[。；;！!?？\n，,]/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const queries: string[] = [];
  for (const clause of clauses) {
    const query = cleanQuery(clause);
    if (query.length < 2 || query.length > 16) continue;
    if (!/[\u4e00-\u9fa5a-zA-Z]/.test(query)) continue;
    if (BLACKLISTED_QUERIES.test(query)) continue;
    if (queries.includes(query)) continue;
    queries.push(query);
  }
  return queries;
}

export interface ParseGuideOptions {
  search?: (query: string) => Promise<Place[]>;
  maxSearches?: number;
}

export async function parseGuide(
  text: string,
  pool: Place[],
  options: ParseGuideOptions = {},
): Promise<GuideParseResult> {
  const sections = splitSections(text);
  const stops: GuideStop[] = [];
  const unmatched: { day: number; query: string }[] = [];
  const notes: string[] = [];
  let rawCount = 0;
  let searchBudget = options.maxSearches ?? 6;
  const seenPlaces = new Set<string>();

  for (const section of sections) {
    const matches = matchPlaces(section.text, pool);
    rawCount += matches.length;
    let residue = section.text;
    for (const match of matches) {
      residue = residue.split(match.matched).join("，");
    }
    const ordered: GuideStop[] = matches.map((match) => ({
      day: section.day,
      query: match.place.name,
      place: match.place,
      confidence: match.confidence,
    }));

    const queries = extractQueries(residue);
    for (const query of queries) {
      if (searchBudget <= 0) break;
      if (ordered.length + unmatched.length >= 60) break;
      if (!options.search) {
        unmatched.push({ day: section.day, query });
        continue;
      }
      searchBudget--;
      try {
        const results = await options.search(query);
        const best = results
          .filter(
            (place) => place.category !== "hotel" && place.category !== "other",
          )
          .map((place) => ({
            place,
            similarity: Math.max(
              nameSimilarity(query, place.name),
              place.name.includes(query) || query.includes(place.name) ? 0.7 : 0,
            ),
          }))
          .sort((a, b) => b.similarity - a.similarity)[0];
        if (best && best.similarity >= 0.45) {
          ordered.push({
            day: section.day,
            query,
            place: best.place,
            confidence: Math.min(0.7, 0.45 + best.similarity * 0.25),
          });
          rawCount++;
        } else {
          unmatched.push({ day: section.day, query });
        }
      } catch {
        unmatched.push({ day: section.day, query });
      }
    }

    for (const stop of ordered.slice(0, 12)) {
      if (!stop.place) continue;
      const key = `${section.day}-${stop.place.id}`;
      if (seenPlaces.has(key)) continue;
      seenPlaces.add(key);
      stops.push(stop);
    }
  }

  if (sections.length <= 1 && text.length > 240) {
    notes.push("没有识别到「Day 1 / 第二天」这类分段标记，已按一天解析。");
  }
  if (unmatched.length) {
    notes.push(`有 ${unmatched.length} 个片段没能在地图上确认，可补充全称或在行程里手动加点。`);
  }
  if (!stops.length) {
    notes.push("没有匹配到地图上的地点，试试用更完整的景点或店名。");
  }

  return {
    stops: stops.sort((a, b) => a.day - b.day),
    days: sections.reduce((max, section) => Math.max(max, section.day), 1),
    rawCount,
    unmatched,
    notes,
  };
}
