import type {
  BudgetTier,
  Category,
  CityOption,
  PaceId,
  StopKind,
  StyleId,
  TipKind,
  TransportMode,
  TransportPref,
} from "./types";

export const APP_NAME = "漫城";
export const APP_EN = "MANCHENG";

export const PACES: Record<
  PaceId,
  {
    label: string;
    short: string;
    description: string;
    startMin: number;
    endMin: number;
    sights: number;
    bufferMin: number;
    dwellScale: number;
  }
> = {
  chill: {
    label: "松弛",
    short: "慢慢来",
    description: "一天 3 个点，留够发呆和喝茶的时间",
    startMin: 9 * 60,
    endMin: 19 * 60,
    sights: 3,
    bufferMin: 12,
    dwellScale: 1.1,
  },
  balanced: {
    label: "适中",
    short: "节奏刚好",
    description: "一天 4 个点，走走停停，晚饭后再回去",
    startMin: 8 * 60 + 30,
    endMin: 20 * 60 + 30,
    sights: 4,
    bufferMin: 9,
    dwellScale: 1,
  },
  packed: {
    label: "充实",
    short: "多玩多看",
    description: "一天 5–6 个点，把精华尽量收进路线",
    startMin: 8 * 60,
    endMin: 21 * 60 + 30,
    sights: 6,
    bufferMin: 6,
    dwellScale: 0.9,
  },
};

export const STYLES: {
  id: StyleId;
  label: string;
  tagline: string;
  description: string;
  icon: string;
}[] = [
  {
    id: "citywalk",
    label: "城市漫步",
    tagline: "拐进巷子里",
    description: "老街、小马路、咖啡馆，优先能走起来的街区",
    icon: "footprints",
  },
  {
    id: "classic",
    label: "精华打卡",
    tagline: "一次看够",
    description: "优先地标与高人气景点，路线紧凑不绕路",
    icon: "landmark",
  },
  {
    id: "coastal",
    label: "环海慢游",
    tagline: "跟着海风走",
    description: "沙滩、观景台与落日，路线尽量贴着海岸",
    icon: "waves",
  },
  {
    id: "culture",
    label: "文化深度",
    tagline: "读一座城",
    description: "博物馆、寺庙与历史街区，多留一点参观时间",
    icon: "book-open",
  },
  {
    id: "foodie",
    label: "寻味本地",
    tagline: "为吃绕路",
    description: "市场、老店与本地味道，三餐优先安排",
    icon: "utensils",
  },
  {
    id: "family",
    label: "亲子轻松",
    tagline: "少走路多有趣",
    description: "公园、沙滩与互动场馆，减少长距离暴走",
    icon: "baby",
  },
];

export const STYLE_LABELS: Record<StyleId, string> = Object.fromEntries(
  STYLES.map((style) => [style.id, style.label]),
) as Record<StyleId, string>;

export const TRANSPORT_OPTIONS: {
  id: TransportPref;
  label: string;
  description: string;
  icon: string;
}[] = [
  {
    id: "auto",
    label: "自动",
    description: "按距离与时间智能组合",
    icon: "sparkles",
  },
  {
    id: "walk",
    label: "多走路",
    description: "适合 citywalk 的慢行",
    icon: "footprints",
  },
  {
    id: "transit",
    label: "公交优先",
    description: "地铁、公交为主",
    icon: "bus",
  },
  {
    id: "drive",
    label: "打车为主",
    description: "省时间，少换乘",
    icon: "car",
  },
];

export const BUDGET_TIERS: Record<
  BudgetTier,
  {
    label: string;
    description: string;
    hotel: number;
    food: [number, number];
    cafe: [number, number];
    ticket: number;
  }
> = {
  economy: {
    label: "省着花",
    description: "快捷酒店 + 本地小吃",
    hotel: 280,
    food: [25, 45],
    cafe: [18, 30],
    ticket: 30,
  },
  comfort: {
    label: "舒适",
    description: "舒服的酒店 + 特色餐厅",
    hotel: 600,
    food: [55, 100],
    cafe: [35, 55],
    ticket: 60,
  },
  premium: {
    label: "不将就",
    description: "好酒店 + 招牌餐厅",
    hotel: 1200,
    food: [120, 220],
    cafe: [60, 100],
    ticket: 120,
  },
};

export const BUDGET_LABELS: Record<BudgetTier, string> = {
  economy: "省着花",
  comfort: "舒适",
  premium: "不将就",
};

export const QUICK_CITIES: CityOption[] = [
  { name: "厦门", lat: 24.456, lng: 118.073, address: "福建省厦门市" },
  { name: "杭州", lat: 30.274, lng: 120.155, address: "浙江省杭州市" },
  { name: "青岛", lat: 36.067, lng: 120.383, address: "山东省青岛市" },
  { name: "成都", lat: 30.573, lng: 104.067, address: "四川省成都市" },
  { name: "三亚", lat: 18.253, lng: 109.512, address: "海南省三亚市" },
  { name: "北京", lat: 39.904, lng: 116.407, address: "北京市" },
];

export const DAY_COLORS = [
  "#C25A36",
  "#2F6A52",
  "#435E8C",
  "#B68633",
  "#7B4E6E",
  "#2B7575",
  "#7A5844",
];

export const CATEGORY_LABELS: Record<Category, string> = {
  attraction: "景点",
  museum: "博物馆",
  park: "公园",
  viewpoint: "观景",
  beach: "海滩",
  street: "街区",
  temple: "寺观",
  market: "市场",
  nature: "山野",
  food: "本地菜",
  cafe: "咖啡茶歇",
  hotel: "住处",
  other: "停留点",
};

export const CATEGORY_ICONS: Record<Category, string> = {
  attraction: "landmark",
  museum: "building",
  park: "trees",
  viewpoint: "binoculars",
  beach: "waves",
  street: "route",
  temple: "church",
  market: "store",
  nature: "mountain",
  food: "utensils",
  cafe: "coffee",
  hotel: "home",
  other: "map-pin",
};

export const TIP_ICONS: Record<TipKind, string> = {
  booking: "ticket",
  family: "baby",
  weather: "rain",
  crowd: "users",
  ferry: "waves",
  island: "footprints",
  food: "utensils",
  photo: "binoculars",
  temple: "church",
  slow: "clock",
  transit: "bus",
  city: "landmark",
  safety: "alert",
};

export const STOP_KIND_LABELS: Record<StopKind, string> = {
  sight: "景点",
  meal: "正餐",
  cafe: "咖啡 / 茶歇",
};

export const CATEGORY_DWELL: Record<Category, number> = {
  attraction: 85,
  museum: 80,
  park: 60,
  viewpoint: 35,
  beach: 55,
  street: 65,
  temple: 40,
  market: 45,
  nature: 100,
  food: 65,
  cafe: 35,
  hotel: 0,
  other: 50,
};

export const DIRECTIONS = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];

export const TRANSPORT_LABELS: Record<TransportMode, string> = {
  walk: "步行",
  transit: "公交 / 地铁",
  taxi: "打车",
};

export const TRANSPORT_ICONS: Record<TransportMode, string> = {
  walk: "footprints",
  transit: "bus",
  taxi: "car",
};

export const TAXI_RATES: Record<string, { base: number; perKm: number }> = {
  北京: { base: 13, perKm: 2.3 },
  上海: { base: 14, perKm: 2.5 },
  广州: { base: 12, perKm: 2.6 },
  深圳: { base: 12, perKm: 2.6 },
  厦门: { base: 10, perKm: 2.0 },
  杭州: { base: 11, perKm: 2.5 },
  成都: { base: 9, perKm: 2.0 },
  重庆: { base: 10, perKm: 2.0 },
  西安: { base: 8.5, perKm: 2.0 },
  南京: { base: 11, perKm: 2.4 },
  青岛: { base: 10, perKm: 1.9 },
  三亚: { base: 10, perKm: 2.2 },
  大理: { base: 8, perKm: 2.0 },
  昆明: { base: 8, perKm: 1.8 },
  武汉: { base: 10, perKm: 2.0 },
  长沙: { base: 8, perKm: 2.0 },
  苏州: { base: 10, perKm: 2.4 },
  大连: { base: 10, perKm: 2.0 },
  威海: { base: 8, perKm: 1.6 },
  哈尔滨: { base: 9, perKm: 2.0 },
};

export function getTaxiRate(city: string) {
  const clean = city.replace(/市$/, "").trim();
  for (const [name, rate] of Object.entries(TAXI_RATES)) {
    if (clean.includes(name) || name.includes(clean)) return rate;
  }
  return { base: 10, perKm: 2.2 };
}

export const GUIDE_SAMPLE = `Day 1｜老城与海风
上午先去八市吃一碗沙茶面，然后逛中山路步行街，顺路到华新路喝杯咖啡。
下午去沙坡尾和艺术西区，傍晚走到演武大桥观景平台看日落。
晚上在沙坡尾附近吃海鲜。

Day 2｜鼓浪屿慢慢走
早上从邮轮中心坐船上鼓浪屿，先去日光岩，再去菽庄花园和钢琴博物馆。
中午在龙头路吃鱼丸和奶茶，下午逛海天堂构、协和礼拜堂。
傍晚坐船回厦门，去白城沙滩吹吹风。

Day 3｜环岛路看海
上午去南普陀寺，然后逛厦门大学，记得提前预约。
下午沿环岛路去胡里山炮台、曾厝垵，找一家咖啡馆坐一会儿。
傍晚在黄厝海滩看日落，回住处。`;

export const DEMO_CITY = "厦门";
