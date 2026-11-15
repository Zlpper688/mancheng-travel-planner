// 临时自检脚本：验证 AMAP_KEY 的可用性与配额归属，不输出 Key 本身
import fs from "node:fs";

const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const key = (env.match(/^AMAP_KEY=(.*)$/m)?.[1] || "").trim().replace(/^["']|["']$/g, "");

async function probe(label, path, params) {
  const qs = new URLSearchParams({ ...params, key });
  const url = `https://restapi.amap.com/v3${path}?${qs}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    const ok = data.status === "1";
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${label}  status=${data.status} infocode=${data.infocode} info=${data.info}`
    );
    return ok ? data : null;
  } catch (e) {
    console.log(`ERR   ${label}  ${e.message}`);
    return null;
  }
}

// 1. 关键字/周边搜索（基础搜索服务）
const search = await probe("place/text   基础搜索", "/place/text", {
  types: "110000",
  city: "110000",
  offset: "3",
  page: "1",
  extensions: "all",
});
const poi = search?.pois?.[0];
if (poi) {
  console.log(`      → 样本POI: ${poi.name} | biz_ext=${JSON.stringify(poi.biz_ext)}`);
}

// 2. 周边搜索
await probe("place/around 基础搜索", "/place/around", {
  location: "118.089,24.479",
  radius: "3000",
  types: "050000",
  offset: "3",
  extensions: "all",
});

// 3. 逆地理编码（基础LBS）
await probe("geocode/regeo 基础LBS", "/geocode/regeo", {
  location: "116.310,39.992",
  extensions: "base",
});

// 4. 步行路径规划（基础LBS）
await probe("direction/walk 基础LBS", "/direction/walking", {
  origin: "116.310,39.992",
  destination: "116.320,39.995",
});

// 5. 公交路径规划（基础LBS）
await probe("direction/transit 基础LBS", "/direction/transit/integrated", {
  origin: "116.310,39.992",
  destination: "116.380,39.990",
  city: "110000",
  cityd: "110000",
});
