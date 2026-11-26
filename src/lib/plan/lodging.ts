import {
  bearing,
  directionLabel,
  estimateModeMinutes,
  pointPlaceDistance,
} from "../geo";
import { getHoliday } from "../holidays";
import { cityShortName } from "../providers/normalize";
import type {
  LodgingBase,
  LodgingKind,
  LodgingPlan,
  Place,
  TripInput,
} from "../types";
import { DEFAULT_PARAMS, type PlanParams } from "./params";
import type { DaySeed } from "./select";
import { isFamous } from "./select/shared";

const OLDTOWN = /古城|古镇|老街|古街|老城|巷|胡同/;
const OLDTOWN_NAME = /([\u4e00-\u9fa5]{2,6}(?:古城|古镇|老街|古街|老城))/;
const OLDTOWN_BASE_CATEGORIES = new Set([
  "street",
  "attraction",
  "park",
  "market",
]);

interface Cluster {
  places: Place[];
  lat: number;
  lng: number;
  value: number;
  top: Place;
  distanceKm: number;
  oneWay: number;
}

function valueOf(place: Place): number {
  const popularity = place.popularity ?? 3.2;
  const rating = place.rating ?? 0;
  let value = Math.max(0, popularity - 3) * 1.4;
  value += Math.max(0, rating - 4) * 0.9;
  if (isFamous(place)) value += 0.8;
  // 博物馆、寺庙和山岳通常是“值得为它安排一天”的点，普通 attraction 可能只是雕塑。
  if (["museum", "temple", "nature"].includes(place.category)) value += 0.25;
  return value;
}

function clusterValue(places: Place[]): number {
  const values = places.map(valueOf).sort((a, b) => b - a);
  return (
    values.slice(0, 4).reduce((sum, value) => sum + value, 0) +
    Math.max(0, values.length - 4) * 0.2
  );
}

function clusterCentroid(places: Place[]): [number, number] {
  let weight = 0;
  let lng = 0;
  let lat = 0;
  for (const place of places) {
    const value = Math.max(0.2, valueOf(place));
    weight += value;
    lng += place.lng * value;
    lat += place.lat * value;
  }
  return [lng / weight, lat / weight];
}

function buildClusters(sights: Place[], center: [number, number], params: PlanParams = DEFAULT_PARAMS): Cluster[] {
  const candidates = sights
    .filter(
      (place) => !["food", "cafe", "hotel", "other"].includes(place.category),
    )
    .map((place) => ({ place, value: valueOf(place) }))
    .filter((entry) => entry.value >= 0.45)
    .sort((a, b) => b.value - a.value)
    .slice(0, 24)
    .map((entry) => entry.place);

  const groups: Place[][] = [];
  for (const place of candidates) {
    let best: Place[] | null = null;
    let bestDistance = params.lodgingClusterKm;
    for (const group of groups) {
      const [lng, lat] = clusterCentroid(group);
      const km = pointPlaceDistance(place, [lng, lat]);
      if (km < bestDistance) {
        best = group;
        bestDistance = km;
      }
    }
    if (best) best.push(place);
    else groups.push([place]);
  }

  return groups
    .map((places) => {
      const [lng, lat] = clusterCentroid(places);
      const top = [...places].sort((a, b) => valueOf(b) - valueOf(a))[0];
      return {
        places,
        lat,
        lng,
        value: clusterValue(places),
        top,
        distanceKm: pointPlaceDistance(top, center),
        // 这里衡量的是“从市区专程过去要多久”，不是片区内部到中心的距离；
        // 否则门户/换宿判断永远看到几分钟，远郊片区永远升不上来。
        oneWay: estimateModeMinutes(
          { ...top, id: "city-center", lat: center[1], lng: center[0] },
          top,
          "taxi",
        ),
      };
    })
    .sort((a, b) => b.value - a.value);
}

function directionFrom(from: [number, number], to: Place): string {
  return directionLabel(bearing(from, [to.lng, to.lat]));
}

function isStrongOldTown(place: Place): boolean {
  return (
    OLDTOWN_BASE_CATEGORIES.has(place.category) &&
    OLDTOWN_NAME.test(place.name)
  );
}

interface OldTownHit {
  label: string;
  place: Place;
}

/**
 * 从“大理古城基督教堂”“丽江古城博物院”这类点位名里提取老城片区名。
 * 老城本体常常不在景点池里，但带老城前缀的点位能证明这一片就是老城。
 */
function findOldTown(
  places: Place[],
  center: [number, number],
): OldTownHit | undefined {
  const hits = new Map<string, Place>();
  for (const place of places) {
    if (["food", "cafe", "hotel", "other"].includes(place.category)) continue;
    if (/遗址|遗迹/.test(place.name)) continue;
    if (pointPlaceDistance(place, center) > 25) continue;
    const match = place.name.match(OLDTOWN_NAME);
    if (!match) continue;
    const current = hits.get(match[1]);
    if (!current || valueOf(place) > valueOf(current)) {
      hits.set(match[1], place);
    }
  }
  const best = [...hits.entries()].sort(
    (a, b) => valueOf(b[1]) - valueOf(a[1]),
  )[0];
  return best ? { label: best[0], place: best[1] } : undefined;
}

function clusterNear(
  clusters: Cluster[],
  place: Place,
  params: PlanParams = DEFAULT_PARAMS,
): Cluster | undefined {
  const best = clusters
    .map((cluster) => ({
      cluster,
      km: pointPlaceDistance(place, [cluster.lng, cluster.lat]),
    }))
    .filter((entry) => entry.km <= params.lodgingClusterKm)
    .sort((a, b) => a.km - b.km)[0];
  return best?.cluster;
}

function basePlace(
  input: TripInput,
  name: string,
  lat: number,
  lng: number,
  note: string,
): Place {
  return {
    id: `base-${Math.round(lat * 1000)}-${Math.round(lng * 1000)}`,
    name,
    category: "hotel",
    lat,
    lng,
    city: input.city,
    note,
    source: "demo",
  };
}

function kindFor(place: Place, gateway: boolean): LodgingKind {
  if (place.island) return "inside";
  if (OLDTOWN.test(place.name)) return "oldtown";
  return gateway ? "gateway" : "city";
}

function nameFor(
  input: TripInput,
  place: Place,
  kind: LodgingKind,
  _center?: [number, number],
): string {
  if (kind === "inside") return `${place.name}岛上`;
  if (kind === "oldtown") return `${place.name}周边`;
  if (kind === "gateway") return `${place.name}一带`;
  return `${cityShortName(input.city)}市中心`;
}

function cityBaseCluster(
  clusters: Cluster[],
  center: [number, number],
  params: PlanParams = DEFAULT_PARAMS,
): Cluster | undefined {
  return (
    clusters
      .filter((cluster) => cluster.distanceKm <= params.cityKm)
      .sort((a, b) => b.value - a.value)[0] ??
    clusters
      .filter(
        (cluster) => pointPlaceDistance(cluster.top, center) <= params.cityKm + 4,
      )
      .sort((a, b) => b.value - a.value)[0]
  );
}

function mainBaseFromCluster(
  input: TripInput,
  cluster: Cluster,
  center: [number, number],
  gateway: boolean,
): { base: Place; kind: LodgingKind; reason: string } {
  const anchor = cluster.top;
  const cityAnchor = gateway
    ? anchor
    : [...cluster.places]
        .filter((place) => !place.island)
        .filter((place) => pointPlaceDistance(place, center) <= 5)
        .sort(
          (a, b) =>
            Number(isStrongOldTown(b)) - Number(isStrongOldTown(a)) ||
            valueOf(b) - valueOf(a),
        )[0];
  // 鼓浪屿这类岛就算落在主城片区里，也不该被当成“市中心落脚点”；
  // 它只适合作为“想住一晚”的可选项。
  const kind: LodgingKind = gateway
    ? kindFor(anchor, true)
    : cityAnchor && OLDTOWN.test(cityAnchor.name)
      ? "oldtown"
      : "city";
  const nameAnchor = cityAnchor ?? anchor;
  const name = gateway
    ? nameFor(input, anchor, kind)
    : nameFor(input, nameAnchor, kind, center);
  const direction = directionFrom(center, nameAnchor);
  const lat = gateway ? anchor.lat : center[1];
  const lng = gateway ? anchor.lng : center[0];
  const place = basePlace(
    input,
    name,
    lat,
    lng,
    kind === "gateway"
      ? "按景点分布推荐的景区落脚片区，优先选游客中心/山门附近"
      : "按景点分布推荐的落脚片区",
  );
  const reason =
    kind === "oldtown"
      ? `把住处放在${nameAnchor.name}周边，白天出城、晚上回老街，吃饭和闲逛都顺路。`
      : kind === "gateway"
        ? `主要目标在${direction}方向，从市区过去单程约 ${cluster.oneWay} 分钟；住这一带可以赶早进景区，免掉当天往返。`
        : "主城点位围绕市中心分布，住这里去各方向都不折返，吃饭和换乘也方便。";
  return { base: place, kind, reason };
}

function optionalForCluster(
  input: TripInput,
  cluster: Cluster,
  mainBase: Place,
  isCity: boolean,
  params: PlanParams = DEFAULT_PARAMS,
): LodgingBase | null {
  const anchor = cluster.top;
  const oneWay = estimateModeMinutes(mainBase, anchor, "taxi");
  if (oneWay < params.optionalOneWayMin) return null;
  const kind = isCity ? "city" : kindFor(anchor, true);
  return {
    id: `opt-${Math.round(anchor.lat * 1000)}-${Math.round(anchor.lng * 1000)}`,
    name: isCity
      ? `${cityShortName(input.city)}市中心`
      : nameFor(input, anchor, kind),
    kind,
    lat: anchor.lat,
    lng: anchor.lng,
    role: "optional",
    nights: [],
    reason: isCity
      ? `主城也有值得看的点位，离主落脚点单程约 ${oneWay} 分钟；如果市区安排更多，可以换回市中心住 1 晚。`
      : `「${anchor.name}」离主落脚点单程约 ${oneWay} 分钟。想赶早或看日落，可以把当晚换到这一带，第二天不用再折返。`,
    tradeoff: "换宿要收拾行李，住 1 晚带轻便包就够。",
  };
}

function islandOption(
  input: TripInput,
  places: Place[],
): LodgingBase | null {
  const island = places.find((place) => place.island);
  if (!island) return null;
  const wantsIslandNight =
    input.days >= 2 &&
    ((input.experiences ?? []).some((id) =>
      ["sunset", "night", "photo", "coast"].includes(id),
    ) ||
      input.days >= 3);
  if (!wantsIslandNight) return null;
  return {
    id: `opt-island-${island.id}`,
    name: `${island.name}岛上`,
    kind: "inside",
    lat: island.lat,
    lng: island.lng,
    role: "optional",
    nights: [],
    reason: `想拍到没有游客的清晨或夜晚，在${island.name}住 1 晚最值；住在对岸只能白天上岛。`,
    tradeoff: "岛上房源少、行李搬运麻烦，只带一晚的东西。",
  };
}

export interface LodgingResult {
  base: Place;
  plan: LodgingPlan;
}

export function planLodging(input: TripInput, sights: Place[]): LodgingResult {
  const params = input.planParams ?? DEFAULT_PARAMS;
  const center: [number, number] =
    input.center ??
    (input.hotel
      ? [input.hotel.lng, input.hotel.lat]
      : [sights[0]?.lng ?? 0, sights[0]?.lat ?? 0]);
  const nights = Array.from(
    { length: Math.max(0, input.days - 1) },
    (_, index) => index + 1,
  );
  const holiday = getHoliday(input.date);
  const notes: string[] = [];
  const clusters = buildClusters(sights, center, params);
  const oldTown = findOldTown(sights, center);
  const oldTownCluster = oldTown ? clusterNear(clusters, oldTown.place, params) : undefined;

  if (input.hotel) {
    const base = input.hotel;
    const cityClusters = clusters.filter(
      (cluster) => cluster.distanceKm <= params.cityKm,
    );
    const far = clusters
      .filter(
        (cluster) =>
          cluster.distanceKm > params.cityKm &&
          estimateModeMinutes(base, cluster.top, "taxi") >=
            params.optionalOneWayMin &&
          (isFamous(cluster.top) || cluster.value >= 1.6),
      )
      .sort((a, b) => b.value - a.value)[0];
    const optional: LodgingBase[] = [];
    if (far) {
      const candidate = optionalForCluster(input, far, base, false, params);
      if (candidate) optional.push(candidate);
    }
    const island = islandOption(
      input,
      cityClusters.flatMap((cluster) => cluster.places),
    );
    if (island) optional.push(island);
    if (holiday) notes.push(`${holiday.name}房源紧张，先订可免费取消的。`);
    return {
      base,
      plan: {
        status: "fixed",
        strategy: optional.length ? "multi" : "hub",
        headline: "已按你选的住处每天往返",
        summary: `每天从${base.name}出发，晚上回到这里。${
          optional.length ? "下面这些换宿只在你赶早或想看夜景时才有必要。" : ""
        }`,
        bases: [
          {
            id: base.id,
            name: base.name,
            kind: "city",
            lat: base.lat,
            lng: base.lng,
            role: "main",
            nights,
            reason: "你在出发前已经选好的住处。",
          },
          ...optional,
        ],
        notes,
      },
    };
  }

  const cityCluster = cityBaseCluster(clusters, center, params);
  const farClusters = clusters
    .filter((cluster) => cluster !== cityCluster)
    .filter((cluster) => cluster.oneWay >= 25 && cluster.distanceKm > params.cityKm);
  const far = farClusters[0];
  const cityValue = cityCluster?.value ?? 0;
  const dominantFar =
    far &&
    far.oneWay >= params.gatewayMinOneWayMin &&
    far.value >= (cityValue === 0 ? 1.2 : Math.max(2.2, cityValue * 1.25)) &&
    (far.places.length >= 2 ||
      input.days <= 2 ||
      (far.top.popularity ?? 0) >= 4.6);

  // 行政中心和老城分开的城市（如大理），游客真正的落脚点常是老城；
  // 老城不算“景区门户”，离市中心也没远到需要每天往返。
  const oldTownPick =
    oldTown &&
    oldTownCluster &&
    oldTownCluster !== cityCluster &&
    oldTownCluster.oneWay < params.gatewayMinOneWayMin &&
    oldTownCluster.value >= Math.max(1.2, cityValue * 0.5)
      ? { cluster: oldTownCluster, old: oldTown }
      : undefined;

  let main: { base: Place; kind: LodgingKind; reason: string };
  let strategy: LodgingPlan["strategy"];
  let chosenCluster: Cluster | undefined;
  if (dominantFar && far) {
    // 老城本身是主要景区片区时（如大理古城离市政中心 39 分钟），
    // 游客要住的是老城，不是拿教堂、城门这类点位当“景区门户”来命名。
    if (oldTown && oldTownCluster === far) {
      main = {
        base: basePlace(
          input,
          `${oldTown.label}周边`,
          oldTown.place.lat,
          oldTown.place.lng,
          "按景点分布推荐的老城落脚片区",
        ),
        kind: "oldtown",
        reason: `把住处放在${oldTown.label}周边：老城点位步行可达，去周边景区也顺路，晚上回来还有饭吃。`,
      };
      chosenCluster = far;
      strategy = "hub";
    } else {
      main = mainBaseFromCluster(input, far, center, true);
      chosenCluster = far;
      strategy = farClusters.length > 1 ? "multi" : "gateway";
    }
  } else if (oldTownPick) {
    const { label, place: anchor } = oldTownPick.old;
    main = {
      base: basePlace(
        input,
        `${label}周边`,
        anchor.lat,
        anchor.lng,
        "按景点分布推荐的老城落脚片区",
      ),
      kind: "oldtown",
      reason: `把住处放在${label}周边，白天出城、晚上回老街，吃饭和闲逛都顺路。`,
    };
    chosenCluster = oldTownPick.cluster;
    strategy = "hub";
  } else if (cityCluster) {
    main = mainBaseFromCluster(input, cityCluster, center, false);
    chosenCluster = cityCluster;
    strategy = "hub";
  } else {
    main = {
      base: basePlace(
        input,
        `${cityShortName(input.city)}市中心`,
        center[1],
        center[0],
        "按城市中心给出的兜底落脚点",
      ),
      kind: "city",
      reason: "没有找到足够密集的景点片区，先把落脚点放在市中心，再按天分方向出门。",
    };
    strategy = "hub";
  }

  const bases: LodgingBase[] = [
    {
      id: main.base.id,
      name: main.base.name,
      kind: main.kind,
      lat: main.base.lat,
      lng: main.base.lng,
      role: "main",
      nights,
      reason: main.reason,
    },
  ];

  const others = clusters
    .filter((cluster) => cluster !== chosenCluster)
    .filter((cluster) => cluster !== cityCluster);
  const optional = others
    .map((cluster) => ({
      cluster,
      item: optionalForCluster(
        input,
        cluster,
        main.base,
        cluster === cityCluster,
        params,
      ),
    }))
    .filter((entry): entry is { cluster: Cluster; item: LodgingBase } =>
      Boolean(entry.item),
    )
    .sort((a, b) => b.cluster.value - a.cluster.value)
    .slice(0, 1)
    .map((entry) => entry.item)[0];
  if (optional) {
    bases.push(optional);
    strategy = "multi";
  }

  const island = islandOption(
    input,
    clusters
      .filter((cluster) => cluster === cityCluster || cluster === far)
      .flatMap((cluster) => cluster.places),
  );
  if (island && !bases.some((base) => base.kind === "inside")) {
    bases.push(island);
  }

  if (strategy === "hub" && far && chosenCluster !== far) {
    const oneWay = estimateModeMinutes(main.base, far.top, "taxi");
    notes.push(
      `「${far.top.name}」离${main.base.name}单程约 ${oneWay} 分钟，当天往返可行；想玩透就在那一带补一晚。`,
    );
  }
  if (main.kind === "gateway") {
    notes.push(
      "景区门口一带的房源差异很大，订房前先确认到游客中心/山门的车程，别只看直线距离。",
    );
  }
  notes.push(
    "这里推荐的是落脚片区，不是具体酒店；在片区里挑评分、取消政策和停车都合适的。",
  );
  if (holiday) notes.push(`${holiday.name}房源紧张，先订可免费取消的。`);
  if (input.days === 1) {
    notes.push("一日游当晚不需要住宿，这个推荐只用于下车后先寄存行李。");
  }

  return {
    base: main.base,
    plan: {
      status: "recommended",
      strategy,
      headline: "住哪一片？先按景点分布给个落脚点",
      summary:
        strategy === "gateway"
          ? `这趟的主角在${directionFrom(center, far?.top ?? main.base)}方向，建议以${main.base.name}为基地，别每天从市区往返。`
          : strategy === "multi"
            ? `点位分成几个方向，建议以${main.base.name}为主基地；另一个方向的那晚再换宿，能省下往返。`
            : `建议以${main.base.name}为落脚点，白天分方向出门，晚上回住处。`,
      bases,
      notes,
    },
  };
}

export function alignLodgingNights(
  plan: LodgingPlan,
  seeds: DaySeed[],
  params: PlanParams = DEFAULT_PARAMS,
): LodgingPlan {
  if (!plan.bases.some((base) => base.role === "optional")) return plan;
  const lastNight = Math.max(0, seeds.length - 1);
  const bases = plan.bases
    .map((base) => {
      if (base.role === "main") return base;
      const hitDays = seeds
        .filter(
          (seed) =>
            seed.places.some(
              (place) =>
                !["food", "cafe", "hotel"].includes(place.category) &&
                pointPlaceDistance(place, [base.lng, base.lat]) <= params.lodgingClusterKm,
            ),
        )
        .map((seed) => seed.index)
        .filter((index) => index <= lastNight);
      if (!hitDays.length) return { ...base, nights: [] };
      const first = hitDays[0];
      const last = hitDays[hitDays.length - 1];
      let nights: number[];
      if (base.kind === "inside") {
        nights = first <= lastNight ? [first] : [];
      } else if (last > first) {
        nights = [first - 1, last].filter(
          (night) => night >= 1 && night <= lastNight,
        );
      } else if (first > 1) {
        nights = [first - 1];
      } else {
        nights = first <= lastNight ? [first] : [];
      }
      return { ...base, nights: Array.from(new Set(nights)).slice(0, 2) };
    })
    .filter((base) => base.role === "main" || base.nights.length > 0);
  if (!bases.some((base) => base.role === "optional")) {
    // 换宿没落到具体某一晚就不要保留“换宿”说法，否则文案和实际安排对不上。
    const main = bases.find((base) => base.role === "main");
    return {
      ...plan,
      bases,
      strategy: "hub",
      summary:
        plan.status === "fixed"
          ? `每天从${main?.name ?? "住处"}出发，晚上回到这里。`
          : `建议以${main?.name ?? "市中心"}为落脚点，白天分方向出门，晚上回住处。`,
    };
  }
  if (plan.status === "fixed") return { ...plan, bases };
  const optionalNames = bases
    .filter((base) => base.role === "optional")
    .map((base) => `${base.name}（第 ${base.nights.join("、")} 晚）`)
    .join("、");
  return {
    ...plan,
    bases,
    summary: `${plan.summary} 可选换宿：${optionalNames}。`,
  };
}