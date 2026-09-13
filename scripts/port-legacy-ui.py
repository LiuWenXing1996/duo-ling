#!/usr/bin/env python3
"""平移脚本：把 legacy 渲染层的 UI 依赖闭包复制到扩展 src/，并修正跨目录引用。

只平闭包内文件（而非整个 components/），避免引入依赖未安装的组件（vue-flow / rive / media-chrome 等）。

ENTRIES 覆盖两个载体：
  - side panel（对话入口）：ChatPanel / SessionHistoryPanel / ModelFormDialog
  - workbench 标签页（工作台）：ToolWorkspace —— 其内部再引入 HomePanel / SettingsPanel /
    DeveloperPanel / UiTestPanel / WorkspaceTabs / Tool* 系列与 types/{tool,tab,model}、lib/*

⚠️ 闭包是按 **legacy 源码**的 import 关系算的，因此「本地已替换/改过」的文件会再被覆盖回来：
  - 会被覆盖后需人工恢复（改过）：`composables/use-global-conversation.ts`、`components/ai-elements/shimmer/Shimmer.vue`
  - 已在 DROP_AFTER_COPY 里（重跑后自动删除）：`lib/custom-chat-transport.ts`（扩展侧已由 extension-chat-transport 取代）
  重跑前先备份上述文件；重跑后核对 `git status`。
用完即删。
"""
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.normpath(os.path.join(HERE, ".."))
SRC = os.path.join(PROJ, "legacy", "src", "renderer", "src")
SRC_PARENT = os.path.dirname(os.path.dirname(SRC))
DST = os.path.join(PROJ, "src")

ENTRIES = [
    # —— side panel（AI 对话入口）——
    "components/ChatPanel.vue",
    "components/SessionHistoryPanel.vue",
    "components/ModelFormDialog.vue",
    # —— workbench 标签页（工作台）：ToolWorkspace 会自行引入其余工作台组件 ——
    "components/ToolWorkspace.vue",
]

# 闭包会带进来、但扩展侧已另有实现（或不需要）的文件，复制后删除。
# 不删的话它们会留在 src 里当死代码 —— 例如 Electron 时代的 transport 会被误当成在用实现。
DROP_AFTER_COPY = [
    "lib/custom-chat-transport.ts",
]

IMPORT_RE = re.compile(r"""^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]""", re.M)
BARE_IMPORT_RE = re.compile(r"""^\s*import\s+['"]([^'"]+)['"]""", re.M)
SHARED_REF_RE = re.compile(r"""(['"])(?:\.\./)+shared/""")
TEXT_EXT = {".vue", ".ts", ".js", ".css", ".less", ".json"}


def resolve(spec, current_dir):
    if spec.startswith("@/"):
        base = os.path.join(SRC, spec[2:])
    elif spec.startswith("."):
        base = os.path.normpath(os.path.join(current_dir, spec))
    else:
        return None
    for c in [base, base + ".ts", base + ".vue", base + ".js",
              os.path.join(base, "index.ts"), os.path.join(base, "index.vue")]:
        if os.path.isfile(c):
            return os.path.normpath(c)
    return None


def dest_for(path):
    """源码绝对路径 -> 扩展侧目标绝对路径。"""
    rel = os.path.relpath(path, SRC)
    if rel.startswith(".."):
        rel = os.path.relpath(path, SRC_PARENT)
    return os.path.join(DST, rel)


def collect():
    seen, stack = set(), [os.path.join(SRC, e) for e in ENTRIES]
    missing, externals = set(), set()
    while stack:
        path = stack.pop()
        if path in seen or not os.path.isfile(path):
            continue
        seen.add(path)
        src = open(path, encoding="utf-8").read()
        for spec in IMPORT_RE.findall(src) + BARE_IMPORT_RE.findall(src):
            target = resolve(spec, os.path.dirname(path))
            if target:
                if target not in seen:
                    stack.append(target)
            elif not spec.startswith(".") and not spec.startswith("@/"):
                externals.add(spec.split("/")[0] if not spec.startswith("@")
                              else "/".join(spec.split("/")[:2]))
            else:
                missing.add((os.path.relpath(path, SRC), spec))
    return sorted(seen), missing, externals


def main():
    dry = "--dry" in sys.argv
    files, missing, externals = collect()

    print(f"闭包文件 {len(files)} 个，外部依赖 {len(externals)} 个")
    if missing:
        print(f"\n未解析引用 {len(missing)} 条：")
        for f, s in sorted(missing):
            print(f"  {f} -> {s}")

    copied = patched = 0
    by_dir = {}
    for path in files:
        dst = dest_for(path)
        rel = os.path.relpath(dst, DST)
        top = rel.split(os.sep)[0]
        by_dir[top] = by_dir.get(top, 0) + 1
        if dry:
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        for root, _dirs, names in [(SRC, None, None)]:
            pass
        shutil.copy2(path, dst)
        copied += 1
        if os.path.splitext(dst)[1] in TEXT_EXT:
            text = open(dst, encoding="utf-8").read()
            new = SHARED_REF_RE.sub(r"\1@/shared/", text)
            if new != text:
                open(dst, "w", encoding="utf-8").write(new)
                patched += 1

    print("\n目标落点分布：")
    for k, v in sorted(by_dir.items()):
        print(f"  src/{k}/  {v} 个")
    if not dry:
        print(f"\n已复制 {copied} 个文件，修正引用 {patched} 个")
        for rel in DROP_AFTER_COPY:
            victim = os.path.join(DST, rel)
            if os.path.isfile(victim):
                os.remove(victim)
                print(f"已删除（扩展侧另有实现）：src/{rel}")
        print("\n提醒：use-global-conversation.ts / Shimmer.vue 若改过，需从备份恢复。")


if __name__ == "__main__":
    main()
