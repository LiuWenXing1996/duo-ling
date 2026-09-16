#!/usr/bin/env python3
"""提案流程体检：状态一致性 / 流转合法性 / 记录完整性。

只负责**报出不一致**，不负责判断该往哪边对齐——那要按提案内容由人决定。

规则见 docs/proposal-process.md。

用法:
    python3 scripts/check-proposals.py [--ideas]

检查项:
    1. 状态块缺失、取值非法、与所在目录不一致（不一致时由人按提案内容判断如何对齐）
    2. 缺「流转记录」章节，或一条记录都没有（提案创建时应记「新提案 → 草稿」）
    3. 流转记录里出现非法流转（如「实施中 → 评审中」）
    4. 最后一条流转的「到」与当前状态不符
    5. --ideas：列出想法箱（GitHub Issues 标签 idea）待办条目

退出码: 0 无问题, 1 有问题。只提醒，不阻断。
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROPOSALS = "docs/proposals"

# 目录 → 状态；不一致时只报出，由人按提案内容判断如何对齐
DIR_STATE = {
    "draft": "草稿",
    "review": "评审中",
    "implementing": "实施中",
    "done": "实施完成",
    "rejected": "拒绝",
}

# 合法流转（docs/proposal-process.md「提案状态」的流转图）
# 「新提案」是起点，只能作源：从 0 到 1 也是一次流转，故提案创建时第一条记录为「新提案 → 草稿」
ALLOWED = {
    ("新提案", "草稿"),
    ("草稿", "评审中"),
    ("草稿", "拒绝"),
    ("评审中", "草稿"),
    ("评审中", "实施中"),
    ("评审中", "拒绝"),
    ("实施中", "实施完成"),
}

TERMINAL = {"实施完成", "拒绝"}
STATES = set(DIR_STATE.values()) | {"新提案"}

STATE_BLOCK_RE = re.compile(r"^>\s*状态[:：]\s*(.+?)\s*$", re.M)
HEADING_RE = re.compile(r"^(#{1,6})\s*(.+?)\s*$", re.M)
ROW_RE = re.compile(r"^\|(.+)\|\s*$", re.M)
TRANS_RE = re.compile(r"(\S+?)\s*[-→>]{1,2}\s*(\S+)")


def clean(text: str) -> str:
    return text.replace("*", "").replace("`", "").strip()


def parse_state(text: str) -> str | None:
    m = STATE_BLOCK_RE.search(text)
    return clean(m.group(1)) if m else None


def section(text: str, name: str) -> str | None:
    """取某标题下的正文，直到下一个同级或更高级标题。"""
    for m in HEADING_RE.finditer(text):
        if name in clean(m.group(2)):
            level = len(m.group(1))
            start = m.end()
            for nxt in HEADING_RE.finditer(text, start):
                if len(nxt.group(1)) <= level:
                    return text[start : nxt.start()]
            return text[start:]
    return None


def parse_transitions(text: str) -> list[tuple[str, str]]:
    body = section(text, "流转记录")
    if not body:
        return []
    out = []
    for row in ROW_RE.finditer(body):
        cells = [clean(c) for c in row.group(1).split("|")]
        if len(cells) < 2:
            continue
        m = TRANS_RE.search(cells[1])
        if m and m.group(1) in STATES and m.group(2) in STATES:
            out.append((m.group(1), m.group(2)))
    return out


def check_exemptions() -> int:
    """豁免清单：条目数到 10 条提醒复核（docs/proposal-process.md「豁免清单」）。"""
    path = ROOT / "docs" / "proposal-process.md"
    if not path.is_file():
        return 0
    body = section(path.read_text(encoding="utf-8"), "豁免清单")
    if not body:
        return 0
    rows = []
    for row in ROW_RE.finditer(body):
        cells = [clean(c) for c in row.group(1).split("|")]
        if len(cells) < 4:
            continue
        head = cells[0]
        if head in ("日期", "") or re.fullmatch(r"[:\-\s]+", head):
            continue
        if "暂无" in "".join(cells):
            continue
        rows.append(cells)
    if rows:
        print(f"\n豁免清单（{len(rows)}）")
        for cells in rows:
            print(f"  · {cells[0]} {cells[1]} —— {cells[2]}")
    if len(rows) >= 10:
        print("  ! 攒到 10 条了，该复核一遍：有没有被用成万能口子的条目")
        return 1
    return 0


def list_ideas() -> None:
    try:
        out = subprocess.run(
            ["gh", "issue", "list", "--label", "idea", "--state", "open",
             "--json", "number,title", "--limit", "50"],
            cwd=ROOT, capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError):
        print("\n想法箱：跳过（gh 不可用）")
        return
    if out.returncode != 0:
        print("\n想法箱：跳过（gh 未登录或无网络）")
        return
    issues = json.loads(out.stdout or "[]")
    print(f"\n想法箱待办（{len(issues)}）")
    for i in issues:
        print(f"  · #{i['number']} {i['title']}")
    if not issues:
        print("  （无）")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ideas", action="store_true", help="附带列出 GitHub 想法箱待办")
    args = ap.parse_args()

    base = ROOT / PROPOSALS
    if not base.is_dir():
        print(f"{PROPOSALS}/ 不存在，无提案可查")
        if args.ideas:
            list_ideas()
        return 0

    problems = 0
    files = sorted(p for p in base.rglob("*.md"))
    print(f"提案（{len(files)}）")

    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        parts = path.relative_to(base).parts
        dir_state = DIR_STATE.get(parts[0]) if len(parts) > 1 else None
        text = path.read_text(encoding="utf-8")
        doc_state = parse_state(text)
        flags: list[str] = []

        if dir_state is None:
            flags.append(f"不在状态目录里（应为 {'/'.join(DIR_STATE)}）")
        elif doc_state is None:
            flags.append("缺状态块")
        elif doc_state != dir_state:
            flags.append(f"状态块「{doc_state}」与目录「{dir_state}」不一致（由人按提案内容判断如何对齐）")

        trans = parse_transitions(text)
        if not trans:
            flags.append("缺流转记录")
        else:
            for src, dst in trans:
                if (src, dst) not in ALLOWED:
                    flags.append(f"非法流转：{src} → {dst}")
            last_dst = trans[-1][1]
            if dir_state and last_dst != dir_state:
                flags.append(f"最后一条流转到「{last_dst}」，但当前是「{dir_state}」")
            if dir_state in TERMINAL and last_dst != dir_state:
                flags.append("终态提案的流转记录未收尾")

        if flags:
            problems += len(flags)
            print(f"  · {rel}")
            for f in flags:
                print(f"      - {f}")
        else:
            print(f"  · {rel}  [{dir_state}]")

    if not files:
        print("  （无）")

    problems += check_exemptions()

    if args.ideas:
        list_ideas()

    print()
    if problems:
        print(f"{problems} 项待处理 —— 规则见 docs/proposal-process.md")
        return 1
    print("提案流程体检通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
