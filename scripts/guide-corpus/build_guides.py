"""把 PDF 攻略库编译成稳定的结构化路线数据。

    python scripts/guide-corpus/build_guides.py \
        --root D:/国内旅游攻略pdf --out data/guides

输出：
    data/guides/<id>.json       一份攻略的全部候选路线
    data/guides/index.json      城市/标题/路线数/状态索引
    data/guides/build-report.json  逐文件抽取质量报告

同一份 PDF 重复构建应得到完全相同的 JSON（不写时间戳），方便 diff。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path

from extract_text import extract_text
from routes import PLACE_HINT, parse_routes, title_day_cap

# 景区型文件名在选攻略时也要能被所属城市搜到
CITY_ALIASES = {
    "故宫": ["北京"],
    "鼓浪屿": ["厦门"],
    "束河": ["丽江"],
    "泸沽湖": ["丽江"],
    "千岛湖": ["杭州"],
    "西溪湿地": ["杭州"],
    "普陀山": ["舟山"],
    "乌镇": ["嘉兴"],
    "西塘": ["嘉兴"],
    "宏村": ["黄山"],
    "雁荡山": ["温州"],
}

SOURCE_PREFIX = "我是驴友-"


def split_source(path: Path, root: Path) -> tuple[str, str, str]:
    rel = path.relative_to(root)
    region = rel.parts[0] if len(rel.parts) > 1 else ""
    stem = path.stem
    base = stem.split(SOURCE_PREFIX, 1)[-1]
    title = re.sub(r"(旅游攻略|攻略)$", "", base).strip() or base
    city = re.sub(r"(旅游攻略|购物攻略|美食攻略|攻略|旅游|自由行)$", "", base)
    city = re.sub(r"(?:\d+|[一二三四五六七八九十两])\s*日$", "", city)
    city = re.sub(r"(购物|美食)$", "", city).strip() or title
    return region.removesuffix("地区"), city, title


def needs_review(route: dict) -> bool:
    stops = [stop for day in route["days"] for stop in day["stops"]]
    if route["fallback"] or len(stops) < 3:
        return True
    cap = title_day_cap(route["title"])
    if cap is not None and cap != len(route["days"]):
        return True
    if any(len(day["stops"]) > 8 for day in route["days"]):
        return True
    if any(len(stop["name"]) > 10 for stop in stops):
        return True
    weak = sum(1 for stop in stops if not PLACE_HINT.search(stop["name"]))
    return weak / len(stops) > 0.4


def build_route(route: dict, index: int) -> dict:
    return {
        "id": f"r{index}",
        "title": route["title"],
        "days": route["days"],
        "stopCount": route["stops"],
        "source": "fallback" if route["fallback"] else "day-headers",
        "needsReview": needs_review(route),
    }


def day_summary(route: dict | None) -> str:
    if not route:
        return ""
    return " | ".join(
        f"D{day['day']}: " + "-".join(stop["name"] for stop in day["stops"])
        for day in route["days"]
    )


def build(root: Path, out: Path) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    paths = sorted(root.rglob("*.pdf"))
    entries = []
    report = []
    status_count = {"ok": 0, "partial": 0, "none": 0}
    encoding_count = {"clean": 0, "repaired": 0, "suspect": 0}

    for position, path in enumerate(paths, start=1):
        rel = path.relative_to(root).as_posix()
        guide_id = "g-" + hashlib.sha1(rel.encode("utf-8")).hexdigest()[:8]
        region, city, title = split_source(path, root)
        text, stats = extract_text(path)
        parsed = parse_routes(text)

        canonical = parsed["canonical"]
        ordered = []
        if canonical is not None:
            ordered.append(canonical)
        ordered.extend(route for route in parsed["routes"] if route is not canonical)
        ordered = [route for route in ordered if route["stops"]]

        routes = [build_route(route, i) for i, route in enumerate(ordered, start=1)]
        canonical_route = routes[0] if routes else None
        stops = canonical["stops"] if canonical else 0
        days = len(canonical["days"]) if canonical else 0
        if canonical is None:
            status = "none"
        elif stops >= 3:
            status = "ok"
        else:
            status = "partial"
        status_count[status] += 1
        encoding_count[stats["encoding"]] = encoding_count.get(stats["encoding"], 0) + 1

        entry = {
            "id": guide_id,
            "city": city,
            "cityAliases": CITY_ALIASES.get(city, []),
            "region": region,
            "title": title,
            "source": rel,
            "encoding": stats["encoding"],
            "status": status,
            "canonicalRouteId": canonical_route["id"] if canonical_route else None,
            "routes": routes,
        }
        (out / f"{guide_id}.json").write_text(
            json.dumps(entry, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        entries.append(
            {
                "id": guide_id,
                "city": city,
                "cityAliases": CITY_ALIASES.get(city, []),
                "region": region,
                "title": title,
                "status": status,
                "encoding": stats["encoding"],
                "routeCount": len(routes),
                "canonicalRouteId": entry["canonicalRouteId"],
                "canonicalTitle": canonical_route["title"] if canonical_route else None,
                "days": days,
                "stops": stops,
                "needsReview": bool(canonical_route and canonical_route["needsReview"]),
                "routes": [
                    {
                        "id": route["id"],
                        "title": route["title"],
                        "days": len(route["days"]),
                        "stops": route["stopCount"],
                        "needsReview": route["needsReview"],
                    }
                    for route in routes
                ],
            }
        )
        report.append(
            {
                "id": guide_id,
                "source": rel,
                "pages": stats["pages"],
                "chars": stats["chars"],
                "encoding": stats["encoding"],
                "applied": stats["applied"],
                "substitutions": stats["substitutions"],
                "repairMode": stats["repair_mode"],
                "residual": stats["residual"],
                "status": status,
                "routes": len(routes),
                "canonical": day_summary(canonical),
                "needsReviewRoutes": [route["id"] for route in routes if route["needsReview"]],
            }
        )
        print(
            f"[{position:3d}/{len(paths)}] {status:7s} {city:<6s} routes={len(routes)} {path.name}",
            flush=True,
        )

    entries.sort(key=lambda item: (item["region"], item["city"], item["title"]))
    index = {
        "version": 1,
        "count": len(entries),
        "statusCount": status_count,
        "encodingCount": encoding_count,
        "guides": entries,
    }
    (out / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (out / "build-report.json").write_text(
        json.dumps(
            {
                "version": 1,
                "count": len(report),
                "statusCount": status_count,
                "encodingCount": encoding_count,
                "files": report,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return {"count": len(entries), "status": status_count, "encoding": encoding_count}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="D:/国内旅游攻略pdf")
    parser.add_argument("--out", default="data/guides")
    args = parser.parse_args()
    summary = build(Path(args.root), Path(args.out))
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())