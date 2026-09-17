#!/usr/bin/env python3
"""notes 规范检查器。

遍历 notes/ 下全部笔记，按 notes/README.md 的规范体检：
  - 章节标题白名单：`##` 只允许三段（现状 / 本文档不包括什么 / 决策记录），`###` 可在三段内分节，多余 `##` 或顺序不符即非法
  - 子标题（`###` 及更深）同一父节下不得重名（按完整路径判重；不同父节下的同名子节合法）
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
# 允许的章节标题（白名单）：规范只定义这三段，其余标题一律视为非法
ALLOWED_SECTIONS = ("现状", "本文档不包括什么", "决策记录")
# 代码围栏（标题 / 章节统计需跳过其中的 `#` 行）
_FENCE_RE = re.compile(r"^\s*(```|~~~)")


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

    # 标题：首个非空行、唯一 H1、非空、单行、≤30 字
    lines = md.splitlines()
    h1s, in_fence = [], False
    for ln in lines:
        if _FENCE_RE.match(ln):
            in_fence = not in_fence
            continue
        if not in_fence and re.match(r"^#\s", ln):
            h1s.append(ln)

    first = next((ln for ln in lines if ln.strip()), "")
    if not h1s:
        errors.append("缺 # 标题")
    elif not re.match(r"^#\s+\S", first):
        errors.append(f"标题须为文件首个非空行（当前首行：{first.strip()[:24]!r}）")
    if len(h1s) > 1:
        errors.append(f"H1 标题不唯一（{len(h1s)} 个）：{[h.strip()[:20] for h in h1s[1:]]}")

    if h1s:
        title = h1s[0][1:].strip()
        n = count_chars(title)
        if n == 0:
            errors.append("标题为空")
        elif n > 30:
            errors.append(f"标题超 30 字：{n}")

    # 一句话
    m = re.search(r"^>\s*一句话[:：]\s*(.+)", md, re.M)
    if not m:
        errors.append("缺『一句话』行")
    else:
        n = count_chars(m.group(1))
        if n > 50:
            errors.append(f"一句话超 50 字：{n}")

    # 章节标题白名单：规范只允许三段，任何其它 ## / ### 标题都非法
    heads: list[tuple[int, int, str]] = []  # (行号, 级别, 文本)
    in_fence = False
    for i, ln in enumerate(lines, 1):
        if _FENCE_RE.match(ln):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = re.match(r"^(#{2,6})\s+(.*?)\s*$", ln)
        if m:
            heads.append((i, len(m.group(1)), m.group(2)))

    # `##` 层只允许白名单三段；`###` 及更深允许，但必须落在三段之内
    cur_h2: str | None = None
    for i, lvl, txt in heads:
        if lvl == 2:
            cur_h2 = txt
            if txt not in ALLOWED_SECTIONS:
                errors.append(f"非法标题（第 {i} 行）：## {txt}")
        elif cur_h2 is None:
            errors.append(f"非法标题（第 {i} 行，三段之外）：{'#' * lvl} {txt}")

    # 子标题（### 及更深）不得重名：按「完整路径」判，不同父节下的同名子节合法
    # （如「现状 / 单测 / 命令」与「现状 / 端测 / 命令」是两个不同的节）
    seen_sub: dict[tuple[str, ...], int] = {}
    ancestors: dict[int, str] = {}  # 级别 -> 该级别当前生效的标题
    for i, lvl, txt in heads:
        path = tuple(ancestors.get(l, "") for l in range(2, lvl)) + (txt,)
        if lvl >= 3:
            if path in seen_sub:
                errors.append(
                    f"子标题重复（第 {i} 行，首次在第 {seen_sub[path]} 行）："
                    f"{'#' * lvl} {txt}（同属 {'/'.join(path[:-1]) or '（顶层）'}）"
                )
            else:
                seen_sub[path] = i
        for l in [l for l in ancestors if l >= lvl]:
            del ancestors[l]
        ancestors[lvl] = txt

    h2 = [txt for _, lvl, txt in heads if lvl == 2]
    for sec in ALLOWED_SECTIONS:
        c = h2.count(sec)
        if c == 0:
            errors.append(f"缺『## {sec}』段")
        elif c > 1:
            errors.append(f"『## {sec}』段重复 {c} 次")
    present = [s for s in h2 if s in ALLOWED_SECTIONS]
    if present != [s for s in ALLOWED_SECTIONS if s in present]:
        errors.append(f"三段顺序不符（应为 {' / '.join(ALLOWED_SECTIONS)}）")

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
