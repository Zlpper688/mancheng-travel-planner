import { cached } from "../cache";
import {
  DAY_COLORS,
  PACES,
  STYLE_LABELS,
} from "../constants";
import { TravelError } from "../errors";
import { addDaysISO, formatDateRange, placeDistance } from "../geo";
import { crowdFactor, getHoliday } from "../holidays";
import { getProvider } from "../providers";
import type { DiscoverOptions, DiscoverResult } from "../providers/types";
import { cityShortName } from "../providers/normalize";
import {
  fetchTripWeather,
  pickDayWeather,
  summarizeRainWindows,
  weatherTip,
  type WeatherCore,
} from "../weather";
import type {
  DayPlan,
  PaceId,
  PlanMeta,
  PlanResult,
  Place,
  TripInput,
} from "../types";
import { selectTips } from "../tips/engine";
import { enrichPlacesFromWikidata } from "../wikidata";
import { auditPlan } from "./audit";
import { buildBudget } from "./budget";
import { alternativesFor, buildWishlist, EXPERIENCE_DEFS } from "./experience";
import { alignLodgingNights, planLodging } from "./lodging";
import { routeArchetypeOf, type RouteArchetype } from "./route-archetype";
import { scheduleDay } from "./schedule";
import { distributeSelectedPlaces } from "./selected";
import { selectDays } from "./select";
import { farLimitKm } from "./select/far";
import { avoidSteepFor, steepnessOf } from "./strenuous";
import { explainDay } from "./why";

// 有老人同行时整体降一档节奏，避免“充实”被理解成赶场。
function seniorPace(input: TripInput): PaceId {
  if (!input.seniors) return input.pace;
  return input.pace === "packed" ? "balanced" : "chill";
}

export function discoverRadius(input: TripInput): number {
  let radius = 8 + input.days * 3;
  const styles = new Set(input.styles);
  const pace = seniorPace(input);
  if (input.transport === "drive") radius += 5;
  if (pace === "packed") radius += 2;
  if (styles.has("citywalk")) radius -= 3;
  if (styles.has("coastal")) radius += 3;
  if (styles.has("family")) radius -= 1;
  if (input.seniors) radius -= 1.5;
  return Math.max(6, Math.min(30, radius));
}

export function discoverReach(input: TripInput): number {
  const near = discoverRadius(input);
  if (input.farDays === 0 || input.days < 2) return near;
  // 远足日按“可当日往返的上限”搜索；否则小城的名山、古寺在选点前就被近处半径裁掉。
  return Math.min(50, Math.max(near + 18, farLimitKm(input.styles)));
}

export async function discoverForTrip(input: TripInput): Promise<DiscoverResult> {
  const provider = getProvider();
  const center: [number, number] | undefined =
    input.center ??
    (input.hotel ? [input.hotel.lng, input.hotel.lat] : undefined);
  if (!center) {
    throw new TravelError(
      "还没有搜索中心",
      "INVALID_INPUT",
      "请先选择城市；住宿可以之后再定。",
    );
  }
  const discoveryAnchor: Place = input.hotel ?? {
    id: "discovery-center",
    name: `${input.city}市中心`,
    category: "hotel",
    lat: center[1],
    lng: center[0],
    city: input.city,
    source: "demo",
  };
  const radiusKm = discoverReach(input);
  const options: DiscoverOptions = {
    city: input.city,
    center,
    hotel: discoveryAnchor,
    radiusKm,
    days: input.days,
    styles: input.styles,
  };
  const key = [
    "discover",
    "v8",
    provider.source,
    input.city,
    center[0].toFixed(3),
    center[1].toFixed(3),
    radiusKm,
    input.days,
    input.styles.join(","),
    input.farDays ?? "auto",
  ].join(":");
  return cached(
    key,
    10 * 60 * 1000,
    () => provider.discover(options),
    // 上游超时偶尔会返回空列表；这种结果绝不能缓存 10 分钟，
    // 否则一次网络抖动就会让整座城市在缓存期内都排不出行程。
    { cacheIf: (value) => value.sights.length > 0 },
  );
}

function buildMeta(
  input: TripInput,
  discovered: DiscoverResult,
  days: DayPlan[],
  farDays: number,
  weatherKind?: "forecast" | "climate" | "mixed",
  selectedDays = 0,
  archetype?: RouteArchetype,
  lodging?: PlanResult["lodging"],
): PlanMeta {
  const holiday = getHoliday(input.date);
  const selectedCount = input.selectedPlaces?.length ?? 0;
  const guideCount = input.fixedPlaces?.length ?? 0;
  const isFixed = Boolean(guideCount || selectedCount);
  const fixedKind: PlanMeta["fixedKind"] =
    guideCount && selectedCount
      ? "mixed"
      : selectedCount
        ? "selected"
        : guideCount
          ? "guide"
          : undefined;
  const travelers = Math.max(
    1,
    input.adults + input.children + (input.seniors ?? 0),
  );
  const styleTitle =
    fixedKind === "selected"
      ? `自选 ${selectedCount} 景点`
      : fixedKind === "mixed"
        ? "攻略 + 自选"
        : fixedKind === "guide"
          ? "攻略复刻"
          : input.styles
              .slice(0, 2)
              .map((style) => STYLE_LABELS[style])
              .join(" × ");
  const city = cityShortName(input.city);
  const dataNotes = [...discovered.notes];
  if (discovered.source === "open") {
    dataNotes.push("步行与驾车为真实路径，公交耗时为估算；配置高德 Key 后可精确到线路与班次。");
  }
  if (discovered.source === "demo") {
    dataNotes.push("步行与驾车为真实路径，公交耗时为估算；配置高德 Key 后可精确到线路与班次。");
  }
  if (input.seniors) {
    dataNotes.push(
      `同行有 ${input.seniors} 位老人：节奏已放缓，优先平路与可随时坐下休息的片区；自动选点已避开需要爬山、登顶或走长台阶的点位（你点名的地点仍会保留）。`,
    );
  } else if (avoidSteepFor(input)) {
    dataNotes.push(
      "按你的补充要求，自动选点已避开需要爬山、登顶或走长台阶的点位（你点名的地点仍会保留）。",
    );
  }
  if (input.notes) {
    dataNotes.push(`按你的补充要求排线：${input.notes.slice(0, 120)}`);
  }
  if (selectedCount) {
    dataNotes.push(
      selectedDays > 0
        ? `已把你勾选的 ${selectedCount} 个景点按片区拆到 ${selectedDays} 天，其余日期由漫城自动补位。`
        : "勾选的景点与攻略中的固定点位重复，已自动合并。",
    );
  }
  if (fixedKind === "guide") {
    dataNotes.push("导入攻略的日期按攻略站点顺序规划，其余日期由漫城自动排线。");
  }
  if (fixedKind === "mixed") {
    dataNotes.push("攻略固定点与自选景点已合并，优先占用不同日期，其余日期自动排线。");
  }
  if (archetype) {
    dataNotes.push(`${archetype.label}：${archetype.summary}`);
  }
  if (farDays > 0) {
    dataNotes.push(
      farDays === 1
        ? "其中 1 天安排给较远但出名的景点，集中走一个方向，其余天在住处附近慢逛。"
        : `其中 ${farDays} 天留给较远但出名的景点，按方向成组安排，一天只走一条线。`,
    );
  }
  if (lodging?.status === "recommended") {
    const main = lodging.bases.find((base) => base.role === "main");
    if (main) {
      dataNotes.push(
        `住宿还没定：已按点位分布推荐「${main.name}」作为落脚片区，具体酒店在这一带自选。`,
      );
    }
    const optional = lodging.bases.filter((base) => base.role === "optional");
    if (optional.length) {
      dataNotes.push(
        `可选换宿：${optional
          .map((base) =>
            base.nights.length
              ? `第 ${base.nights.join("、")} 晚住「${base.name}」`
              : `在「${base.name}」补住 1 晚`,
          )
          .join("；")}。不换宿就每天回主落脚点，行程照样成立。`,
      );
    }
  }
  if (weatherKind) {
    dataNotes.push(
      weatherKind === "forecast"
        ? "天气与日照来自 Open-Meteo 预报，出发前再核对一次。"
        : weatherKind === "climate"
          ? "行程日期超出天气预报范围，天气按去年同期气候估算，出发前一周再看预报。"
          : "部分日期超出天气预报范围，已用去年同期气候补全，出发前一周再看预报。",
    );
  }
  dataNotes.push("预算为带区间的估算，房价与门票以预订页和现场为准。");

  return {
    city,
    title: `${city} · ${input.days} 日${styleTitle}`,
    subtitle: `${formatDateRange(input.date, input.days)} · ${travelers} 人 · ${PACES[seniorPace(input)].label}节奏`,
    startDate: input.date,
    endDate: addDaysISO(input.date, Math.max(0, input.days - 1)),
    days: input.days,
    travelers,
    source: discovered.source,
    sourceNote: discovered.sourceNote,
    dataNotes: Array.from(new Set(dataNotes)),
    holiday: holiday ?? undefined,
    isFixed,
    fixedKind,
    archetype: archetype
      ? {
          id: archetype.id,
          label: archetype.label,
          summary: archetype.summary,
        }
      : undefined,
    generatedAt: new Date().toISOString(),
  };
}

function pickRainBackup(
  sights: Place[],
  planned: Set<string>,
  anchor: Place,
): Place | null {
  let best: Place | null = null;
  let bestScore = -Infinity;
  for (const place of sights) {
    if (place.category !== "museum" || planned.has(place.id)) continue;
    const km = placeDistance(anchor, place);
    if (km > 6) continue;
    const score = (place.popularity ?? place.rating ?? 3) - km * 0.2;
    if (score > bestScore) {
      best = place;
      bestScore = score;
    }
  }
  return best;
}

export async function planTrip(input: TripInput): Promise<PlanResult> {
  const provider = getProvider();
  const discovered = await discoverForTrip(input);
  const radiusKm = discoverRadius(input);
  const holiday = getHoliday(input.date);
  const crowd = crowdFactor(input.date);
  const pace = seniorPace(input);
  const avoidSteep = avoidSteepFor(input);
  // 自动选点、心愿单、备选和空档补位共用同一套“避开爬坡”口径，
  // 否则手册里仍会推荐爬山点，和行程自相矛盾。
  // 用户手动移除 / 替换掉的点位，在进入选点与餐食插入之前就剔掉，
  // 否则「移除」之后重排，同一个点会被发现流程原样塞回来。
  const excludeIds = new Set(input.excludeIds ?? []);
  const planSights = (
    avoidSteep
      ? discovered.sights.filter(
          (place) => steepnessOf(input.city, place) !== "core",
        )
      : discovered.sights
  ).filter((place) => !excludeIds.has(place.id));
  const planMeals = excludeIds.size
    ? discovered.meals.filter((place) => !excludeIds.has(place.id))
    : discovered.meals;

  // 酒店不是出发前必须知道的事：没定住处时，先按点位分布推荐落脚片区，
  // 后面的选点、排线和预算都用这个“基地”作为每天往返的锚点。
  const lodging = planLodging(input, planSights);
  const base = lodging.base;
  const trip: TripInput = { ...input, hotel: base };

  const archetype = routeArchetypeOf({
    days: input.days,
    pace,
    styles: input.styles,
    farDays: input.farDays,
  });
  const wishlist = buildWishlist(input.city, planSights, 14).filter(
    (goal) => !avoidSteep || goal.experience !== "hike",
  );

  const selectedPlan = input.selectedPlaces?.length
    ? distributeSelectedPlaces(input.selectedPlaces, {
        days: input.days,
        pace,
        hotel: base,
        fixedPlaces: input.fixedPlaces,
      })
    : null;
  const fixedPlaces = selectedPlan?.fixedPlaces ?? input.fixedPlaces;
  const fixedSource: "guide" | "selected" | "mixed" | undefined =
    input.fixedPlaces?.length && input.selectedPlaces?.length
      ? "mixed"
      : input.selectedPlaces?.length
        ? "selected"
        : input.fixedPlaces?.length
          ? "guide"
          : undefined;

  const selection = selectDays({
    sights: planSights,
    hotel: base,
    days: input.days,
    pace,
    styles: input.styles,
    seed: input.seed,
    radiusKm,
    transport: input.transport,
    city: input.city,
    fixedPlaces,
    fixedSource,
    farDays: input.farDays,
    farCap: archetype.maxFarDays,
    experiences: input.experiences,
    seniors: input.seniors ?? 0,
    avoidSteep,
    notes: input.notes,
  });

  const warnings: string[] = [];
  if (selectedPlan?.warnings.length) warnings.push(...selectedPlan.warnings);
  const usedMealIds = new Set<string>();
  const days: DayPlan[] = [];
  const usedPlaceIds = new Set(
    selection.days.flatMap((seedDay) =>
      seedDay.places.map((place) => place.id),
    ),
  );

  const weather = await fetchTripWeather(
    selection.days.map((seedDay) => {
      const anchor =
        seedDay.places.find((place) => place.category !== "hotel") ?? base;
      return { lat: anchor.lat, lng: anchor.lng };
    }),
    input.date,
    input.days,
  );
  const weatherByDay = new Map<number, WeatherCore | null>();

  for (const seedDay of selection.days) {
    const date = addDaysISO(input.date, seedDay.index - 1);
    const anchor =
      seedDay.places.find((place) => place.category !== "hotel") ?? base;
    const core = weather
      ? pickDayWeather(weather, anchor.lat, anchor.lng, date)
      : null;
    weatherByDay.set(seedDay.index, core);
    const result = await scheduleDay({
      seedDay,
      hotel: base,
      meals: planMeals,
      city: input.city,
      family:
        input.children > 0 ||
        (input.seniors ?? 0) > 0 ||
        input.styles.includes("family"),
      date,
      pace,
      styles: input.styles,
      transport: input.transport,
      crowd,
      color: DAY_COLORS[(seedDay.index - 1) % DAY_COLORS.length],
      seed: input.seed,
      dayIndex: seedDay.index,
      provider,
      usedMealIds,
      weather: core,
      spares: planSights.filter((place) => !usedPlaceIds.has(place.id)),
    });
    days.push(result.plan);
    for (const stop of result.plan.stops) {
      usedPlaceIds.add(stop.place.id);
    }
    warnings.push(
      ...result.warnings.map((warning) =>
        /^第\s*\d+\s*天/.test(warning)
          ? warning
          : `第 ${seedDay.index} 天：${warning}`,
      ),
    );
  }

  // 「为什么这么排」放在天气写回之后算：日出日落时间要拿来解释出发时间。
  const seedByDay = new Map(selection.days.map((seed) => [seed.index, seed]));
  for (const day of days) {
    const seed = seedByDay.get(day.index);
    if (seed) day.why = explainDay({ day, seed, input });
  }

  warnings.push(...selection.warnings);

  const plannedIds = new Set(
    days.flatMap((day) => day.stops.map((stop) => stop.place.id)),
  );
  const wanted = input.experiences ?? [];
  if (wanted.length) {
    const missed = wishlist.filter(
      (goal) =>
        wanted.includes(goal.experience) && !plannedIds.has(goal.placeId),
    );
    if (missed.length) {
      warnings.push(
        `这次没排进「${missed
          .map((goal) => goal.label)
          .slice(0, 2)
          .join("」「")}」：点位离住处较远或当天不顺路，给一个远足日更合适。`,
      );
    }
    const available = new Set(wishlist.map((goal) => goal.experience));
    const absent = wanted.filter((id) => !available.has(id));
    if (absent.length) {
      warnings.push(
        `这座城市暂时没有「${absent
          .map((id) => EXPERIENCE_DEFS[id].label)
          .join("」「")}」可选的点位，已按相近主题补位。`,
      );
    }
  }

  if (weather) {
    const planned = new Set(
      days.flatMap((day) => day.stops.map((stop) => stop.place.id)),
    );
    for (const day of days) {
      const core = weatherByDay.get(day.index);
      if (!core) continue;
      const anchor =
        day.stops.find((stop) => stop.kind === "sight")?.place ?? base;
      const windows = summarizeRainWindows(core);
      const wet =
        (core.precipProb ?? 0) >= 50 ||
        (core.precipMm ?? 0) >= 2 ||
        windows.some((window) => window.mm >= 1);
      const backup = wet
        ? pickRainBackup(planSights, planned, anchor)
        : null;
      const lastSightEndMin = [...day.stops]
        .reverse()
        .find((stop) => stop.kind === "sight")?.endMin;
      day.weather = {
        code: core.code,
        label: core.label,
        icon: core.icon,
        tMax: core.tMax,
        tMin: core.tMin,
        precipProb: core.precipProb,
        precipMm: core.precipMm,
        windKmh: core.windKmh,
        sunrise: core.sunrise,
        sunset: core.sunset,
        estimated: core.estimated,
        source: core.source,
        tip: weatherTip(core, lastSightEndMin),
        backup: backup ? { placeId: backup.id, name: backup.name } : undefined,
        hourly: core.hourly,
        rainWindows: windows.length ? windows : undefined,
      };
      const severe =
        !core.estimated &&
        (core.code >= 95 ||
          core.code === 65 ||
          core.code === 82 ||
          (core.precipProb ?? 0) >= 85 ||
          core.tMax >= 37 ||
          core.tMin <= -10);
      if (severe) {
        const reason =
          core.code >= 95
            ? "有雷雨"
            : core.code === 65 || core.code === 82
              ? "有大雨"
              : (core.precipProb ?? 0) >= 85
                ? "降雨概率很高"
                : core.tMax >= 37
                  ? "高温"
                  : "严寒";
        warnings.push(
          `第 ${day.index} 天${day.far ? "是远足日，" : ""}${reason}，出发前确认天气，必要时换室内点位。`,
        );
      }
    }
  }

  if (holiday) warnings.unshift(holiday.tip);
  if (discovered.isDemo) {
    warnings.push("当前为免 Key 演示模式：厦门点位真实，公交耗时为估算。");
  }

  const stopCount = days.reduce((sum, day) => sum + day.stops.length, 0);
  if (stopCount === 0) {
    // 数据源整批超时时，让用户换城市只会白折腾一轮；如实说明是上游的问题。
    const providerDown =
      discovered.sights.length === 0 &&
      discovered.notes.some((note) => /服务暂时不可用/.test(note));
    throw new TravelError(
      providerDown ? "地图数据源暂时不可用" : "这次没有排出可去的景点",
      "NO_SIGHTS",
      providerDown
        ? "开源地图服务这会儿连不上，等一两分钟再试；有高德 Key 时可在设置里切换数据源。"
        : "换一个城市，或放宽玩法与节奏后再试；也可以先在地图上勾几个想去的地方。",
    );
  }

  for (const day of days) {
    const heroId =
      day.heroPlaceId ??
      day.stops.find((stop) => stop.kind === "sight")?.place.id;
    if (!heroId) continue;
    const hero = day.stops.find((stop) => stop.place.id === heroId)?.place;
    if (!hero) continue;
    const alternatives = alternativesFor(
      input.city,
      hero,
      planSights.filter((place) => !plannedIds.has(place.id)),
      2,
    );
    if (alternatives.length) day.alternatives = alternatives;
  }

  // 维基数据补全只针对手册里真的会展示的点位；失败或超时就按原样排线。
  const enrichTargets: Place[] = [];
  const enrichSeen = new Set<string>();
  const addEnrichTarget = (place: Place) => {
    if (enrichSeen.has(place.id)) return;
    enrichSeen.add(place.id);
    enrichTargets.push(place);
  };
  for (const day of days) {
    for (const stop of day.stops) addEnrichTarget(stop.place);
  }
  for (const goal of wishlist) {
    const place = planSights.find((item) => item.id === goal.placeId);
    if (place) addEnrichTarget(place);
  }
  const hadNote = new Set(
    enrichTargets
      .filter((place) => Boolean(place.note?.trim()))
      .map((place) => place.id),
  );
  await enrichPlacesFromWikidata(enrichTargets, {
    maxNames: 40,
    city: input.city,
    budgetMs: 6_000,
  });
  for (const day of days) {
    for (const stop of day.stops) {
      const place = stop.place;
      // scheduleDay 生成停靠说明时还没有维基简介，这里补进已经排好的说明里。
      if (hadNote.has(place.id) || !place.note?.trim()) continue;
      if (stop.note?.includes(place.note)) continue;
      stop.note = [place.note, stop.note].filter(Boolean).join(" · ");
    }
  }

  const tips = selectTips(input, days);
  for (const day of days) {
    const dayTips = tips.dayTips.get(day.index);
    if (dayTips?.length) day.tips = dayTips;
  }

  const budget = buildBudget(days, trip, holiday?.hotelFactor ?? 1);
  const lodgingPlan = alignLodgingNights(lodging.plan, selection.days);
  const meta = buildMeta(
    input,
    discovered,
    days,
    selection.farDays,
    weather?.kind,
    selectedPlan?.selectedDays ?? 0,
    archetype,
    lodgingPlan,
  );
  const seen = new Set<string>();

  const plan: PlanResult = {
    meta,
    days,
    budget,
    warnings: warnings.filter((warning) => {
      if (!warning || seen.has(warning)) return false;
      seen.add(warning);
      return true;
    }).slice(0, 10),
    tips: tips.tripTips.length ? tips.tripTips : undefined,
    wishlist: wishlist.length ? wishlist : undefined,
    lodging: lodgingPlan,
  };

  // 每一版行程都过一遍体检。规则改动后最容易出现的是「程序没报错、
  // 结果却不像人排的」，这里把它变成一条能进日志、能统计的信号。
  if (process.env.NODE_ENV !== "production" || process.env.PLAN_AUDIT === "1") {
    const issues = auditPlan(plan, {
      pace,
      isFixed: meta.isFixed,
    });
    const errors = issues.filter((issue) => issue.severity === "error");
    if (errors.length) {
      console.warn(
        `[plan-audit] ${input.city} ${input.days}日 ${pace} seed=${input.seed}：${errors.length} 项硬伤`,
        errors.map((issue) => `D${issue.day} ${issue.code} ${issue.detail}`),
      );
    }
  }

  return plan;
}
