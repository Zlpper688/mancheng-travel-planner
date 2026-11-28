/**
 * 分时人流（人工核实 / 平台采样）—— crowd.ts 里唯一被当作「实测」的来源。
 *
 * 为什么单独一个文件，而不是塞进 PLACE_PROFILES：
 *   profiles 里的是攻略型知识（门票、耗时、看点），可以靠公开资料整理；
 *   这里的每一条都必须有采样依据，会改变排线顺序、也会拉长停留时长，
 *   混在一起会让人分不清「哪条是听说、哪条是量过」。
 *
 * 填写纪律（重要）：
 *   1. 没有样本就不要填。空着只会退回按类别推断，标 heuristic；
 *      填一条编的，整套人流功能就变成了「看上去很懂」的幻觉。
 *   2. `source: "manual"` 至少要有一次现场观察或分时余票记录；
 *      `"api"` 要有平台接口与其文档；`"official"` 要有景区/文旅公告。
 *   3. `sampledAt` 写采样日期或区间，节假日与工作日的规律不同，别混成一条。
 *   4. `factor` 只在真的量到排队时长差异时填（1.0–1.5），
 *      没有就省略，默认 1.15——它决定「这一站要不要按更久算」。
 *
 * 采样格式：24 个小时桶的「到达人次 / 相对拥挤度」，用
 *   npx tsx scripts/import-crowd.ts data/crowd-samples/xiamen.json
 * 生成下面的条目，别手算分位数。
 */
export interface CrowdHoursEntry {
  /** 与 PLACE_PROFILES 同一套写法，例如 "厦门"。 */
  city: string;
  /** 与 PLACE_PROFILES.names 一致的整名，子景点不要继承整岛的规律。 */
  name: string;
  /** 拥挤时段，"HH:MM-HH:MM"，按开始时间升序。 */
  peak: string[];
  /** 相对清静的时段，同样格式。 */
  valley: string[];
  /** 拥挤对停留时长的放大系数，1.0–1.5。 */
  factor?: number;
  source: "manual" | "api" | "official";
  /** 采样日期或区间，例如 "2026-11-21" / "2026-10-01~10-07"。 */
  sampledAt: string;
  /** 一句话说明依据，例如「轮渡分时余票开售 20 分钟内 10–11 点段售罄」。 */
  note?: string;
}

/**
 * 目前为空：公开可查的只有「景区最大承载量与限流公告」这类日级信息，
 * 不足以支撑小时级窗口。填第一条之前请先看文件头的填写纪律。
 */
export const CROWD_HOURS: CrowdHoursEntry[] = [];
