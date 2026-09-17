#!/usr/bin/env python3
"""notes 规范检查器。

遍历 notes/ 下全部笔记，按 notes/README.md 的规范体检：
  - 结构三段齐全（现状 / 本文档不包括什么 / 决策记录）
  - 标题 ≤30 字、一句话 ≤50 字
  - 现状 ≤1500 字（清单或段落皆可）
  - 「本文档不包括什么」必须为清单式，每条「事 ≤100 字：理由 ≤100 字」
  - 决策记录：决策点 / 结论 / 依据各 ≤100 字，决策时间格式合法（可空）

纯标准库，无第三方依赖。全部通过退出码 0，有偏离退出码 1。
（决策记录「只增不减」为变更纪律，需比对历史，脚本不校验。）
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

NOTES_DIR = Path(__file__).resolve().parent
EXCLUDE_FILES = {"README.md", "INDEX.md"}  # 体系规范与总索引，非笔记

# 统计「字」：CJK + 全角标点 + ASCII 字母数字（粗略等价中文语境的「字」）
_CHAR_RE = re.compile(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffefA-Za-z0-9]")
# 决策时间格式：YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS，可空
_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$")


def count_chars(text: str) -> int:
    return len(_CHAR_RE.findall(text))


def section_text(md: str, header: str) -> str | None:
    """取 `## <header>` 到下一个同级 `##` 之间的正文（不含标题行）。"""
    lines = md.splitlines()
    out, capture = [], False
    for ln in lines:
        if re.match(r"^##\s+", ln):
            if capture:
                break
            if ln.strip() == f"## {header}":
                capture = True
        elif capture:
            out.append(ln)
    return "\n".join(out) if capture else None


def check_note(path: Path) -> list[str]:
    errors: list[str] = []
    md = path.read_text(encoding="utf-8")

    # 标题
    m = re.search(r"^#\s+(.+)", md, re.M)
    if not m:
        errors.append("缺 # 标题")
    else:
        n = count_chars(m.group(1))
        if n > 30:
            errors.append(f"标题超 30 字：{n}")

    # 一句话
    m = re.search(r"^>\s*一句话[:：]\s*(.+)", md, re.M)
    if not m:
        errors.append("缺『一句话』行")
    else:
        n = count_chars(m.group(1))
        if n > 50:
            errors.append(f"一句话超 50 字：{n}")

    # 三段齐全
    for sec in ("现状", "本文档不包括什么", "决策记录"):
        if section_text(md, sec) is None:
            errors.append(f"缺『## {sec}』段")

    # 现状字数
    st = section_text(md, "现状")
    if st is not None:
        n = count_chars(st)
        if n > 1500:
            errors.append(f"现状超 1500 字：{n}")

    # 本文档不包括什么：清单式 + 每条 事≤100 : 理由≤100
    nd = section_text(md, "本文档不包括什么")
    if nd is not None:
        items = [ln for ln in nd.splitlines() if ln.strip().startswith("- ")]
        if not items:
            errors.append("『本文档不包括什么』非清单式（无 - 条目）")
        for it in items:
            body = it.strip()[2:].strip()
            if (":" not in body) and ("：" not in body):
                errors.append(f"『不包括』条缺理由冒号：{body[:18]}…")
                continue
            thing, reason = re.split(r"[:：]", body, maxsplit=1)
            if count_chars(thing) > 100:
                errors.append(f"『不包括』事超 100 字：{thing[:18]}…")
            if count_chars(reason) > 100:
                errors.append(f"『不包括』理由超 100 字：{reason[:18]}…")

    # 决策记录表：决策点/结论/依据各 ≤100；时间格式合法（可空）
    dr = section_text(md, "决策记录")
    if dr is not None:
        for ln in dr.splitlines():
            if not ln.strip().startswith("|"):
                continue
            if re.match(r"^\s*\|\s*-+", ln):  # 分隔行
                continue
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            if "决策点" in cells or "决策时间" in cells:  # 表头行，跳过
                continue
            # cells: 决策时间, 决策点, 结论, 依据
            for idx, name in ((1, "决策点"), (2, "结论"), (3, "依据")):
                if idx < len(cells) and count_chars(cells[idx]) > 100:
                    errors.append(f"决策记录{name}超 100 字")
            if cells and cells[0].strip() and not _TIME_RE.match(cells[0].strip()):
                errors.append(f"决策时间格式异常：{cells[0]}")

    return errors


def main() -> int:
    notes = sorted(
        p for p in NOTES_DIR.rglob("*.md") if p.name not in EXCLUDE_FILES
    )
    total = 0
    for p in notes:
        rel = p.relative_to(NOTES_DIR)
        errs = check_note(p)
        if errs:
            total += len(errs)
            print(f"[FAIL] {rel}")
            for e in errs:
                print(f"    - {e}")
        else:
            print(f"[OK]   {rel}")
    print(f"\n共检查 {len(notes)} 篇，{total} 处偏离")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
