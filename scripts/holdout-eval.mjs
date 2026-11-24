// 留出城市回归：这些城市不参与调参，每次工程改动后重跑，防止只对厦门/杭州过拟合。
const BASE = process.env.PLAN_BASE ?? "http://127.0.0.1:3000";
const DATE = process.env.HOLDOUT_DATE ?? "2026-11-22";
const DAYS = Number(process.env.HOLDOUT_DAYS ?? 3);

const CITIES = [
  {
    name: "西安",
    lng: 108.9398,
    lat: 34.3416,
    sea: false,
    experiences: ["sunset", "coast"],
  },
  {
    name: "大理",
    lng: 100.2676,
    lat: 25.6065,
    sea: false,
    experiences: ["sunset", "coast"],
  },
  {
    name: "拉萨",
    lng: 91.1409,
    lat: 29.6456,
    sea: false,
    experiences: ["sunset", "coast"],
  },
  {
    name: "北海",
    lng: 109.1193,
    lat: 21.4733,
    sea: true,
    experiences: ["coast", "sunset"],
  },
  {
    // 阳性对照：厦门是内置演示数据，用来确认沿海城市没有因为过滤过严而丢掉海边。
    name: "厦门",
    lng: 118.0894,
    lat: 24.4798,
    sea: true,
    demo: true,
    experiences: ["coast", "sunset"],
  },
];

const SEA_COPY =
  /海边|看海|海风|海岸|海浪|潮声|潮汐|沙滩|临海|海岛/;
const HONEST_ABSENCE = /暂时没有.*海边.*可选的点位/;
const XIAMEN_COPY = /鼓浪屿|曾厝垵|环岛路|厦大|厦门大学/;
const MAX_STOP_KM = 60;

function haversineKm(aLng, aLat, bLng, bLat) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function generatedText(plan) {
  const blocks = [];
  const push = (where, text) => {
    if (typeof text === "string" && text.trim()) blocks.push({ where, text });
  };
  push("meta.title", plan.meta.title);
  push("meta.sourceNote", plan.meta.sourceNote);
  for (const note of plan.meta.dataNotes ?? []) push("meta.note", note);
  push("meta.archetype", plan.meta.archetype?.summary);
  for (const warning of plan.warnings ?? []) push("warning", warning);
  for (const goal of plan.wishlist ?? []) {
    push("wishlist.label", goal.label);
    push("wishlist.reason", goal.reason);
    push("wishlist.band", goal.bandLabel);
  }
  for (const tip of plan.tips ?? []) {
    push(`tripTip:${tip.id}.title`, tip.title);
    push(`tripTip:${tip.id}.body`, tip.body);
  }
  for (const item of plan.budget?.items ?? []) {
    push(`budget:${item.key}.detail`, item.detail);
    push(`budget:${item.key}.note`, item.note);
  }
  for (const day of plan.days ?? []) {
    push(`D${day.index}.theme`, day.theme);
    push(`D${day.index}.area`, day.area);
    push(`D${day.index}.tip`, day.tip);
    push(`D${day.index}.strategy`, day.strategy);
    push(`D${day.index}.weather`, day.weather?.tip);
    for (const tip of day.tips ?? []) {
      push(`D${day.index}.tip:${tip.id}.title`, tip.title);
      push(`D${day.index}.tip:${tip.id}.body`, tip.body);
    }
    for (const alt of day.alternatives ?? []) {
      push(`D${day.index}.alt:${alt.name}.reason`, alt.reason);
    }
    for (const stop of day.stops ?? []) {
      push(`D${day.index}.${stop.place.name}.note`, stop.note);
      for (const attr of stop.attrs ?? []) {
        push(`D${day.index}.${stop.place.name}.attr`, attr);
      }
      for (const tip of stop.tips ?? []) {
        push(`D${day.index}.${stop.place.name}.tip.title`, tip.title);
        push(`D${day.index}.${stop.place.name}.tip.body`, tip.body);
      }
    }
  }
  return blocks;
}

function checkCity(city, plan, hotel) {
  const failures = [];
  const warnings = [];
  const fail = (code, detail) => failures.push(`${code}: ${detail}`);
  const warn = (code, detail) => warnings.push(`${code}: ${detail}`);
  const blocks = generatedText(plan);

  if (plan.meta.days !== DAYS) {
    fail("days", `请求 ${DAYS} 天，返回 ${plan.meta.days} 天`);
  }
  if (plan.meta.source === "demo" && !city.demo) {
    fail("source", "留出城市不应落到演示数据");
  }
  if (!plan.meta.archetype?.label) {
    fail("archetype", "缺少路线类型");
  }
  for (const day of plan.days) {
    const sights = day.stops.filter((stop) => stop.kind === "sight");
    if (!sights.length) fail("empty-day", `Day ${day.index} 没有景点`);
    else if (sights.length < 2) {
      warn("sparse-day", `Day ${day.index} 只有 ${sights.length} 个景点`);
    }
    if (day.stops.length < 2) {
      fail("thin-day", `Day ${day.index} 只有 ${day.stops.length} 个停留点`);
    }
    if (!(day.endMin > day.startMin)) {
      fail("time", `Day ${day.index} 时间轴异常 ${day.startMin}→${day.endMin}`);
    }
    const last = day.stops[day.stops.length - 1];
    if (last && day.endMin < last.endMin) {
      fail("time", `Day ${day.index} 结束早于最后停留点 ${last.place.name}`);
    }
    if (day.stops.length) {
      if (
        day.legs.length !== day.stops.length &&
        day.legs.length !== day.stops.length + 1
      ) {
        fail(
          "legs",
          `Day ${day.index} 路段数 ${day.legs.length}，停留点 ${day.stops.length}`,
        );
      }
      const first = day.legs[0];
      const final = day.legs[day.legs.length - 1];
      if (!first || first.fromName !== hotel.name) {
        fail("loop", `Day ${day.index} 未从酒店出发（${first?.fromName ?? "无"}）`);
      }
      if (!final || final.toName !== hotel.name) {
        fail("loop", `Day ${day.index} 未回到酒店（${final?.toName ?? "无"}）`);
      }
    }
    for (const alt of day.alternatives ?? []) {
      if (alt.distanceKm > 10.1) {
        fail("alt-far", `Day ${day.index} 备选 ${alt.name} ${alt.distanceKm} km`);
      }
      if (
        day.stops.some(
          (stop) =>
            stop.place.id === alt.placeId || stop.place.name === alt.name,
        )
      ) {
        fail("alt-duplicate", `Day ${day.index} 备选 ${alt.name} 已在当天路线里`);
      }
    }
    for (const stop of day.stops) {
      const flexibleSlot = stop.place.id.startsWith("flex-");
      if (
        stop.kind === "meal" &&
        stop.place.category !== "food" &&
        !flexibleSlot
      ) {
        fail("meal-kind", `${stop.place.name} 是 ${stop.place.category} 却当正餐`);
      }
      if (
        stop.kind === "cafe" &&
        stop.place.category !== "cafe" &&
        !flexibleSlot
      ) {
        fail("cafe-kind", `${stop.place.name} 是 ${stop.place.category} 却当茶歇`);
      }
      if (
        stop.kind === "sight" &&
        ["food", "cafe", "hotel"].includes(stop.place.category)
      ) {
        fail("sight-kind", `${stop.place.name} 是 ${stop.place.category} 却当景点`);
      }
      const km = haversineKm(city.lng, city.lat, stop.place.lng, stop.place.lat);
      if (km > MAX_STOP_KM) {
        fail(
          "stop-far",
          `${stop.place.name} 距市中心 ${km.toFixed(1)} km（${day.index} 天）`,
        );
      }
    }
  }

  const seenIds = new Map();
  const seenNames = new Map();
  for (const day of plan.days) {
    for (const stop of day.stops) {
      const key = stop.place.id;
      if (seenIds.has(key)) {
        fail(
          "duplicate",
          `${stop.place.name} 同时出现在 Day ${seenIds.get(key)} 和 Day ${day.index}`,
        );
      } else {
        seenIds.set(key, day.index);
      }
      const name = stop.place.name.replace(/\s+/g, "");
      if (stop.place.id.startsWith("flex-")) continue;
      if (seenNames.has(name)) {
        fail(
          "duplicate-name",
          `${stop.place.name} 重复出现在 Day ${seenNames.get(name)} 和 Day ${day.index}`,
        );
      } else {
        seenNames.set(name, day.index);
      }
    }
  }

  const coastGoals = (plan.wishlist ?? []).filter(
    (goal) => goal.experience === "coast",
  );
  if (city.sea === false) {
    for (const block of blocks) {
      if (HONEST_ABSENCE.test(block.text)) continue;
      const match = block.text.match(SEA_COPY);
      if (match) fail("sea-copy", `${block.where} → ${match[0]}｜${block.text}`);
    }
    for (const goal of coastGoals) {
      fail("coast-goal", `${goal.label}（${goal.placeName}）`);
    }
    if (city.experiences.includes("coast")) {
      const honest = (plan.warnings ?? []).some(
        (warning) => /海边/.test(warning) && /没有|暂无/.test(warning),
      );
      if (!honest) {
        fail("coast-honesty", "缺少「这座城市没有海边体验」的说明");
      }
    }
  } else {
    const SEA_PLACE =
      /海边|海滩|沙滩|海滨|海岸|海景|海风|看海|海岛|海浪|潮汐|浪花/;
    const seaStop = plan.days
      .flatMap((day) => day.stops)
      .find(
        (stop) =>
          !stop.place.id.startsWith("flex-") &&
          (stop.place.category === "beach" ||
            SEA_PLACE.test(`${stop.place.name} ${stop.place.note ?? ""}`)),
      );
    if (!coastGoals.length && !seaStop) {
      fail("coast-missing", "沿海对照城市既没有海边心愿，也没有海边点位");
    } else if (!coastGoals.length) {
      warn(
        "coast-missing",
        `海边点位进了路线（${seaStop.place.name}），但心愿单未生成海边体验`,
      );
    }
  }

  if (!city.demo) {
    for (const block of blocks) {
      if (XIAMEN_COPY.test(block.text)) {
        fail("xiamen-copy", `${block.where} → ${block.text}`);
      }
    }
  }

  for (const goal of plan.wishlist ?? []) {
    if (!goal.label.includes(goal.placeName)) {
      fail("wishlist-label", `${goal.experience}: ${goal.label} 不含 ${goal.placeName}`);
    }
  }

  return { failures, warnings };
}

async function planFor(city, noHotel) {
  const hotel = {
    id: `holdout-hotel-${city.name}`,
    name: `${city.name}市中心`,
    category: "hotel",
    lat: city.lat,
    lng: city.lng,
    city: city.name,
    source: "osm",
  };
  const body = {
    city: city.name,
    center: [city.lng, city.lat],
    days: DAYS,
    date: DATE,
    pace: "balanced",
    styles: ["citywalk"],
    experiences: city.experiences,
    transport: "auto",
    budgetTier: "comfort",
    adults: 2,
    children: 0,
    seed: 11,
    ...(noHotel ? { hotelUndecided: true } : { hotel }),
  };
  const response = await fetch(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.plan) {
    throw new Error(
      `HTTP ${response.status} ${data.error ?? ""} ${data.hint ?? ""}`.trim(),
    );
  }
  const plan = data.plan;
  if (noHotel) {
    const main = plan.lodging?.bases?.find((base) => base.role === "main");
    if (!main) {
      throw new Error(
        `未指定酒店时缺少推荐主落脚点（lodging.status=${plan.lodging?.status ?? "无"}）`,
      );
    }
    return { plan, hotel: { ...main, category: "hotel" } };
  }
  return { plan, hotel };
}

function checkLodging(plan, noHotel) {
  const failures = [];
  const fail = (code, detail) => failures.push(`${code}: ${detail}`);
  const lodging = plan.lodging;
  if (!noHotel) {
    if (lodging?.status !== "fixed") {
      fail("lodging-status", `指定了酒店但 status=${lodging?.status ?? "无"}`);
    }
    return failures;
  }
  if (!lodging) return ["lodging-missing: 未指定酒店时没有 lodging 方案"];
  if (lodging.status !== "recommended") {
    fail("lodging-status", `status=${lodging.status}`);
  }
  const bases = lodging.bases ?? [];
  const main = bases.filter((base) => base.role === "main");
  if (main.length !== 1) {
    fail("lodging-main", `主落脚点 ${main.length} 个`);
  }
  if (!lodging.headline || !lodging.summary) {
    fail("lodging-copy", "缺少 headline/summary");
  }
  if (!bases.length) fail("lodging-empty", "没有任何落脚基地");
  const lastNight = DAYS - 1;
  const mainBase = main[0];
  if (mainBase && lastNight > 0) {
    const covered = Array.from({ length: lastNight }, (_, i) => i + 1);
    const missing = covered.filter((night) => !(mainBase.nights ?? []).includes(night));
    if (missing.length) {
      fail("lodging-nights", `主落脚点未覆盖第 ${missing.join("、")} 晚`);
    }
  }
  for (const base of bases) {
    for (const night of base.nights ?? []) {
      if (!Number.isInteger(night) || night < 1 || night > lastNight) {
        fail("lodging-nights", `${base.name} 的 ${night} 晚超出 1–${lastNight}`);
      }
    }
    if (!base.reason) fail("lodging-reason", `${base.name} 没有推荐理由`);
    if (base.role === "optional" && !(base.nights?.length > 0)) {
      fail("lodging-nights", `可选换宿 ${base.name} 没有具体晚数`);
    }
  }
  const noted = (plan.meta.dataNotes ?? []).some((note) => /住宿还没定/.test(note));
  if (!noted) fail("lodging-note", "缺少「住宿还没定」的说明");
  return failures;
}

async function main() {
  const argv = process.argv.slice(2);
  const noHotel = argv.includes("--nohotel");
  const only = argv.filter((arg) => !arg.startsWith("-"));
  const targets = only.length
    ? CITIES.filter((city) => only.some((name) => city.name.includes(name)))
    : CITIES;
  if (!targets.length) {
    console.error(`没有匹配的城市。可选：${CITIES.map((city) => city.name).join("、")}`);
    process.exit(2);
  }

  let failed = 0;
  for (const city of targets) {
    console.log(
      `\n=== ${city.name} · ${DATE} · ${DAYS} 天${noHotel ? " · 住宿未知" : ""} ===`,
    );
    let result;
    try {
      result = await planFor(city, noHotel);
    } catch (error) {
      console.log(`FAIL request: ${error.message}`);
      failed += 1;
      continue;
    }
    const { plan, hotel } = result;
    const { failures, warnings } = checkCity(city, plan, hotel);
    failures.push(...checkLodging(plan, noHotel));
    console.log(
      `source=${plan.meta.source} archetype=${plan.meta.archetype?.label ?? "-"} wishlist=${plan.wishlist?.length ?? 0} 海边心愿=${
        (plan.wishlist ?? []).filter((goal) => goal.experience === "coast").length
      }`,
    );
    if (plan.wishlist?.length) {
      console.log(
        `心愿：${plan.wishlist
          .map((goal) => `${goal.experience}=${goal.placeName}`)
          .join("、")}`,
      );
    }
    for (const note of plan.meta.dataNotes ?? []) {
      console.log(`NOTE ${note}`);
    }
    if (plan.lodging) {
      console.log(
        `落脚：${plan.lodging.status} ${plan.lodging.strategy}｜${plan.lodging.headline}`,
      );
      for (const base of plan.lodging.bases ?? []) {
        console.log(
          `   基地 ${base.name}（${base.kind}/${base.role} · 第 ${base.nights.join("、")} 晚）：${base.reason}`,
        );
      }
    }
    for (const day of plan.days) {
      const sights = day.stops.filter((stop) => stop.kind === "sight");
      console.log(
        `D${day.index} ${day.theme}｜${day.area}｜景点 ${sights.length}｜停留 ${day.stops.length}｜${day.stats.distanceKm.toFixed(1)} km`,
      );
      console.log(
        `   ${day.stops.map((stop) => `${stop.place.name}[${stop.place.category}/${stop.kind}]`).join(" → ")}`,
      );
      if (day.alternatives?.length) {
        console.log(
          `   备选：${day.alternatives.map((alt) => `${alt.name}（${alt.distanceKm} km）`).join("、")}`,
        );
      }
    }
    for (const warning of warnings) console.log(`WARN ${warning}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
    if (failures.length) failed += 1;
    else console.log("PASS");
  }

  console.log(`\n结果：${targets.length - failed}/${targets.length} 城市通过`);
  process.exitCode = failed ? 1 : 0;
}

main();
