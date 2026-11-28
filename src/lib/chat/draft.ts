import { DEMO_HOTELS } from "@/content/demo-xiamen";
import { CITY_FACTS, NEUTRAL_FACTS } from "@/content/city-facts.generated";
import { QUICK_CITIES } from "@/lib/constants";
import { isDemoCity } from "@/lib/demo";
import {
  describePrefs,
  hasPrefs,
  mergePrefs,
  NEUTRAL_PREFS,
} from "@/lib/plan/prefs";
import type { CityOption, Place, TripInput } from "@/lib/types";
import type { ChatCard, ChatCardKind, ChatDraft, ResolvedPatch } from "./types";

export function makeDraft(initialDate: string): ChatDraft {
  return {
    city: QUICK_CITIES[0],
    hotel: DEMO_HOTELS[0],
    hotelUndecided: true,
    days: 3,
    date: initialDate,
    pace: "balanced",
    styles: [],
    experiences: [],
    transport: "auto",
    budgetTier: "comfort",
    adults: 2,
    children: 0,
    seniors: 0,
    avoidSteep: false,
    notes: "",
    prefs: { ...NEUTRAL_PREFS },
    selectedPlaces: [],
    confirmed: {
      city: false,
      date: false,
      party: false,
      style: false,
      pace: false,
      transport: false,
      hotel: false,
    },
  };
}

export function hotelForCity(city: CityOption): Place {
  if (isDemoCity(city.name)) return DEMO_HOTELS[0];
  return {
    id: `center-${city.name}`,
    name: `${city.name}市中心`,
    category: "hotel",
    lat: city.lat,
    lng: city.lng,
    address: city.address ?? city.name,
    city: city.name,
    note: "先住市中心，之后可以在地图上换",
    source: "demo",
  };
}

export function cityFromPlace(place: Place): CityOption {
  return {
    name: place.name.replace(/市$/, "") || place.name,
    lat: place.lat,
    lng: place.lng,
    address: place.address,
  };
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function applyResolvedPatch(
  draft: ChatDraft,
  patch: ResolvedPatch,
): ChatDraft {
  const next: ChatDraft = {
    ...draft,
    confirmed: { ...draft.confirmed },
    selectedPlaces: draft.selectedPlaces,
  };

  if (patch.city) {
    next.city = patch.city;
    next.confirmed.city = true;
    if (patch.city.name !== draft.city.name) {
      // 换城市要让所有「绑定旧城市」的状态一起失效，否则排线拿到矛盾需求：
      // ①具体酒店绑在旧城坐标上，作废并重新问；②「还没定」是跨城意愿，保留；
      // ③点名景点属于旧城，清空。
      const hadConcreteHotel = draft.confirmed.hotel && !draft.hotelUndecided;
      next.hotel = patch.hotel ?? hotelForCity(patch.city);
      next.hotelUndecided = !patch.hotel && draft.hotelUndecided;
      next.confirmed.hotel =
        Boolean(patch.hotel) || (draft.confirmed.hotel && !hadConcreteHotel);
      next.selectedPlaces = [];
    }
  }
  if (patch.hotel) {
    next.hotel = { ...patch.hotel, category: "hotel" };
    next.hotelUndecided = false;
    next.confirmed.hotel = true;
  } else if (patch.hotelUndecided) {
    next.hotelUndecided = true;
    next.confirmed.hotel = true;
  }
  if (patch.days !== undefined) next.days = patch.days;
  if (patch.date !== undefined) {
    next.date = patch.date;
    next.confirmed.date = true;
  }
  if (
    patch.adults !== undefined ||
    patch.children !== undefined ||
    patch.seniors !== undefined
  ) {
    if (patch.adults !== undefined) next.adults = patch.adults;
    if (patch.children !== undefined) next.children = patch.children;
    if (patch.seniors !== undefined) next.seniors = patch.seniors;
    next.confirmed.party = true;
  }
  if (patch.avoidSteep !== undefined) {
    next.avoidSteep = patch.avoidSteep;
  }
  if (patch.notes) {
    const notes = patch.notes.replace(/\s+/g, " ").trim().slice(0, 200);
    if (notes) next.notes = notes;
  }
  // 连续偏好逐轮累积：这一轮说了哪几维就盖哪几维，没说到的沿用上一轮。
  if (patch.prefs !== undefined) {
    next.prefs = mergePrefs(draft.prefs, patch.prefs);
  }
  if (patch.styles !== undefined) {
    next.styles = uniqueBy(patch.styles, (item) => item).slice(0, 3);
    next.confirmed.style = true;
  }
  if (patch.experiences !== undefined) {
    next.experiences = uniqueBy(patch.experiences, (item) => item).slice(0, 4);
    next.confirmed.style = true;
  }
  if (patch.pace !== undefined) {
    next.pace = patch.pace;
    next.confirmed.pace = true;
  }
  if (patch.transport !== undefined) {
    next.transport = patch.transport;
    next.confirmed.transport = true;
  }
  if (patch.budgetTier !== undefined) next.budgetTier = patch.budgetTier;
  if (patch.selectedPlaces?.length) {
    // 用 next 而非 draft：换城市那轮 next.selectedPlaces 已被清空，
    // 若从 draft 合并会把旧城市点名景点又带回来。
    next.selectedPlaces = uniqueBy(
      [...next.selectedPlaces, ...patch.selectedPlaces],
      (place) => place.id || place.name,
    ).slice(0, 12);
  }

  // 城市兼容性过滤统一放在末尾：无论玩法来自旧草稿还是本轮 patch（可能同时
  // 带 city 切换 + styles），都按最终城市校验一次。放在 city 分支里会漏掉
  // 「同一轮既换城又给玩法」的情况，让沿海玩法混进内陆城市。
  //
  // 注意只做「不兼容项剔除」，不做画像表白名单过滤：画像表列的是特色高分项
  // （厦门表就没有 food），白名单会把用户勾选的通用玩法误删。真正不兼容的
  // 只有水/海类玩法——无海去 coast，无海无湖去 boat，无海去 coastal 风格。
  const facts = CITY_FACTS[next.city.name] ?? NEUTRAL_FACTS;
  const hasSea = facts.capabilities.sea;
  const hasWater = hasSea || facts.capabilities.lake;
  if (!hasSea) {
    next.styles = next.styles.filter((id) => id !== "coastal");
    next.experiences = next.experiences.filter((id) => id !== "coast");
  }
  if (!hasWater) {
    next.experiences = next.experiences.filter((id) => id !== "boat");
  }

  return next;
}

export function buildTripInput(draft: ChatDraft, seed = 42): TripInput {
  return {
    city: draft.city.name,
    center: [draft.city.lng, draft.city.lat],
    hotel: draft.hotelUndecided ? undefined : draft.hotel,
    hotelUndecided: draft.hotelUndecided || undefined,
    days: draft.days,
    date: draft.date,
    pace: draft.pace,
    styles: draft.styles.length ? draft.styles : ["citywalk"],
    experiences: draft.experiences.length ? draft.experiences : undefined,
    transport: draft.transport,
    budgetTier: draft.budgetTier,
    adults: draft.adults,
    children: draft.children,
    seniors: draft.seniors,
    avoidSteep: draft.avoidSteep || undefined,
    notes: draft.notes || undefined,
    // 中性向量不往请求里带：少了它，行为与没有这一层时逐字节一致。
    prefs: hasPrefs(draft.prefs) ? draft.prefs : undefined,
    seed,
    hotelPrice: draft.hotelUndecided ? undefined : draft.hotel.cost,
    selectedPlaces: draft.selectedPlaces.length
      ? draft.selectedPlaces
      : undefined,
  };
}

export type WizardStep =
  | "city"
  | "date"
  | "party"
  | "style"
  | "pace"
  | "transport"
  | "hotel"
  | "confirm";

const STEP_ORDER: (keyof ChatDraft["confirmed"])[] = [
  "city",
  "date",
  "party",
  "style",
  "pace",
  "transport",
  "hotel",
];

export function wizardStep(draft: ChatDraft): WizardStep {
  // 单一真相源：按固定顺序找第一个未确认的维度。cardIsSettled 复用同一份
  // confirmed 状态，不再各写一套 switch——两套判断正是漂移的温床。
  const first = STEP_ORDER.find((key) => !draft.confirmed[key]);
  return first ?? "confirm";
}

/**
 * 某张卡片是否已处理完，用于前端过滤模型重复给的卡。
 * 由 wizardStep 同一份 confirmed 推导：budget 提示词规定不单独问，视为已处理；
 * confirm 永远可显示。
 */
export function cardIsSettled(kind: ChatCardKind, draft: ChatDraft): boolean {
  if (kind === "budget") return true;
  if (kind === "confirm") return false;
  return draft.confirmed[kind as keyof ChatDraft["confirmed"]];
}

const STEP_CARDS: Record<
  WizardStep,
  { kind: ChatCardKind; title: string; hint?: string }
> = {
  city: {
    kind: "city",
    title: "先去哪座城市？",
    hint: "点一个常去的，或输入城市名",
  },
  date: {
    kind: "date",
    title: "哪天出发，玩几天？",
    hint: "天数会直接决定能塞进几个大景",
  },
  party: {
    kind: "party",
    title: "几个人一起？",
    hint: "有孩子或老人请一并勾上，安排会自动少走路、多留休息",
  },
  style: {
    kind: "style",
    title: "这趟想怎么玩？",
    hint: "最多选 3 个，也可以跳过",
  },
  pace: {
    kind: "pace",
    title: "每天走多少？",
    hint: "之后随时可以改",
  },
  transport: {
    kind: "transport",
    title: "更愿意怎么出行？",
    hint: "自动会按距离把地铁、打车和步行混着排",
  },
  hotel: {
    kind: "hotel",
    title: "住在哪一片？",
    hint: "已有酒店就搜；还没定就让漫城按景点分布推荐落脚片区",
  },
  confirm: {
    kind: "confirm",
    title: "信息齐了，开始安排？",
    hint: "排好后地图按天着色，手册里有图文",
  },
};

export function cardForStep(step: WizardStep, id: string): ChatCard {
  const card = STEP_CARDS[step];
  return {
    id,
    kind: card.kind,
    title: card.title,
    hint: card.hint,
  };
}

export function draftSummary(draft: ChatDraft): string {
  const confirmed = Object.entries(draft.confirmed)
    .filter(([, value]) => value)
    .map(([key]) => key);
  const mark = (key: keyof ChatDraft["confirmed"]) =>
    draft.confirmed[key] ? "" : "（未确认）";
  const missing = (
    [
      ["city", "城市"],
      ["date", "日期天数"],
      ["party", "同行人数"],
      ["style", "玩法心愿"],
      ["pace", "每日节奏"],
      ["transport", "出行方式"],
      ["hotel", "住处"],
    ] as [keyof ChatDraft["confirmed"], string][]
  )
    .filter(([key]) => !draft.confirmed[key])
    .map(([, label]) => label);
  return [
    `城市：${draft.city.name}${mark("city")}`,
    `日期：${
      draft.confirmed.date
        ? `${draft.date} 起 ${draft.days} 天`
        : `出发日期未定，游玩天数暂记 ${draft.days} 天（未确认）`
    }`,
    `同行：${
      draft.confirmed.party
        ? `${draft.adults} 成人${draft.children ? `，${draft.children} 儿童` : ""}${
            draft.seniors ? `，${draft.seniors} 老人` : ""
          }`
        : "人数未确认"
    }`,
    `玩法：${
      draft.confirmed.style
        ? `${draft.styles.join("、") || "不设限"}；心愿：${draft.experiences.join("、") || "自动安排"}`
        : "未确认"
    }`,
    `节奏：${draft.confirmed.pace ? draft.pace : "未确认"}；交通：${draft.confirmed.transport ? draft.transport : "未确认"}；预算：${draft.budgetTier}（用户没提就保持默认）`,
    `住处：${
      draft.confirmed.hotel
        ? draft.hotelUndecided
          ? "还没定，按景点分布推荐落脚片区"
          : draft.hotel.name
        : "未确认"
    }`,
    draft.avoidSteep ? "避坑：不爬山、不走长台阶" : "",
    // 已经收到的「程度」偏好也要让模型看见，否则它会每轮重新猜一遍。
    // describePrefs 自带「按你的偏好：」前缀，这里别再套一层，否则会念成
    // 「已收到的偏好：按你的偏好：愿意多走路」。
    describePrefs(draft.prefs) ?? "",
    draft.notes ? `用户原话补充：${draft.notes}` : "",
    draft.selectedPlaces.length
      ? `用户点名要去：${draft.selectedPlaces.map((place) => place.name).join("、")}`
      : "",
    `已确认字段：${confirmed.join("、") || "无"}`,
    `待确认维度：${missing.join("、") || "无（可以收尾）"}`,
  ]
    .filter(Boolean)
    .join("\n");
}