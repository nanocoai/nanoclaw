#!/usr/bin/env python3
"""从源文档 `+fetch --format json` 输出机械提取图片清单，产 02_图清单.json。

用法：lark-cli docs +fetch --format json --doc <src> | python3 extract_source_images.py /tmp/prd_work/<slug>/

产物：
- <work>/02_图清单.json = {"source_img_count": N, "images": [{"n":1, "caption":"…"}, …]}
  （source_img_count 机械计数——是 lint H-IMG 判"图有没有全带/丢图有没有逐图声明"的真源，模型改不了）
- /tmp/img_hrefs.txt = 每行「N\t<href>」供 S10 回填 __IMG_N__（不打印、不进上下文）
- stdout 只打「序号: caption」给模型看（照图片穿透节既有约定）

无三方依赖（json/re/sys）；源无图 → count=0 仍产文件（gate 据此放行、H-IMG 跳过）。
"""
import json
import os
import re
import sys

LOG_BANNER = "〔pm-lite 内部日志·供排错与续跑，非面向用户的内容〕"
IMG_RE = re.compile(r"<img\b[^>]*>", re.I)
ATTR = lambda tag, name: (re.search(r'(?<![\w-])%s="([^"]*)"' % name, tag) or [None, ""])[1]


def _content(raw):
    """从 stdin 提取文档正文 xml：容忍前置 warning 行、容忍非标准结构。"""
    s = raw.lstrip()
    i = s.find("{")
    if i >= 0:
        try:
            data = json.loads(s[i:])
            c = (data.get("document") or {}).get("content")
            if isinstance(c, str) and c:
                return c
        except ValueError:
            pass
    return raw  # 解析失败/无 content → 拿整段当正文兜底（仍能数 <img>）


def main():
    if len(sys.argv) != 2:
        sys.exit("用法: ... | python3 extract_source_images.py /tmp/prd_work/<slug>/")
    work = sys.argv[1]
    print(LOG_BANNER, file=sys.stderr)
    if not os.path.isdir(work):
        sys.exit("工作目录不存在:%s" % work)

    content = _content(sys.stdin.read())
    tags = IMG_RE.findall(content)

    images, href_lines = [], []
    for n, tag in enumerate(tags, 1):
        cap = ATTR(tag, "alt") or ATTR(tag, "name") or ""
        href = ATTR(tag, "href") or ATTR(tag, "src") or ""
        images.append({"n": n, "caption": cap[:200]})
        href_lines.append("%d\t%s" % (n, href))

    out = {"source_img_count": len(images), "images": images}
    open(os.path.join(work, "02_图清单.json"), "w", encoding="utf-8").write(
        json.dumps(out, ensure_ascii=False, indent=2))
    if href_lines:
        open("/tmp/img_hrefs.txt", "w", encoding="utf-8").write("\n".join(href_lines) + "\n")

    print("源文档图片 %d 张：" % len(images))
    for im in images:
        print("%d: %s" % (im["n"], im["caption"] or "(无 caption)"))
    if not images:
        print("（源文档无图，02_图清单.json 记 count=0）")


if __name__ == "__main__":
    main()
