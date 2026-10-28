# -*- coding: utf-8 -*-
"""去掉重复插入的文件头块（只保留第一处），并复原到「每文件仅一个头」的状态。"""
import os
import sys

ROOT = "/Users/kxl/work/project/opensource/Claude-Code"
MARK = "【一句话定位】"


def dedupe(rel):
    path = os.path.join(ROOT, rel)
    lines = open(path, encoding="utf-8").read().split("\n")
    # 找出所有文件头块的起止行
    blocks = []
    i = 0
    while i < len(lines):
        if MARK in lines[i]:
            start = i
            while start > 0 and lines[start - 1].strip() in ("/**", " *", " */") or (
                start > 0 and lines[start - 1].strip().startswith(" *")
            ):
                start -= 1
            end = i
            while end < len(lines) and not lines[end].strip() == "*/":
                end += 1
            blocks.append((start, end))
            i = end + 1
        else:
            i += 1
    if len(blocks) <= 1:
        print("no-dupe %s (blocks=%d)" % (rel, len(blocks)))
        return 0
    # 保留第一块，删除其余
    drop = set()
    for b in blocks[1:]:
        for k in range(b[0], b[1] + 1):
            drop.add(k)
    out = [l for idx, l in enumerate(lines) if idx not in drop]
    open(path, "w", encoding="utf-8").write("\n".join(out))
    print("deduped %s removed=%d" % (rel, len(drop)))
    return 0


if __name__ == "__main__":
    rc = 0
    for r in sys.argv[1:]:
        rc |= dedupe(r)
    sys.exit(rc)
