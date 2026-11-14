import type { Category, CityOption, Place } from "../types";

export const XIAMEN_CITY: CityOption = {
  name: "厦门",
  address: "福建省厦门市",
  lat: 24.456,
  lng: 118.085,
};

export function isDemoCity(city: string): boolean {
  const clean = city.replace(/市$/, "").trim();
  return clean === "厦门" || clean.includes("厦门");
}

function place(
  id: string,
  name: string,
  category: Category,
  lng: number,
  lat: number,
  extra: Partial<Place> = {},
): Place {
  return {
    id,
    name,
    category,
    lng,
    lat,
    source: "demo",
    city: "厦门市",
    ...extra,
  };
}

const ISLAND = "鼓浪屿";

export const XIAMEN_SIGHTS: Place[] = [
  place("demo-xm-gulangyu", "鼓浪屿", "attraction", 118.061891, 24.447246, {
    cost: 35,
    costNote: "轮渡往返参考价",
    popularity: 5,
    island: ISLAND,
    tags: ["classic", "photo", "island"],
    note: "世界文化遗产，建议留半天慢慢走",
  }),
  place("demo-xm-riguangyan", "日光岩", "viewpoint", 118.06231, 24.444956, {
    cost: 50,
    costNote: "参考门票",
    popularity: 4.8,
    island: ISLAND,
    tags: ["classic", "photo", "island"],
    note: "全岛制高点，看红瓦与海",
  }),
  place("demo-xm-shuzhuang", "菽庄花园", "park", 118.06451, 24.441674, {
    cost: 30,
    costNote: "参考门票",
    popularity: 4.7,
    island: ISLAND,
    tags: ["classic", "garden", "island"],
    note: "藏海园林，内有钢琴博物馆",
  }),
  place("demo-xm-haoyueyuan", "皓月园", "park", 118.07122, 24.443898, {
    cost: 15,
    costNote: "参考门票",
    popularity: 4,
    island: ISLAND,
    tags: ["coast", "island"],
    note: "临海看郑成功雕像",
  }),
  place("demo-xm-aquarium", "厦门海底世界", "museum", 118.066303, 24.448757, {
    cost: 117,
    costNote: "参考门票",
    popularity: 3.7,
    island: ISLAND,
    tags: ["family", "indoor", "island"],
    note: "适合带小朋友",
  }),
  place("demo-xm-haitiantang", "海天堂构", "museum", 118.067699, 24.445669, {
    cost: 88,
    costNote: "参考门票",
    popularity: 3.8,
    island: ISLAND,
    tags: ["culture", "architecture", "island"],
    note: "鼓浪屿老别墅建筑群",
  }),
  place("demo-xm-pianomuseum", "鼓浪屿钢琴博物馆", "museum", 118.064831, 24.441472, {
    cost: 0,
    costNote: "含在菽庄花园门票内",
    popularity: 3.7,
    island: ISLAND,
    tags: ["culture", "indoor", "island"],
    note: "菽庄花园里的钢琴收藏",
  }),
  place("demo-xm-zhengchenggong", "郑成功纪念馆", "museum", 118.06199, 24.445358, {
    cost: 0,
    popularity: 3.6,
    island: ISLAND,
    tags: ["culture", "indoor", "island"],
    note: "日光岩下的历史展馆",
  }),
  place("demo-xm-sanyitang", "三一堂", "temple", 118.062111, 24.44708, {
    cost: 0,
    popularity: 3.5,
    island: ISLAND,
    tags: ["culture", "architecture", "island"],
    note: "岛上标志性红砖教堂",
  }),
  place("demo-xm-xiehe", "协和礼拜堂", "temple", 118.067503, 24.446674, {
    cost: 0,
    popularity: 3.5,
    island: ISLAND,
    tags: ["culture", "island"],
    note: "安静的百年教堂",
  }),
  place("demo-xm-yuyuan", "毓园", "park", 118.068054, 24.443344, {
    cost: 0,
    popularity: 3.7,
    island: ISLAND,
    tags: ["slow", "island"],
    note: "纪念林巧稚的小园子",
  }),
  place("demo-xm-zhongshanlu", "中山路步行街", "street", 118.0728, 24.456, {
    cost: 0,
    popularity: 4.5,
    tags: ["citywalk", "food", "photo"],
    note: "骑楼老街，晚上更有味道",
  }),
  place("demo-xm-bashi", "第八市场（八市）", "market", 118.069711, 24.460957, {
    cost: 0,
    popularity: 4.3,
    tags: ["citywalk", "food", "local"],
    note: "最地道的菜市场烟火气",
  }),
  place("demo-xm-shapowei", "沙坡尾", "street", 118.082943, 24.43989, {
    cost: 0,
    popularity: 4.5,
    tags: ["citywalk", "photo", "coast"],
    note: "老渔港改造的文艺街区",
  }),
  place("demo-xm-zengcuoan", "曾厝垵", "street", 118.118008, 24.428557, {
    cost: 0,
    popularity: 4.4,
    tags: ["citywalk", "food", "photo"],
    note: "文创村，小吃密集",
  }),
  place("demo-xm-baicheng", "白城沙滩", "beach", 118.099633, 24.433291, {
    cost: 0,
    popularity: 4.3,
    tags: ["coast", "family", "photo"],
    note: "厦大旁的城市沙滩",
  }),
  place("demo-xm-hulishan", "胡里山炮台", "attraction", 118.101582, 24.431541, {
    cost: 25,
    costNote: "参考门票",
    popularity: 4.4,
    tags: ["classic", "coast", "history"],
    note: "看海防古迹与克虏伯大炮",
  }),
  place("demo-xm-nanputuo", "南普陀寺", "temple", 118.091503, 24.443258, {
    cost: 0,
    popularity: 4.6,
    tags: ["culture", "classic"],
    note: "香火旺，素饼值得带",
  }),
  place("demo-xm-xmu", "厦门大学", "attraction", 118.093018, 24.439942, {
    cost: 0,
    popularity: 4.6,
    tags: ["classic", "culture"],
    note: "进校需提前预约",
  }),
  place("demo-xm-huangcuo", "黄厝海滩", "beach", 118.155203, 24.444452, {
    cost: 0,
    popularity: 4.2,
    tags: ["coast", "photo", "slow"],
    note: "人少一些的日出沙滩",
  }),
  place("demo-xm-bailuzhou", "白鹭洲公园", "park", 118.083845, 24.475493, {
    cost: 0,
    popularity: 4,
    tags: ["slow", "family", "citywalk"],
    note: "市中心散步好去处",
  }),
  place("demo-xm-railway", "铁路文化公园", "park", 118.088944, 24.456663, {
    cost: 0,
    popularity: 3.9,
    tags: ["citywalk", "slow"],
    note: "旧铁路改成的林荫步道",
  }),
  place("demo-xm-jimei", "集美学村", "attraction", 118.087296, 24.566523, {
    cost: 0,
    popularity: 4.2,
    tags: ["classic", "culture", "architecture"],
    note: "嘉庚建筑群，红砖白石",
  }),
  place("demo-xm-longzhou", "龙舟池", "viewpoint", 118.09609, 24.566524, {
    cost: 0,
    popularity: 3.8,
    tags: ["coast", "photo"],
    note: "傍晚看落日与飞檐",
  }),
  place("demo-xm-jiageng", "嘉庚公园", "park", 118.102005, 24.57059, {
    cost: 0,
    popularity: 3.8,
    tags: ["slow", "coast"],
    note: "临海公园，看集美天际线",
  }),
  place("demo-xm-botanical", "厦门园林植物园", "park", 118.104535, 24.451022, {
    cost: 30,
    costNote: "参考门票",
    popularity: 4.4,
    tags: ["nature", "family", "photo"],
    note: "雨林喷雾与多肉世界",
  }),
  place("demo-xm-cablecar", "钟鼓索道", "viewpoint", 118.089606, 24.451027, {
    cost: 70,
    costNote: "参考票价",
    popularity: 4.2,
    tags: ["photo", "family"],
    note: "空中看山与海",
  }),
  place("demo-xm-haiwan", "海湾公园", "park", 118.073313, 24.475648, {
    cost: 0,
    popularity: 3.9,
    tags: ["coast", "slow", "photo"],
    note: "傍晚看海沧大桥",
  }),
  place("demo-xm-tianzhu", "天竺山森林公园", "nature", 117.930367, 24.585393, {
    cost: 30,
    costNote: "参考门票",
    popularity: 3.4,
    tags: ["nature", "family"],
    note: "城郊徒步与溪谷，适合安排半天",
  }),
  place("demo-xm-beichen", "北辰山", "nature", 118.237819, 24.792688, {
    cost: 25,
    costNote: "参考门票",
    popularity: 3.4,
    tags: ["nature"],
    note: "同安山水与瀑布",
  }),
  place("demo-xm-marci", "灵玲国际马戏城", "attraction", 118.046807, 24.591364, {
    cost: 180,
    costNote: "参考票价",
    popularity: 3.7,
    tags: ["family", "indoor"],
    note: "亲子看大马戏",
  }),
  place("demo-xm-science", "厦门科技馆", "museum", 118.103254, 24.49339, {
    cost: 100,
    costNote: "参考门票",
    popularity: 3.6,
    tags: ["family", "indoor"],
    note: "亲子互动展馆",
  }),
  place("demo-xm-overseas", "华侨博物院", "museum", 118.085306, 24.444558, {
    cost: 0,
    popularity: 3.6,
    tags: ["culture", "indoor"],
    note: "了解华侨历史",
  }),
  place("demo-xm-chenjiageng", "陈嘉庚纪念馆", "museum", 118.102397, 24.572624, {
    cost: 0,
    popularity: 3.7,
    tags: ["culture", "indoor"],
    note: "读懂集美学村",
  }),
  place("demo-xm-wutong", "五通灯塔公园", "park", 118.186697, 24.526136, {
    cost: 0,
    popularity: 3.6,
    tags: ["coast", "photo"],
    note: "灯塔与海堤",
  }),
  place("demo-xm-yefengzhai", "椰风寨", "beach", 118.163618, 24.450518, {
    cost: 0,
    popularity: 3.8,
    tags: ["coast", "family"],
    note: "环岛路边的沙滩",
  }),
  place("demo-xm-laoqiangyuan", "厦门老院子", "attraction", 118.070942, 24.627477, {
    cost: 120,
    costNote: "参考票价",
    popularity: 3.6,
    tags: ["family", "culture"],
    note: "闽南文化演艺",
  }),
  place("demo-xm-wuyuanwan", "五缘湾", "park", 118.162391, 24.535111, {
    cost: 0,
    popularity: 4.1,
    tags: ["coast", "family", "slow"],
    note: "湿地木栈道与海湾，傍晚很舒服",
  }),
  place("demo-xm-yanwubridge", "演武大桥观景平台", "viewpoint", 118.080921, 24.439695, {
    cost: 0,
    popularity: 4.2,
    tags: ["coast", "photo"],
    note: "离海面很近的观景平台",
  }),
  place("demo-xm-huaxinlu", "华新路", "street", 118.082667, 24.461775, {
    cost: 0,
    popularity: 4.1,
    tags: ["citywalk", "cafe", "photo"],
    note: "老别墅与咖啡馆",
  }),
];

export const XIAMEN_MEALS: Place[] = [
  place("demo-xm-huangzehe", "黄则和花生汤", "food", 118.071086, 24.455994, {
    cost: 20,
    costNote: "参考人均",
    popularity: 4.4,
    tags: ["food", "local", "breakfast"],
    note: "花生汤配油条，老厦门早餐",
  }),
  place("demo-xm-wutang", "乌糖沙茶面", "food", 118.079316, 24.446307, {
    cost: 30,
    costNote: "参考人均",
    popularity: 4.5,
    tags: ["food", "local"],
    note: "本地人排队的沙茶面",
  }),
  place("demo-xm-sili", "四里沙茶面", "food", 118.091371, 24.490472, {
    cost: 25,
    costNote: "参考人均",
    popularity: 4.2,
    tags: ["food", "local"],
    note: "老牌社区味道",
  }),
  place("demo-xm-chujiayuan", "褚家园咖啡馆", "cafe", 118.064803, 24.445451, {
    cost: 60,
    costNote: "参考人均",
    popularity: 4.3,
    island: ISLAND,
    tags: ["cafe", "slow", "island"],
    note: "老别墅院子里的咖啡",
  }),
  place("demo-xm-suxiaotang", "苏小糖", "cafe", 118.064405, 24.451951, {
    cost: 30,
    costNote: "参考人均",
    popularity: 3.9,
    island: ISLAND,
    tags: ["cafe", "souvenir", "island"],
    note: "牛轧糖与伴手礼",
  }),
  place("demo-xm-zhongshan-food", "中山路 · 老字号小吃", "food", 118.0728, 24.456, {
    cost: 40,
    costNote: "街区参考人均",
    popularity: 4.2,
    tags: ["food", "local", "cluster"],
    note: "小吃集中区，具体门店现场挑",
  }),
  place("demo-xm-bashi-food", "八市 · 海鲜排档", "food", 118.069711, 24.460957, {
    cost: 120,
    costNote: "街区参考人均",
    popularity: 4.2,
    tags: ["food", "seafood", "cluster"],
    note: "海鲜排档集中区，先问价再下单",
  }),
  place("demo-xm-shapowei-cafe", "沙坡尾 · 咖啡街区", "cafe", 118.082466, 24.440186, {
    cost: 45,
    costNote: "街区参考人均",
    popularity: 4.1,
    tags: ["cafe", "slow", "cluster"],
    note: "沿海一排咖啡馆，随便挑一家坐坐",
  }),
  place("demo-xm-shapowei-food", "沙坡尾 · 海鲜排档", "food", 118.0829, 24.4399, {
    cost: 120,
    costNote: "街区参考人均",
    popularity: 4.1,
    tags: ["food", "seafood", "cluster"],
    note: "避风坞边的海鲜排档，注意时价",
  }),
  place("demo-xm-longtoulu-food", "龙头路 · 岛上小吃", "food", 118.0663, 24.4487, {
    cost: 45,
    costNote: "街区参考人均",
    popularity: 4.1,
    island: ISLAND,
    tags: ["food", "local", "cluster", "island"],
    note: "鱼丸、海蛎煎和奶茶都在这条街",
  }),
  place("demo-xm-huaxinlu-cafe", "华新路 · 咖啡巷", "cafe", 118.082667, 24.461775, {
    cost: 45,
    costNote: "街区参考人均",
    popularity: 4.1,
    tags: ["cafe", "slow", "cluster"],
    note: "老别墅里的咖啡馆，适合下午歇脚",
  }),
  place("demo-xm-zengcuoan-food", "曾厝垵 · 小吃街", "food", 118.118008, 24.428557, {
    cost: 40,
    costNote: "街区参考人均",
    popularity: 4,
    tags: ["food", "local", "cluster"],
    note: "小吃密集，挑人多的摊子通常不会错",
  }),
  place("demo-xm-huangcuo-food", "黄厝 · 海鲜排档", "food", 118.155203, 24.444452, {
    cost: 100,
    costNote: "街区参考人均",
    popularity: 3.9,
    tags: ["food", "seafood", "cluster", "coast"],
    note: "海边排档集中区，日落前后最有气氛",
  }),
  place("demo-xm-jimei-food", "集美大社 · 本地小吃", "food", 118.0935, 24.5652, {
    cost: 35,
    costNote: "街区参考人均",
    popularity: 3.8,
    tags: ["food", "local", "cluster"],
    note: "沙茶面、芋包和海蛎炸的社区味道",
  }),
];

export const DEMO_HOTELS: Place[] = [
  place("demo-xm-hotel-binguan", "厦门宾馆", "hotel", 118.087117, 24.458853, {
    cost: 520,
    costNote: "参考房价",
    note: "老牌园林酒店，位置居中",
  }),
  place("demo-xm-hotel-millennium", "厦门海景千禧大酒店", "hotel", 118.077551, 24.453797, {
    cost: 700,
    costNote: "参考房价",
    note: "临海，去中山路方便",
  }),
  place("demo-xm-hotel-huayuan", "海上花园酒店", "hotel", 118.065171, 24.442312, {
    cost: 1000,
    costNote: "参考房价",
    island: ISLAND,
    note: "住在鼓浪屿岛上，清晨很安静",
  }),
];

export const DEMO_NOTE =
  "当前为免 Key 演示模式：厦门点位使用真实坐标与开源地图，票价为参考值；步行/骑行/驾车路线为真实路径，公交耗时为估算。配置高德 Key 后可获得任意城市的真实商户与公交数据。";
