/**
 * 生成本地城市索引：把知识库里已经核实过的目的地中心点，变成前端搜索可直接用的表。
 *
 * 为什么需要：城市搜索原本只走 Photon，而 Photon 在国内网络经常不可达
 * （实测单次 10.7s，且多个城市返回 0 条）。用户打的第一个字就卡在这里，
 * 而这座城市的坐标我们**本来就有**——122 个目的地的中心点都躺在知识库里。
 *
 * 跑法：node scripts/build-city-index.mjs
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ENRICH_DIR = path.join(ROOT, "data/knowledge/enrichment");
const INDEX_FILE = path.join(ROOT, "data/knowledge/index.json");
const OUT_FILE = path.join(ROOT, "src/content/cities.generated.ts");

async function main() {
  const index = JSON.parse(await fs.readFile(INDEX_FILE, "utf8"));
  const regionOf = new Map();
  for (const city of index.cities ?? []) {
    if (city?.city) regionOf.set(city.city, city.region ?? "");
  }

  const files = (await fs.readdir(ENRICH_DIR)).filter((name) => name.endsWith(".json"));
  const rows = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(ENRICH_DIR, file), "utf8"));
    } catch {
      continue;
    }
    const name = data?.city ?? file.replace(/\.json$/, "");
    const center = data?.center;
    if (!Array.isArray(center) || center.length !== 2) continue;
    const [lng, lat] = center.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    rows.push({
      name,
      region: regionOf.get(name) ?? "",
      lat: Number(lat.toFixed(5)),
      lng: Number(lng.toFixed(5)),
    });
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

  const lines = rows
    .map(
      (row) =>
        `  { name: ${JSON.stringify(row.name)}, region: ${JSON.stringify(row.region)}, lat: ${row.lat}, lng: ${row.lng} },`,
    )
    .join("\n");

  const content = `/**
 * 本地目的地索引 —— **自动生成，请勿手改**。
 * 生成脚本：scripts/build-city-index.mjs
 *
 * 数据来源：data/knowledge/enrichment/*.json 的 center 字段（联网核实过的真实坐标）。
 * 作用：城市搜索的第一层，零延迟、离线可用；只有本地没有时才去问外部地理编码。
 */

export interface LocalCity {
  name: string;
  /** 省级行政区或分区，用于展示与消歧。 */
  region: string;
  lat: number;
  lng: number;
}

export const LOCAL_CITIES: LocalCity[] = [
${lines}
];

/** 名字 -> 城市，供按名精确查坐标。 */
export const LOCAL_CITY_BY_NAME: Map<string, LocalCity> = new Map(
  LOCAL_CITIES.map((city) => [city.name, city]),
);
`;

  await fs.writeFile(OUT_FILE, content, "utf8");
  console.log(`写出 ${rows.length} 个目的地 -> ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
