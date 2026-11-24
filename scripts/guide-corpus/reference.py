"""生成/加载「干净语料二字组」参考表。

抽取时用它判断一份 PDF 的原始文本和字体 cmap 修复文本哪个更像中文：
部分 PDF 的 ToUnicode 是对的、内嵌字体 cmap 反而错位，盲目按 cmap 修
会得到「中头大街」「位云」这类看似正常但搜不到的错名。参考表只用于比较
两种文本的相对通顺度，不参与生成路线。

重建参考表（先跑一次 build_guides.py 得到 build-report.json）：
    python scripts/guide-corpus/reference.py --root "D:/国内旅游攻略pdf" \
        --report data/guides/build-report.json
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path

import pymupdf

CJK_RUN = re.compile(r"[\u4e00-\u9fa5]{2,}")
DEFAULT_PATH = Path(__file__).with_name("reference_bigrams.tsv")


def raw_text(path: Path) -> str:
    doc = pymupdf.open(path)
    text = "\n".join(page.get_text("text") for page in doc)
    doc.close()
    return text


def count_bigrams(text: str) -> Counter:
    counts: Counter = Counter()
    for match in CJK_RUN.finditer(text):
        run = match.group(0)
        for i in range(len(run) - 1):
            counts[run[i : i + 2]] += 1
    return counts


@lru_cache(maxsize=1)
def load_reference() -> dict[str, int] | None:
    if not DEFAULT_PATH.exists():
        return None
    table: dict[str, int] = {}
    for line in DEFAULT_PATH.read_text(encoding="utf-8").splitlines():
        bigram, _, count = line.partition("\t")
        if len(bigram) == 2 and count.isdigit():
            table[bigram] = int(count)
    return table


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="D:/国内旅游攻略pdf")
    parser.add_argument("--report", default="data/guides/build-report.json")
    parser.add_argument("--out", default=str(DEFAULT_PATH))
    parser.add_argument("--top", type=int, default=10000)
    args = parser.parse_args(argv)

    root = Path(args.root)
    report = json.loads(Path(args.report).read_text(encoding="utf-8"))
    clean = [entry for entry in report["files"] if entry["encoding"] == "clean"]
    counts: Counter = Counter()
    for entry in clean:
        path = root / entry["source"]
        if path.exists():
            counts.update(count_bigrams(raw_text(path)))

    ranked = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[: args.top]
    target = Path(args.out)
    target.write_text(
        "\n".join(f"{bigram}\t{count}" for bigram, count in ranked) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "cleanDocs": len(clean),
                "bigrams": len(counts),
                "written": len(ranked),
                "out": target.as_posix(),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
