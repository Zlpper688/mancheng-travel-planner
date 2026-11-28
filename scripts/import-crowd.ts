/**
 * 把 24 小时采样转成 crowd-hours.ts 的条目（npx tsx scripts/import-crowd.ts <file>）。
 *
 * 输入格式（一个城市一个文件，可以多天多景点）：
 * {
 *   "city": "厦门",
 *   "samples": [
 *     {
 *       "name": "鼓浪屿",
 *       "date": "2026-11-21",
 *       "source": "manual",
 *       "note": "轮渡分时余票：10–11 点段 20 分钟内售罄",
 *       "hourly": [12, 8, 6, 5, 9, 18, 34, 52, 61, 78, 84, 62, 48, 55, 66, 72, 58, 40, 33, 26, 21, 15, 9, 4]
 *     }
 *   ]
 * }
 *
 * hourly 是「每小时到达人次 / 相对拥挤度」，24 个数，至少 1 天。
 * 同一景点多天会取均值——工作日与节假日差别大时，请分成两条样本、
 * 分别采样、分别录入，别把两种规律平均掉。
 *
 * 输出是可直接粘进 src/content/crowd-hours.ts 的 TS 片段，不自动改文件：
 * 这份数据会影响排线顺序与停留时长，人工过一眼再提交是值得的。
 */
import { readFileSync } from "node:fs";

interface Sample {
  name: string;
  date: string;
  source?: "manual" | "api" | "official";
  note?: string;
  hourly: number[];
}

interface Payload {
  city: string;
  samples: Sample[];
}

/** 阈值口径：用当天自己的均值做基准，避免「大景区 vs 小景点」的量纲问题。 */
const PEAK_RATIO = 1.35;
const VALLEY_RATIO = 0.65;

function clockText(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function windowsOf(
  hourly: number[],
  hit: (value: number, mean: number) => boolean,
  mean: number,
): string[] {
  // 只在实际有客流的时段里找窗口：开门前、收摊后的 0 不是「清静时段」，
  // 把它写成 valley 会变成「建议 0 点来」，比不给建议更糟。
  const active = hourly
    .map((value, hour) => ({ value, hour }))
    .filter((item) => item.value >= mean * 0.5);
  const from = active.length ? active[0].hour : 0;
  const to = active.length ? active[active.length - 1].hour + 1 : 24;

  const out: string[] = [];
  let start: number | null = null;
  for (let hour = from; hour < to; hour++) {
    const inside = hit(hourly[hour], mean);
    if (inside && start === null) start = hour;
    if (!inside && start !== null) {
      out.push(`${clockText(start)}-${clockText(hour)}`);
      start = null;
    }
  }
  if (start !== null) out.push(`${clockText(start)}-${clockText(to)}`);
  return out;
}

function mergeByPlace(samples: Sample[]): Map<string, Sample[]> {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = groups.get(sample.name) ?? [];
    list.push(sample);
    groups.set(sample.name, list);
  }
  return groups;
}

function parseIntoTs(payload: Payload): string {
  const lines: string[] = [];
  for (const [name, group] of mergeByPlace(payload.samples)) {
    const bad = group.find(
      (item) => !Array.isArray(item.hourly) || item.hourly.length !== 24,
    );
    if (bad) {
      console.error(`跳过「${name}」：hourly 必须是 24 个数（${bad.date}）`);
      continue;
    }
    const hourly = Array.from({ length: 24 }, (_, hour) => {
      const values = group.map((item) => Number(item.hourly[hour]) || 0);
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    });
    const total = hourly.reduce((sum, value) => sum + value, 0);
    if (total <= 0) {
      console.error(`跳过「${name}」：采样全是 0，没有可用的时段信号`);
      continue;
    }
    const mean = total / 24;
    const peak = windowsOf(hourly, (value) => value >= mean * PEAK_RATIO, mean);
    // 低谷要求「有人但不多」：开门前、关门后的 0 不该写成「清静时段」。
    const valley = windowsOf(
      hourly,
      (value, base) => value > base * 0.15 && value <= base * VALLEY_RATIO,
      mean,
    );
    const max = Math.max(...hourly);
    // 峰值是均值的 2.3 倍 → 停留 +33%（系数 0.25 是保守估计：排队只占停留的一部分），
    // 封顶 1.5 是为了不让一个极端样本把整天撑爆。
    const factor = Math.min(1.5, Math.max(1, 1 + (max / Math.max(1, mean) - 1) * 0.25));
    const dates = group.map((item) => item.date).sort();
    const sampledAt =
      dates.length > 1 ? `${dates[0]}~${dates[dates.length - 1]}` : dates[0];
    const source = group[0].source ?? "manual";
    const note = group[0].note ? JSON.stringify(group[0].note) : undefined;

    lines.push(
      `  {`,
      `    city: ${JSON.stringify(payload.city)},`,
      `    name: ${JSON.stringify(name)},`,
      `    peak: ${JSON.stringify(peak)},`,
      `    valley: ${JSON.stringify(valley)},`,
      `    factor: ${factor.toFixed(2)},`,
      `    source: ${JSON.stringify(source)},`,
      `    sampledAt: ${JSON.stringify(sampledAt)},`,
      ...(note ? [`    note: ${note},`] : []),
      `  },`,
    );
  }
  return lines.join("\n");
}

const file = process.argv[2];
if (!file) {
  console.error("用法: npx tsx scripts/import-crowd.ts data/crowd-samples/xiamen.json");
  process.exit(1);
}
const payload = JSON.parse(readFileSync(file, "utf8")) as Payload;
if (!payload.city || !Array.isArray(payload.samples) || !payload.samples.length) {
  console.error("文件里至少要有 city 与 samples[]");
  process.exit(1);
}
const snippet = parseIntoTs(payload);
if (!snippet) {
  console.error("没有可输出的条目");
  process.exit(1);
}
console.log("// 粘到 src/content/crowd-hours.ts 的 CROWD_HOURS 里：\n");
console.log(snippet);
