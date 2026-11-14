import json
import math
import time
import urllib.parse
import urllib.request

CENTER = (118.067, 24.447)

ITEMS = [
    # name, kind, ticket, note
    ("鼓浪屿", "attraction", 0, "世界文化遗产，建议留半天慢慢走"),
    ("日光岩", "viewpoint", 50, "全岛制高点，看红瓦与海"),
    ("菽庄花园", "park", 30, "藏海园林，内有钢琴博物馆"),
    ("皓月园", "park", 15, "临海看郑成功雕像"),
    ("风琴博物馆", "museum", 20, "八卦楼里的风琴收藏"),
    ("厦门海底世界", "museum", 117, "适合带小朋友"),
    ("海天堂构", "museum", 88, "鼓浪屿老别墅建筑群"),
    ("龙头路商业街", "street", 0, "岛上小吃与伴手礼集中地"),
    ("中山路步行街", "street", 0, "骑楼老街，晚上更有味道"),
    ("八市", "market", 0, "最地道的菜市场烟火气"),
    ("沙坡尾", "street", 0, "老渔港改造的文艺街区"),
    ("沙坡尾艺术西区", "street", 0, "看展、喝咖啡、吹海风"),
    ("曾厝垵", "street", 0, "文创村，小吃密集"),
    ("白城沙滩", "beach", 0, "厦大旁的城市沙滩"),
    ("胡里山炮台", "attraction", 25, "看海防古迹与克虏伯大炮"),
    ("南普陀寺", "temple", 0, "香火旺，素饼值得带"),
    ("厦门大学", "attraction", 0, "进校需提前预约"),
    ("环岛路", "attraction", 0, "沿海骑行与散步的经典线"),
    ("黄厝海滩", "beach", 0, "人少一些的日出沙滩"),
    ("演武大桥观景平台", "viewpoint", 0, "离海面很近的观景平台"),
    ("五缘湾湿地公园", "park", 0, "湿地、木栈道与黑天鹅"),
    ("白鹭洲公园", "park", 0, "市中心散步好去处"),
    ("铁路文化公园", "park", 0, "旧铁路改成的林荫步道"),
    ("华新路", "street", 0, "老别墅与咖啡馆"),
    ("集美学村", "attraction", 0, "嘉庚建筑群，红砖白石"),
    ("龙舟池", "viewpoint", 0, "傍晚看落日与飞檐"),
    ("嘉庚公园", "park", 0, "临海公园，看集美天际线"),
    ("厦门园林植物园", "park", 30, "雨林喷雾与多肉世界"),
    ("钟鼓索道", "viewpoint", 70, "空中看山与海"),
    ("观音山沙滩", "beach", 0, "开阔的东海岸沙滩"),
    ("狐尾山公园", "park", 0, "山顶看城市与海"),
    ("海湾公园", "park", 0, "傍晚看海沧大桥"),
    ("仙岳公园", "park", 0, "本地人的登山步道"),
    ("南湖公园", "park", 0, "闹市里的一片水面"),
    ("天竺山森林公园", "nature", 30, "城郊徒步与溪谷"),
    ("北辰山", "nature", 25, "同安山水与瀑布"),
    ("灵玲国际马戏城", "attraction", 180, "亲子看大马戏"),
    ("厦门科技馆", "museum", 100, "亲子互动展馆"),
    ("华侨博物院", "museum", 0, "了解华侨历史"),
    ("厦门市博物馆", "museum", 0, "看城市历史"),
    ("集美鳌园", "park", 30, "嘉庚墓与石雕长廊"),
    ("陈嘉庚纪念馆", "museum", 0, "读懂集美学村"),
    ("惠和石文化园", "museum", 50, "石雕与影雕体验"),
    ("鼓浪屿钢琴博物馆", "museum", 0, "菽庄花园内的钢琴收藏"),
    ("郑成功纪念馆", "museum", 0, "日光岩下的历史展馆"),
    ("三一堂", "temple", 0, "岛上标志性红砖教堂"),
    ("协和礼拜堂", "temple", 0, "安静的百年教堂"),
    ("毓园", "park", 0, "纪念林巧稚的小园子"),
    ("五通灯塔公园", "park", 0, "灯塔与海堤"),
    ("椰风寨", "beach", 0, "环岛路边的沙滩"),
    ("厦门老院子", "attraction", 120, "闽南文化演艺"),
    # food / cafe
    ("黄则和花生汤", "food", 20, "花生汤配油条，老厦门早餐"),
    ("月华沙茶面", "food", 25, "沙茶汤头浓郁"),
    ("乌糖沙茶面", "food", 30, "本地人排队的沙茶面"),
    ("四里沙茶面", "food", 25, "老牌社区味道"),
    ("阿杰五香", "food", 15, "八市里的现炸五香条"),
    ("莲欢海蛎煎", "food", 30, "局口街的海蛎煎"),
    ("局口拌面", "food", 20, "麻酱拌面配汤"),
    ("天河西门土笋冻", "food", 25, "土笋冻老店"),
    ("1980烧肉粽", "food", 30, "闽南烧肉粽"),
    ("浮屿大同鸭肉粥", "food", 25, "深夜也想来一碗"),
    ("吴再添小吃店", "food", 25, "芋包、油葱粿一站式"),
    ("阿卿春卷", "food", 15, "现包春卷"),
    ("林氏鱼丸", "food", 25, "鼓浪屿龙头路鱼丸"),
    ("张三疯奶茶", "cafe", 25, "龙头路的老牌奶茶铺"),
    ("赵小姐的店", "cafe", 35, "鼓浪屿馅饼与茶"),
    ("褚家园咖啡馆", "cafe", 60, "老别墅院子里的咖啡"),
    ("32HOW", "cafe", 45, "华新路老别墅咖啡"),
    ("吉治百货", "cafe", 50, "八市楼上的老百货与茶点"),
    ("苏小糖", "cafe", 30, "牛轧糖与伴手礼"),
    # hotels for quick pick
    ("厦门宾馆", "hotel", 520, "老牌园林酒店，位置居中"),
    ("厦门海景千禧大酒店", "hotel", 700, "临海，去中山路方便"),
]


def fetch(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": "ManchengTravelPlanner/1.0 (seed resolver)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def dist(a, b):
    dx = (a[0] - b[0]) * 102.5
    dy = (a[1] - b[1]) * 111.3
    return math.hypot(dx, dy)


out = []
misses = []
for name, kind, price, note in ITEMS:
    url = "https://photon.komoot.io/api/?q=" + urllib.parse.quote(name) + "&limit=8"
    try:
        data = fetch(url)
    except Exception as e:
        misses.append((name, f"err {e}"))
        time.sleep(0.4)
        continue
    best = None
    best_score = -99
    for f in data.get("features", []):
        p = f.get("properties", {})
        lon, lat = f["geometry"]["coordinates"]
        if not (117.8 < lon < 118.5 and 24.2 < lat < 24.9):
            continue
        score = 0.0
        label = p.get("name") or ""
        if label == name:
            score += 4
        elif name in label or label in name:
            score += 2
        if p.get("city") == "厦门市":
            score += 2
        score -= dist((lon, lat), CENTER) / 25
        if score > best_score:
            best_score = score
            best = {
                "name": name,
                "queryName": label,
                "kind": kind,
                "price": price,
                "note": note,
                "lng": round(lon, 6),
                "lat": round(lat, 6),
                "city": p.get("city"),
                "district": p.get("district"),
                "score": round(best_score, 2),
            }
    if best and best_score > -0.8:
        out.append(best)
    else:
        misses.append((name, "no local match"))
    time.sleep(0.25)

with open(".tmp/seed_resolved.json", "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
with open(".tmp/seed_misses.json", "w", encoding="utf-8") as f:
    json.dump(misses, f, ensure_ascii=False, indent=2)
print(f"resolved {len(out)} / {len(ITEMS)}; misses {len(misses)}")
