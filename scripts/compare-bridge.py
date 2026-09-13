#!/usr/bin/env python3
"""按「同名函数体」比对扩展手写桥接层与 legacy 桌面版实现，只打印有差异的函数。

用途：手写的数据层最容易丢桌面版里的「回退 / 守卫 / 规范化」语义，
而这些不在类型里、只在函数体里。逐个函数 diff 是唯一可靠的查法。
"""
import re
import sys
import difflib
import os


def extract_functions(src: str) -> dict[str, str]:
    """提取顶层函数定义（function 声明 / const 箭头函数）的完整文本，含函数上的紧邻注释。"""
    out: dict[str, str] = {}
    lines = src.split('\n')
    # 记录每个函数定义行的起始（含前置注释块）
    starts = []
    for i, line in enumerate(lines):
        m = re.match(r'^(?:export\s+)?(?:async\s+)?function\s+(\w+)', line)
        m2 = re.match(r'^(?:export\s+)?const\s+(\w+)\s*[:=]', line)
        if m:
            starts.append((i, m.group(1)))
        elif m2 and ('(' in line or '=>' in line):
            starts.append((i, m2.group(1)))
    for idx, (i, name) in enumerate(starts):
        # 向上收纳紧邻的注释块（JSDoc / // 连续行），但不超过上一个函数的结尾
        j = i
        limit = starts[idx - 1][0] if idx > 0 else 0
        while j - 1 >= limit and (lines[j - 1].strip().startswith('*') or lines[j - 1].strip().startswith('/*')
                                  or lines[j - 1].strip().startswith('//') or lines[j - 1].strip().startswith('*/')):
            j -= 1
        end = starts[idx + 1][0] if idx + 1 < len(starts) else len(lines)
        body = '\n'.join(lines[j:end]).rstrip()
        if name not in out:
            out[name] = body
    return out


def normalize(body: str) -> list[str]:
    """归一化：丢掉与语义无关的噪声行，便于 diff 聚焦行为差异。"""
    keep = []
    for line in body.split('\n'):
        s = line.rstrip()
        if re.match(r'^\s*(\*|/\*|//)', s):  # 注释
            continue
        keep.append(s)
    return keep


def main() -> None:
    if len(sys.argv) < 3:
        print('用法: compare-bridge.py <扩展文件> <legacy文件>')
        raise SystemExit(2)
    a_path, b_path = sys.argv[1], sys.argv[2]
    a_src = open(a_path, encoding='utf-8').read()
    b_src = open(b_path, encoding='utf-8').read()
    A, B = extract_functions(a_src), extract_functions(b_src)

    print(f'### {a_path}')
    print(f'    vs {b_path}')
    print(f'    同名函数 {len(set(A) & set(B))} 个；扩展独有 {len(set(A) - set(B))}；legacy 独有 {len(set(B) - set(A))}')
    only_legacy = sorted(set(B) - set(A))
    if only_legacy:
        print(f'    legacy 独有（可能是未平移的功能，非必然问题）: {only_legacy}')
    print()

    for name in sorted(set(A) & set(B)):
        ca, cb = normalize(A[name]), normalize(B[name])
        if ca == cb:
            continue
        ratio = difflib.SequenceMatcher(None, ca, cb).ratio()
        print(f'--- {name}  (相似度 {ratio:.2f}) ' + '-' * 30)
        for line in difflib.unified_diff(cb, ca, fromfile=f'legacy:{name}', tofile=f'ext:{name}', lineterm='', n=2):
            if line.startswith(('---', '+++')):
                continue
            print('   ' + line)
        print()


if __name__ == '__main__':
    main()
