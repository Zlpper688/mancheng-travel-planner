"""从攻略正文里抽出逐日路线。

输入是 extract_text.extract_text() 返回的干净正文。输出是一组候选路线和一条
canonical 路线。核心假设来自这批「我是驴友」PDF 的排版：

- 大多数日程写成 `D1 天安门广场—故宫—南锣鼓巷`；
- 少数港版排版把路线名放在 `D1` 上一行（`迪士尼 / D1`）；
- 正文段落、餐厅菜单、公交线路、门票联票都不是行程，宁可判 none 也不硬凑。

只在有把握时输出；拿不准的路线由 build_guides 标成 needsReview。
"""

from __future__ import annotations

import re

DAY_RE = re.compile(
    r"^[\s#>*•·\-–—]*"
    r"(?:"
    r"(?:D|DAY|Day|day)\s*0?(\d{1,2})"
    r"|第\s*([一二三四五六七八九十两0-9]{1,3})\s*天"
    r")"
    r"\s*(?:[：:.、\-—|｜]\s*)?"
    r"(.*)$"
)
CN = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
SEP = re.compile(r"\s*(?:-{1,2}|[–—~～→➔»、，,：:]|到|至)\s*")
SEP_CHAR = re.compile(r"[–—~～→➔»]|-{1,2}|、")
PROSE = re.compile(
    r"[。！？；]|如果|建议|可以|因为|所以|但是|然后|我们|大家|记得|注意|需要|适合|最好"
)
TITLE_RE = re.compile(
    r"([\u4e00-\u9fa5“”\"'A-Za-z0-9·\s]{2,16}(?:一日|两日|二日|三日|四日|五日|六日|七日|八日|九日|十日|\d{1,2}日)(?:游|行程))"
)
GENERIC = re.compile(
    r"^(?:早餐|午餐|晚餐|午饭|晚饭|早点|夜宵|小吃|美食|酒店|住宿|民宿|自由活动|购物|返程|回程|出发|到达|当天|"
    r"晚上|上午|下午|中午|徒步|索道|缆车|电瓶车|大巴|巴士|火车|飞机|轮船|坐船|休息|拍照|看日出|看日落|"
    r"市区|景区|周边|附近|路上|途中|机场|车站|码头|漫步|闲逛|骑行|自驾|包车|出海|上路|启程|"
    r"等待|休整|疯狂|回归|穿越|定格|登顶|补给|收拾行李|办理入住|演出)$"
)
LEAD_VERB = re.compile(
    r"^(?:乘坐|乘车|乘船|乘|前往|到达|抵达|游览|参观|逛逛|逛|去|到|返回|回到|从|经|沿|在|夜宿|住宿|宿|住|再|先|然后|"
    r"接着|之后|步行|打车|自驾|包车|出海|登岛|上岛|下岛|漫步|闲逛|骑行|上路|启程|另外|再者|登上|包括|徒步)"
)
ROUTE_LABEL = re.compile(r"(?:半日游|一日游|两日游|二日游|三日游|四日游|五日游|经典路线|深度游)$")
ASCII_LEAD = re.compile(r"^[A-Za-z]{2,}\s+")
TAIL = re.compile(r"(?:附近|一带|周边|方向|后返回|然后返回|回酒店|看日出|看日落|观日出|观日落|玩雪圈|玩雪|拍照|徒步|后)$")
BAD_TOKEN = re.compile(
    r"(上午|下午|中午|晚上|早上|清晨|傍晚|早晨|夜里|乘车|乘船|乘|步行|前往|返回|然后|接着|之后|可以|建议|"
    r"品尝|入住|安排|自由活动|休息|拍照|欣赏|感受|体验|游览|参观|出发|抵达|到达|的|等，|等。|"
    r"联票|门票|通票|套票|TIPS|Tips|tips|自然醒|看看|就没有|聆听|欢歌|里面|能买|不过|等经典|等景点|"
    r"各式|特色物品|特产|同第|选好|住处|"
    r"找个地方|填饱肚子|住下来|第二天|储备体力|多约|三个小时|全程|赶往|而是一个|并不|看一看|"
    r"我们|你们|他们|大家|什么|怎么|这样|那样|时候|地方|感觉|觉得|一定|已经|正在|没有|不要|还是|就是|"
    r"都是|也是|不是|一个|一下|一起|之前|因为|所以|而且|但是|如果|需要|适合|最好|记得|注意|"
    r"享用|早餐|午餐|晚餐|午饭|晚饭|白天|观赏|观看|玩雪|游玩)"
)
PLACE_HINT = re.compile(
    r"(山|峰|岭|岩|洞|峡|湖|海|河|江|溪|泉|岛|湾|滩|港|桥|塔|寺|庙|宫|观|堂|殿|阁|楼|亭|台|门|园|院|馆|城|"
    r"街|路|巷|坊|场|村|镇|府|居|里|道|碑|陵|墓|遗址|古镇|古城|老街|中心|广场|公园|景区|博物院|博物馆|纪念馆|"
    r"大剧院|步行街|湿地|森林|草原|沙|瀑布|石林|长城|大学|池|乡|措|顶|松|关|川|营|栈|基地|夜市|雪山|冰川|峡谷|"
    r"群岛|县)"
)
SECTION = re.compile(
    r"景点|住宿|餐饮|购物|交通|实用信息|背景|线路推荐|推荐线路|目录|印象|活动|亮点|攻略|地图|手绘|更多线路"
)


def cn_num(token: str) -> int | None:
    token = token.strip()
    if token.isdigit():
        return int(token)
    if token == "十":
        return 10
    if "十" in token:
        left, _, right = token.partition("十")
        tens = CN.get(left, 1) if left else 1
        ones = CN.get(right, 0) if right else 0
        return tens * 10 + ones
    vals = [CN[c] for c in token if c in CN]
    return vals[0] if len(vals) == 1 else None


def is_prose(line: str) -> bool:
    if len(line) > 60:
        return True
    if PROSE.search(line):
        return True
    return line.endswith(("。", "，", "！", "？", "；"))


def sep_count(line: str) -> int:
    return len(SEP_CHAR.findall(line))


def route_like(line: str) -> bool:
    if not line or len(line) > 90:
        return False
    if is_prose(line):
        return False
    seps = sep_count(line)
    if seps >= 2:
        return True
    return seps == 1 and len(line) <= 32


def clean_stop(token: str) -> str:
    token = re.sub(r"^(?:D|DAY|Day|day)\s*0?\d{1,2}\s*[：:.、\-—]?\s*", "", token.strip())
    token = re.sub(r"^第\s*[一二三四五六七八九十两0-9]{1,3}\s*天\s*[：:.、\-—]?\s*", "", token)
    token = re.sub(r"[（(【\[〔][^）)】\]〕]*[）)】\]〕]", "", token)
    token = re.sub(r"[（(【\[〔].*$", "", token)
    token = token.strip(" \u3000·•,，;；:：。.!！?？\"“”'‘’")
    token = ASCII_LEAD.sub("", token)
    token = LEAD_VERB.sub("", token)
    token = TAIL.sub("", token)
    token = ROUTE_LABEL.sub("", token)
    token = token.strip(" \u3000·•,，;；:：）)】]〕》」-—–")
    return token


def stop_kind(name: str) -> str:
    if re.search(r"早餐|午餐|晚餐|午饭|晚饭|小吃|夜市|美食", name):
        return "meal"
    if re.search(r"宿|酒店|民宿|客栈", name):
        return "stay"
    return "sight"


def split_stops(raw: str) -> list[dict]:
    tokens = SEP.split(raw)
    stops = []
    seen = set()
    for token in tokens:
        name = clean_stop(token)
        if len(name) < 2 or len(name) > 14:
            continue
        if not re.search(r"[\u4e00-\u9fa5]", name):
            continue
        # 「2路-4路-7路」「2-3天」这类编号段落不是行程点位
        if re.search(r"\d+\s*[路号线天]", name):
            continue
        if re.search(r"\s\d|\d\s", name):
            continue
        if re.match(r"^看", name):
            continue
        if re.search(r"[“”\"]", name):
            continue
        # 《太极武当》这类演出名不是点位
        if re.search(r"[《》]", name):
            continue
        if GENERIC.match(name):
            continue
        if BAD_TOKEN.search(name):
            continue
        if name in seen:
            continue
        seen.add(name)
        stops.append({"name": name, "kind": stop_kind(name)})
        if len(stops) >= 12:
            break
    return stops


def day_from(match) -> int | None:
    if match.group(1):
        return int(match.group(1))
    return cn_num(match.group(2) or "")


def can_join(prev: str, nxt: str) -> bool:
    """只有真的被排版折断的同一行路线才拼接。"""
    if not prev or not nxt or len(nxt) > 60 or is_prose(nxt):
        return False
    if re.search(r"[。！？；]", nxt):
        return False
    if prev.endswith(("—", "-", "–", "→", "~", "～", "、", "，", ",")):
        return True
    # 换行把「天然图画 / 坊—前山大门」拆开：下一行以 1-2 字残片开头。
    # 逗号不算，否则「清晨，在观日台…」这类正文会被拼进路线。
    if re.match(r"^[\u4e00-\u9fa5]{1,2}[—\-–→~、]", nxt):
        return True
    return False


def name_line_ok(line: str) -> bool:
    if not line or is_prose(line) or DAY_RE.match(line) or TITLE_RE.search(line):
        return False
    if SECTION.search(line) or "·" in line or " by " in line:
        return False
    stops = split_stops(line)
    if not stops:
        return False
    if len(stops) == 1:
        return len(line) <= 8
    if not route_like(line):
        return False
    # 多停靠点的「路线名」必须真的像地名；散文里的「、」也会被切成多段。
    return place_score(stops) >= 0.5


def find_title(lines: list[str], index: int, allow_forward: bool = False) -> str | None:
    for offset in range(1, 12):
        if index - offset < 0:
            break
        line = lines[index - offset].strip()
        if not line or is_prose(line):
            continue
        match = TITLE_RE.search(line)
        if match:
            return match.group(1).strip()
    if allow_forward:
        for offset in range(1, 3):
            if index + offset >= len(lines):
                break
            line = lines[index + offset].strip()
            match = TITLE_RE.search(line)
            if match:
                return match.group(1).strip()
    return None


TITLE_DAYS = re.compile(r"([一二三四五六七八九十两]|\d{1,2})\s*日")


def title_day_cap(title: str | None) -> int | None:
    if not title:
        return None
    match = TITLE_DAYS.search(title)
    if not match:
        return None
    token = match.group(1)
    if token.isdigit():
        return max(1, min(15, int(token)))
    return cn_num(token)


def collect_candidates(lines: list[str]) -> list[dict]:
    cands = []
    used_name_lines: set[int] = set()
    i = 0
    while i < len(lines):
        line = lines[i]
        match = DAY_RE.match(line)
        if not match:
            i += 1
            continue
        day = day_from(match)
        rest = match.group(3).strip()
        if day is None:
            i += 1
            continue
        block = [rest] if rest else []
        j = i + 1
        while j < len(lines) and j <= i + 4:
            nxt = lines[j].strip()
            if not nxt or DAY_RE.match(nxt):
                break
            if block and can_join(block[-1], nxt):
                block.append(nxt)
                j += 1
                continue
            if not block and route_like(nxt) and len(nxt) <= 40:
                block.append(nxt)
                j += 1
                continue
            break
        raw = "".join(block).strip()
        stops = split_stops(raw) if raw else []
        if not stops and not rest:
            # 港版排版把路线名放在 Dn 上一行：迪士尼 / D1
            k = i - 1
            while k >= 0 and i - k <= 6:
                prev = lines[k].strip()
                if not prev or DAY_RE.match(prev) or TITLE_RE.search(prev):
                    k -= 1
                    continue
                if is_prose(prev) or SECTION.search(prev) or " by " in prev:
                    k -= 1
                    continue
                if k not in used_name_lines and name_line_ok(prev):
                    stops = split_stops(prev)
                    raw = prev
                    if stops:
                        used_name_lines.add(k)
                        break
                k -= 1
        title = find_title(lines, i, allow_forward=not rest)
        cands.append({"day": day, "raw": raw, "stops": stops, "pos": i, "title": title})
        i = j if j > i + 1 else i + 1
    return cands


MAX_DAY_GAP = 45


def build_chains(cands: list[dict]) -> list[list[dict]]:
    """按日期递增拼线路；同一天多条候选时选停靠点更多的。"""
    by_day: dict[int, list[dict]] = {}
    for cand in cands:
        if cand["stops"]:
            by_day.setdefault(cand["day"], []).append(cand)
    chains = []
    for start in by_day.get(1, []):
        chain = [start]
        last_pos = start["pos"]
        day = 1
        cap = title_day_cap(start["title"]) or 15
        while day < cap:
            opts = [
                c
                for c in by_day.get(day + 1, [])
                if c["pos"] > last_pos and c["pos"] - last_pos <= MAX_DAY_GAP
            ]
            if not opts:
                break
            nxt = max(opts, key=lambda c: (len(c["stops"]), -c["pos"]))
            chain.append(nxt)
            last_pos = nxt["pos"]
            day += 1
        chains.append(chain)
    return chains


def chain_stats(chain: list[dict]) -> tuple[int, int]:
    return len(chain), sum(len(c["stops"]) for c in chain)


def chain_valid(chain: list[dict]) -> bool:
    days, stops = chain_stats(chain)
    return (days >= 2 and stops >= 3) or (days == 1 and stops >= 3)


def route_valid(route: dict) -> bool:
    days = len(route["days"])
    stops = route["stops"]
    return (days >= 2 and stops >= 3) or (days == 1 and stops >= 3)


def substantial(route: dict) -> bool:
    return len(route["days"]) >= 2 and route["stops"] >= 4


def run_days(chain: list[dict]) -> list[dict]:
    return [
        {
            "day": c["day"],
            "stops": c["stops"],
            "raw": c["raw"][:200],
            "title": c["title"],
        }
        for c in chain
    ]


def place_score(stops: list[dict]) -> float:
    if not stops:
        return 0.0
    hits = sum(1 for stop in stops if PLACE_HINT.search(stop["name"]))
    return hits / len(stops)


def schedule_start(lines: list[str]) -> int:
    for i, line in enumerate(lines):
        if re.search(r"线路推荐|推荐线路|行程线路|游览线路|经典线路|SCHEDULE|行程安排", line):
            return i
    return 0


def block_fallback(lines: list[str]):
    best = None
    block: list[tuple[int, str]] = []
    start = schedule_start(lines)

    def consider(block_lines: list[tuple[int, str]]):
        nonlocal best
        joined = "".join(line for _, line in block_lines)
        if re.search(r"[。；！？]", joined):
            return
        stops = split_stops(joined)
        if len(stops) < 4:
            return
        menu_hits = sum(
            1
            for s in stops
            if re.search(r"山药|清蒸|清炒|红烧|爆炒|油炸|凉拌|蜜汁|沙棘|锅盔", s["name"])
        )
        if menu_hits >= 2:
            return
        score_place = place_score(stops)
        if score_place < 0.55:
            return
        pos = block_lines[0][0]
        score = (1 if pos >= start else 0, score_place, len(stops))
        if best is None or score > best[0]:
            best = (score, stops, pos, joined)

    for i, line in enumerate(lines):
        if route_like(line) and not re.search(r"[，。；！？]", line):
            block.append((i, line))
            continue
        if block:
            consider(block)
            block = []
    if block:
        consider(block)
    return best


def _route_from_chain(chain: list[dict]) -> dict:
    days = run_days(chain)
    title = next((d["title"] for d in days if d["title"]), None)
    cap = title_day_cap(title)
    # 「来一个杭州乐园一日游」这类被正文截出来的标题，天数对不上就不要用
    if cap is not None and cap < len(days):
        title = None
    return {
        "title": title,
        "days": days,
        "stops": sum(len(d["stops"]) for d in days),
        "fallback": False,
    }


def parse_routes(text: str) -> dict:
    lines = [line.strip() for line in text.splitlines()]
    cands = collect_candidates(lines)
    chains = build_chains(cands)

    routes = []
    seen = set()
    for chain in chains:
        key = tuple((c["day"], c["raw"]) for c in chain)
        if key in seen:
            continue
        seen.add(key)
        routes.append(_route_from_chain(chain))

    valid = [r for r in routes if route_valid(r)]
    # 攻略正文通常先给主推路线，附录/周边线路在后。取第一条真正的多日路线，
    # 避免被文末更长的周边拼盘（坝上、壶口、海南环线）抢走默认路线。
    canonical = next((r for r in valid if substantial(r)), None)
    if canonical is None and valid:
        canonical = next((r for r in valid if r["stops"] >= 3), valid[0])
    if canonical is None and routes:
        canonical = max(routes, key=lambda r: (len(r["days"]), r["stops"]))

    if canonical is None or canonical["stops"] < 3:
        fb = block_fallback(lines)
        if fb:
            _, stops, _pos, joined = fb
            fb_route = {
                "title": "精华路线",
                "days": [{"day": 1, "stops": stops, "raw": joined[:200], "title": None}],
                "stops": len(stops),
                "fallback": True,
            }
            if canonical is None or len(stops) > canonical["stops"]:
                routes.append(fb_route)
                canonical = fb_route

    return {"routes": routes, "canonical": canonical}