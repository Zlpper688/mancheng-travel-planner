"""从 PDF 攻略里抽取可读中文正文。

这批 PDF 有相当一部分 ToUnicode CMap 是错的：文本层里的「的」被写成「癿」，
「地处亚热带」被写成「地墮互热带」。坏的不是正文本身，而是 PDF 里的
字符映射表。PDF 内嵌了完整字体，MuPDF 的文字轨迹又能给出真实字形号，
所以用字体 cmap 反查字形号即可还原正确汉字。

流程：
1. 逐页读 get_texttrace()，对每个 span 按字体名匹配内嵌字体；
2. 用 fontTools 读字体 cmap（Unicode -> glyph id）并反转；
3. 汇总「错字 -> 正字」投票表，只采纳占比 90% 以上的映射；
4. 出现在干净字体里的字符不参与替换，避免误伤本来就对的字；
5. 把替换表作用到 get_text("text") 的全文上，保留 MuPDF 的排版顺序；
6. 用干净语料的二字组比较原文与修复文，修复文更不通顺时保留原文——
   少数 PDF 的 ToUnicode 是对的、内嵌字体 cmap 反而错位，盲修会得到
   「中头大街」「位云」这类看似正常却搜不到的错名。

单独运行时把整库文本写到指定目录，便于人工抽查：
    python scripts/guide-corpus/extract_text.py --root D:/国内旅游攻略pdf --out .tmp/corpus-text
"""

from __future__ import annotations

import math
import re
import sys
from collections import Counter, defaultdict
from io import BytesIO
from pathlib import Path

import pymupdf
from fontTools.ttLib import TTFont

from reference import load_reference

SUBSET_PREFIX = re.compile(r"^[A-Z]{6}\+")
# 修复后仍残留的高频错字，用来判断这份文件到底修没修干净。
MOJIBAKE_MARKERS = "癿墮斴贶亰绉泋匙庖亍佑耄冝吅墫欤飦"


def strip_prefix(name: str) -> str:
    return SUBSET_PREFIX.sub("", name)


class FontCmaps:
    def __init__(self, doc: pymupdf.Document):
        self.doc = doc
        self.cache: dict[int, dict[int, str]] = {}

    def inverse(self, xref: int) -> dict[int, str]:
        if xref in self.cache:
            return self.cache[xref]
        rev: dict[int, str] = {}
        try:
            _name, ext, _kind, buf = self.doc.extract_font(xref)
            if ext in ("ttf", "otf") and buf:
                font = TTFont(BytesIO(buf), fontNumber=0, lazy=True)
                order = font.getGlyphOrder()
                index = {name: i for i, name in enumerate(order)}
                for table in font["cmap"].tables:
                    if not table.isUnicode():
                        continue
                    for code, glyph in table.cmap.items():
                        gid = index.get(glyph)
                        if gid is not None:
                            rev.setdefault(gid, chr(code))
        except Exception:  # noqa: BLE001 - 字体损坏时退回原始文本即可
            pass
        self.cache[xref] = rev
        return rev


def font_candidates(doc: pymupdf.Document, page: pymupdf.Page) -> dict[str, list[int]]:
    out: dict[str, list[int]] = defaultdict(list)
    try:
        fonts = doc.get_page_fonts(page.number)
    except Exception:  # noqa: BLE001
        return out
    for entry in fonts:
        xref, ext, base = entry[0], entry[1], entry[3]
        if ext not in ("ttf", "otf"):
            continue
        out[strip_prefix(base)].append(xref)
    return out


def traced_chars(doc: pymupdf.Document):
    """逐个 span 产出 (字体名, [(错字, 正字|None), ...])。"""
    maps = FontCmaps(doc)
    for page in doc:
        candidates = font_candidates(doc, page)
        for span in page.get_texttrace():
            font = span["font"]
            xrefs = candidates.get(font) or candidates.get(strip_prefix(font))
            cmaps = [maps.inverse(x) for x in xrefs] if xrefs else []
            cmaps = [cmap for cmap in cmaps if cmap]
            if not cmaps:
                continue
            pairs: list[tuple[str, str | None]] = []
            for char in span["chars"]:
                wrong, gid = char[0], char[1]
                right = None
                for cmap in cmaps:
                    if gid in cmap:
                        right = cmap[gid]
                        break
                pairs.append((chr(wrong), right))
            yield font, pairs


def build_repair_table(doc: pymupdf.Document):
    votes: dict[str, Counter] = defaultdict(Counter)
    clean_by_font: dict[str, set[str]] = defaultdict(set)
    font_quality: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for font, pairs in traced_chars(doc):
        for wrong, right in pairs:
            if right is None:
                continue
            votes[wrong][right] += 1
            font_quality[font][0] += 1
            if right != wrong:
                font_quality[font][1] += 1
            else:
                clean_by_font[font].add(wrong)
    broken = {
        font
        for font, (total, bad) in font_quality.items()
        if total and bad / total > 0.02
    }
    table: dict[str, str] = {}
    conflicts = 0
    for wrong, counter in votes.items():
        total = sum(counter.values())
        right, count = counter.most_common(1)[0]
        if right == wrong:
            continue
        if count / total < 0.9:
            conflicts += 1
            continue
        table[wrong] = right
    # 干净字体里出现过的字一律不替换：它可能本来就是正文用字。
    for font, chars in clean_by_font.items():
        if font in broken:
            continue
        for ch in chars:
            table.pop(ch, None)
    stats = {
        "fonts_broken": sorted(broken),
        "repair_pairs": len(table),
        "conflicts": conflicts,
        "traced_fonts": len(font_quality),
    }
    return table, stats


CJK_PAIR = re.compile(r"^[\u4e00-\u9fa5]{2}$")


def repair_score(
    raw: str, repaired: str, reference: dict[str, int]
) -> tuple[float, float]:
    raw_score = rep_score = 0.0
    for index, (before, after) in enumerate(zip(raw, repaired)):
        if before == after:
            continue
        for start in (index - 1, index):
            if start < 0 or start + 2 > len(raw):
                continue
            left = raw[start : start + 2]
            right = repaired[start : start + 2]
            if CJK_PAIR.match(left) and CJK_PAIR.match(right):
                raw_score += math.log1p(reference.get(left, 0))
                rep_score += math.log1p(reference.get(right, 0))
    return raw_score, rep_score


def extract_text(path: Path) -> tuple[str, dict]:
    doc = pymupdf.open(path)
    table, stats = build_repair_table(doc)
    raw = "\n".join(page.get_text("text") for page in doc)
    repaired = "".join(table.get(ch, ch) for ch in raw)
    candidates = sum(1 for ch in raw if table.get(ch, ch) != ch)
    reference = load_reference()
    if not candidates:
        mode, delta = "clean", 0.0
    elif reference:
        raw_score, rep_score = repair_score(raw, repaired, reference)
        mode = "repaired" if rep_score > raw_score else "raw"
        delta = round(rep_score - raw_score, 1)
    else:
        mode, delta = "unscored", None
    use_repaired = mode in ("repaired", "unscored")
    text = repaired if use_repaired else raw
    applied = candidates if use_repaired else 0
    pages = doc.page_count
    doc.close()
    residual = sum(text.count(ch) for ch in MOJIBAKE_MARKERS)
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fa5")
    stats.update(
        pages=pages,
        chars=len(text),
        cjk_ratio=round(cjk / max(1, len(text)), 3),
        applied=applied,
        substitutions=candidates,
        repair_mode=mode,
        repair_delta=delta,
        residual=residual,
        encoding=(
            "clean"
            if applied == 0
            else ("repaired" if residual <= 12 else "suspect")
        ),
    )
    return text, stats


def main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="D:/国内旅游攻略pdf")
    parser.add_argument("--out", default=".tmp/corpus-text")
    args = parser.parse_args(argv)
    root = Path(args.root)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for path in sorted(root.rglob("*.pdf")):
        text, stats = extract_text(path)
        rel = path.relative_to(root).as_posix()
        target = out / (rel.replace("/", "__") + ".txt")
        target.write_text(text, encoding="utf-8")
        rows.append(
            f"{rel}\t{stats['pages']}\t{stats['encoding']}\t"
            f"applied={stats['applied']}\tresidual={stats['residual']}\tcjk={stats['cjk_ratio']}"
        )
        print(rows[-1], file=sys.stderr)
    (out / "manifest.tsv").write_text("\n".join(rows), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))