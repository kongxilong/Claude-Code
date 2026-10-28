#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
纯新增行注释插入器。

用法: python3 insert.py spec.json

spec.json 结构:
{
  "file": "src/tools/BashTool/xxx.ts",
  "header": ["/**", " * ...", " */"],   # 可选，插入到顶部指令行之后
  "inserts": [
    {"anchor": "原文件中某一行的完整内容(用于定位)", "nth": 1, "after": false,
     "lines": ["// 中文注释1", "// 中文注释2"]}
  ]
}

规则:
1. 只做插入，绝不修改/删除任何原有行 -> git diff --numstat 删除数必为 0
2. 注释行自动继承 anchor 行的缩进
3. anchor 定位不到或不唯一时报错退出，不做任何写入
"""
import json
import os
import sys

ROOT = "/Users/kxl/work/project/opensource/Claude-Code"


def load(spec_path):
    with open(spec_path, encoding="utf-8") as f:
        return json.load(f)


def is_directive(line):
    s = line.strip()
    return (
        s.startswith("// biome-ignore")
        or s.startswith("/* eslint")
        or s.startswith("// eslint")
        or s.startswith("// @ts-")
        or s.startswith("#!")
        or s.startswith("// @vitest")
        or s.startswith("/* c8 ")
        or s.startswith("// prettier-ignore")
    )


def find_anchor(lines, anchor, nth):
    hits = [i for i, l in enumerate(lines) if l == anchor]
    if not hits:
        return None
    if len(hits) < nth:
        return None
    return hits[nth - 1]


def apply(spec):
    rel = spec["file"]
    path = os.path.join(ROOT, rel)
    with open(path, encoding="utf-8") as f:
        original = f.read()
    lines = original.split("\n")

    # 1) 文件头（幂等：已有中文头则跳过）
    header = spec.get("header") or []
    if header and not any("【一句话定位】" in l for l in lines[:200]):
        idx = 0
        while idx < len(lines) and (lines[idx].strip() == "" or is_directive(lines[idx])):
            idx += 1
        # 越过连续的顶部指令块，停在第一条真正的代码行之前
        lines[idx:idx] = list(header)

    # 2) 逐条插入（anchor 用原始内容定位，插入后行号会变，故按顺序重定位）
    errors = []
    for ins in spec.get("inserts", []):
        anchor = ins["anchor"]
        nth = ins.get("nth", 1)
        after = ins.get("after", False)
        pos = find_anchor(lines, anchor, nth)
        if pos is None:
            errors.append("anchor 未找到(或不唯一到第 %d 次出现): %r" % (nth, anchor[:90]))
            continue
        indent = anchor[: len(anchor) - len(anchor.lstrip())]
        block = [indent + l if l.strip() else "" for l in ins["lines"]]
        target = pos + 1 if after else pos
        # 幂等：若这段注释已经在目标位置存在，则跳过
        existing = lines[target : target + len(block)]
        if existing == block:
            continue
        lines[target:target] = block

    if errors:
        print("FAILED %s" % rel)
        for e in errors:
            print("  - " + e)
        return 1

    new = "\n".join(lines)
    # 自检：原有内容必须是新内容的「删掉若干整行后的子序列」
    if not is_pure_insertion(original, new):
        print("FAILED %s : 检测到非纯新增改动，已回滚" % rel)
        return 1
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    print("OK %s" % rel)
    return 0


def is_pure_insertion(original, new):
    o = original.split("\n")
    n = new.split("\n")
    i = 0
    for line in n:
        if i < len(o) and o[i] == line:
            i += 1
    return i == len(o)


if __name__ == "__main__":
    specs = sys.argv[1:]
    rc = 0
    for s in specs:
        rc |= apply(load(s))
    sys.exit(rc)
