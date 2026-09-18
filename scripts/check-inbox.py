#!/usr/bin/env python3
"""想法收件箱体检：条目字数 / 文件总字数 / 不办理由 / 疑似重复。

只负责**报出越界**，不负责判断条目该留还是该删——那要按条目内容由人决定。

规则见 docs/inbox.md 开头。

用法:
    python3 scripts/check-inbox.py [文件]

    不带参数时查 docs/inbox.md；传 [文件] 是为了拿别处的样例练手 / 验脚本自身，
    日常就是 `npm run check:inbox`。

检查项：
    1. 「待办」「不办」分区下的条目 >100 字
    2. docs/inbox.md 总字数 >6000（软上限，见 notes/README.md）
    3. 「不办」条目缺「理由：」前缀——`理由:` 半角也算，但必须写在本条目内部
    4. 疑似重复条目：去掉标点与空白后，两条相同或互为子串

解析口径（inbox 会长歪，这几条是踩出来的）：
    - 代码块围栏（``` / ~~~）里的假列表项不算条目——顶部贴格式示例时最高危
    - 围栏到文件尾还没闭合会让后面的真条目全被吞：这时报「未闭合」后停止四项检查，
      不打印那些明摆着是残缺的结论（它本来会把存在的 `## 不办` 误报成「缺分区」）
    - `<!-- -->` 注释先剥掉，注释里的假条目不算
    - 嵌套列表只认缩进 0 的 `-` / `*` / `- [ ]`，缩进项并入上一条一起计字
      否则把长条目换行写就永远查不出超字数
    - 分区标题**精确匹配** `## 待办` / `## 不办`，模糊匹配会让 `## 待办` 吃掉 `## 待办事项`
    - 文件不存在算无 inbox 可查，退 0；分区缺失是结构错，退 1

退出码: 0 无问题, 1 有问题。只提醒，不阻断。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = "docs/inbox.md"

ITEM_MAX = 100
TOTAL_MAX = 6000
SECTIONS = ("待办", "不办")

HEADING_RE = re.compile(r"^(#{1,6})\s+(\S.*?)\s*$")
ITEM_RE = re.compile(r"^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
REASON_RE = re.compile(r"理由[:：]")

# 计字：CJK 一字一格；英文按连续串（单词 / 数字 / URL）整体算一字；标点一字一格；空白不计
CJK_RE = re.compile(r"[\u4e00-\u9fff]")
TOKEN_RE = re.compile(r"[^\s\u4e00-\u9fff]+")
ALNUM_RE = re.compile(r"[0-9A-Za-z]")

# 重复判定：去掉标点与空白后比对
NONWORD_RE = re.compile(r"[^\w\u4e00-\u9fff]")

CODE_RE = re.compile(r"`([^`]*)`")
LINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
COMMENT_ONE_RE = re.compile(r"<!--.*?-->")
COMMENT_OPEN = "<!--"
COMMENT_CLOSE = "-->"


def rel(path: Path) -> str:
    """输出用路径：能相对到仓库根就相对，否则只剩文件名——绝不打印绝对路径。"""
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.name


def strip_inline(text: str) -> str:
    """脱行内标记：反引号取内容、链接取标题、去强调与删除线、去首尾空白。"""
    text = CODE_RE.sub(r"\1", text)
    text = LINK_RE.sub(r"\1", text)
    text = text.replace("~~", "").replace("*", "")
    return text.strip()


def count_words(text: str) -> int:
    """条目字数与文件总字数共用一个口径，否则「100」和「6000」是两种字。"""
    s = strip_inline(text)
    total = len(CJK_RE.findall(s))
    for token in TOKEN_RE.findall(s):
        # 含字母数字的连续串（英文单词 / 数字 / URL）整体算 1 字，纯标点串逐字算
        total += 1 if ALNUM_RE.search(token) else len(token)
    return total


def norm(text: str) -> str:
    """重复判定用的归一：脱标记 + 去标点空白 + 统一小写。"""
    return NONWORD_RE.sub("", strip_inline(text)).lower()


def strip_comments(lines: list[str]) -> list[str]:
    """剥掉 HTML 注释占位，**保留行号不变**——报错要给得准行号。"""
    out: list[str] = []
    in_comment = False
    for line in lines:
        if in_comment:
            if COMMENT_CLOSE in line:
                in_comment = False
                out.append(line.split(COMMENT_CLOSE, 1)[1])
            else:
                out.append("")
            continue
        if COMMENT_OPEN in line:
            head, sep, tail = line.partition(COMMENT_OPEN)
            if COMMENT_CLOSE in tail:
                out.append(head + COMMENT_ONE_RE.sub("", tail))
            else:
                out.append(head)
                in_comment = True
            continue
        out.append(line)
    return out


def code_flags(lines: list[str]) -> tuple[list[bool], int | None]:
    """逐行维护围栏开关：True 表示该行在代码块里，不当正文看。

    顺带返回到文件尾仍未闭合的围栏起始行号（正常闭合则 None）——未闭合会把后面的
    真条目全吞掉，这是脚本自己的解析事故，得报给人，不能闷着。
    """
    flags = [False] * len(lines)
    fence = ""
    start = 0
    for i, line in enumerate(lines):
        m = FENCE_RE.match(line)
        if not fence:
            if m:
                fence = m.group(1)
                start = i + 1
                flags[i] = True
            continue
        flags[i] = True
        if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence):
            fence = ""
            start = 0
    return flags, start or None


def find_sections(lines: list[str], flags: list[bool]) -> dict[str, tuple[int, int]]:
    """精确匹配 `## 待办` / `## 不办`，返回 [起行, 止行) 区间。"""
    spans: dict[str, tuple[int, int]] = {}
    for i, line in enumerate(lines):
        if flags[i]:
            continue
        m = HEADING_RE.match(line)
        if not m or len(m.group(1)) != 2:
            continue
        title = strip_inline(m.group(2))
        if title not in SECTIONS or title in spans:
            continue
        end = len(lines)
        for j in range(i + 1, len(lines)):
            if flags[j]:
                continue
            nxt = HEADING_RE.match(lines[j])
            if nxt and len(nxt.group(1)) <= 2:
                end = j
                break
        spans[title] = (i + 1, end)
    return spans


def collect_items(lines: list[str], flags: list[bool], span: tuple[int, int]) -> list[tuple[int, str]]:
    """取分区下的顶层条目，返回 [(行号, 条目全文)]——缩进续写已并入。"""
    items: list[tuple[int, list[str]]] = []
    cur: tuple[int, list[str]] | None = None
    for i in range(span[0], span[1]):
        if flags[i]:
            continue
        line = lines[i]
        m = ITEM_RE.match(line)
        if m:
            if cur:
                items.append(cur)
            cur = (i + 1, [m.group(1)])
            continue
        if cur is None:
            continue
        if not line.strip():
            continue
        if HEADING_RE.match(line):  # 下级标题是分界线，不并入上一条
            items.append(cur)
            cur = None
            continue
        cur[1].append(line.strip())
    if cur:
        items.append(cur)
    return [(no, " ".join(parts)) for no, parts in items]


def brief(text: str, n: int = 30) -> str:
    s = strip_inline(text)
    return s if len(s) <= n else s[:n] + "…"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?", help=f"待查文件，默认 {TARGET}")
    args = ap.parse_args()

    path = ROOT / TARGET if not args.file else Path(args.file).expanduser()
    display = rel(path)
    if not path.is_file():
        print(f"{display} 不存在，无 inbox 可查")
        return 0

    lines = strip_comments(path.read_text(encoding="utf-8").splitlines())
    flags, open_fence = code_flags(lines)
    spans = find_sections(lines, flags)
    total = count_words("\n".join(lines))
    sections = {name: collect_items(lines, flags, spans[name]) for name in SECTIONS if name in spans}

    print(f"想法收件箱体检（{display}）")

    # 围栏没关时后面全是瞎的，此时还去报「缺分区」等于指着没病的地方开刀，故到此为止
    if open_fence is not None:
        print(f"\n代码块围栏未闭合，`{display}:{open_fence}` 之后的内容全部跳过")
        print("  后面的条目与分区都查不了，先把漏掉的收尾围栏补上再跑")
        print()
        return 1

    head = "，".join(f"{name} {len(items)} 条" for name, items in sections.items()) or "无分区"
    print(f"  {head}，全文 {total} 字（软上限 {TOTAL_MAX}）")

    problems = 0

    missing = [name for name in SECTIONS if name not in spans]
    if missing:
        problems += len(missing)
        print("\n缺分区（精确匹配 `## 待办` / `## 不办`）")
        for name in missing:
            print(f"  · {display}  缺 `## {name}`")

    long_items = [
        (name, no, count_words(text), text)
        for name, items in sections.items()
        for no, text in items
        if count_words(text) > ITEM_MAX
    ]
    if long_items:
        problems += len(long_items)
        print(f"\n超长条目（>{ITEM_MAX} 字）")
        for name, no, size, text in long_items:
            print(f"  · {display}:{no}  [{name}] {size} 字  {brief(text)}")

    no_reason = [
        (no, text) for no, text in sections.get("不办", []) if not REASON_RE.search(text)
    ]
    if no_reason:
        problems += len(no_reason)
        print("\n「不办」条目缺理由（要写「理由：」或「理由:」，半角冒号也算）")
        for no, text in no_reason:
            print(f"  · {display}:{no}  {brief(text)}")

    flat = [(name, no, text, norm(text)) for name, items in sections.items() for no, text in items]
    dupes = []
    for a in range(len(flat)):
        for b in range(a + 1, len(flat)):
            na, nb = flat[a][3], flat[b][3]
            if na and nb and (na == nb or na in nb or nb in na):
                dupes.append((flat[a], flat[b]))
    if dupes:
        problems += len(dupes)
        print("\n疑似重复条目（去标点空白后相同或互为子串）")
        for (name_a, no_a, text_a, _), (name_b, no_b, text_b, _) in dupes:
            print(f"  · {display}:{no_a} [{name_a}] 与 :{no_b} [{name_b}]  {brief(text_a)}")

    if total > TOTAL_MAX:
        problems += 1
        print(f"\n全文超软上限：{total} 字 > {TOTAL_MAX} 字")
        print("  按「清掉已了结的条目 → 合并重复条目 → 提额」的顺序处理，不直接提额")

    print()
    if problems:
        print(f"{problems} 项待处理 —— 规则见 {display} 开头")
        return 1
    print("想法收件箱体检通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
