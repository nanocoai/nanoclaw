#!/usr/bin/env python3
"""按 09_manifest.json 给 08_定稿.md 机械施加行内样式,产 09_带样式.xml。

用法: python3 apply_format.py /tmp/prd_work/<slug>/
带 hash 保真门:剥掉本脚本加的标签+图例行后须与定稿逐字一致,否则 exit 2。
用色 ≥2 种时自动在首个标题行后插入图例块(唯一允许的正文差异)。
"""
import json
import os
import re
import sys

LOG_BANNER = "〔pm-lite 内部日志·供排错与续跑，非面向用户的内容〕"
# 块边界标签:上色文字若横跨这些标签,包出来的 <span> 会横跨单元格/块,飞书 v2 落档
# 把它当孤儿标签 unwrap 整表(实测复现)。故施加前拒绝跨块槽位。
BLOCK_BOUNDARY = re.compile(r"</?(?:td|tr|th|p|li|ul|ol|table|thead|tbody|grid|column|callout|quote_container)\b")

# TODO: 行内标签语法若与 lark-doc-xml 规范不符,校准 WRAP/LEGEND 两表即可,勿改施加逻辑
WRAP = {
    # 语法按本仓 dry-run 实测(lark-cli docs +create --doc-format xml 可吃;绿字见 dryrun_r3)
    # R3 色板:背景四类主力(淡色 light-*,大红大黄大绿可视化差)+红/绿字配对点标;蓝字/灰字/行内代码 类目已删(界面文案→「」,旁注→引用块,代码→反引号)
    "红字": ('<span text-color="red">', "</span>"),
    "绿字": ('<span text-color="green">', "</span>"),
    "黄底": ('<span background-color="light-yellow">', "</span>"),
    "蓝底": ('<span background-color="light-blue">', "</span>"),
    "红底": ('<span background-color="light-red">', "</span>"),
    "绿底": ('<span background-color="light-green">', "</span>"),
}
LEGEND = {
    # 语义与 prd-core.md「颜色与容器语义」逐字对齐(图例说谎=系统性误导读者)
    "红字": "红字=负向/禁止/无效状态点标",
    "绿字": "绿字=正向/有效状态点标",
    "黄底": "黄底=警告/风险/需注意",
    "蓝底": "蓝底=进行中",
    "绿底": "绿底=正向(经验/实验结论/正向块)",
    "红底": "红底=严重问题/硬约束/拦截项",
}
BLOCK_LEVEL = ("callout", "quote_container")  # 块级容器 S4 写作时已做,manifest 不该出现


def strip_styling(styled, legend_line=""):
    """剥掉本脚本施加的行内样式标签 + 自动图例行,还原到定稿文本。

    与 WRAP 同源(遍历 WRAP.values()),色板改动零漂移;空 legend 守卫防误删换行。
    lint.py 的 H17 定稿↔成品一致门 import 本函数,单源共用剥离逻辑。
    """
    s = styled.replace(legend_line + "\n", "", 1) if legend_line else styled
    for open_tag, _close in WRAP.values():
        s = s.replace(open_tag, "")
    return s.replace("</span>", "")


def find_nth(text, sub, n):
    pos = -1
    for _ in range(n):
        pos = text.find(sub, pos + 1)
        if pos < 0:
            return -1
    return pos


def main():
    if len(sys.argv) != 2:
        sys.exit("用法: python3 apply_format.py /tmp/prd_work/<slug>/")
    work = sys.argv[1]
    print(LOG_BANNER, file=sys.stderr)
    draft_p, mani_p = os.path.join(work, "08_定稿.md"), os.path.join(work, "09_manifest.json")
    for p, hint in ((draft_p, "先完成 S8 deslop"), (mani_p, "先完成 S9 格式标注")):
        if not os.path.isfile(p):
            sys.exit("缺 %s——%s" % (p, hint))
    original = open(draft_p, encoding="utf-8").read()
    try:
        mani = json.load(open(mani_p, encoding="utf-8"))
    except ValueError as e:
        sys.exit("09_manifest.json 解析失败:%s" % e)
    if not isinstance(mani.get("slots", []), list):
        sys.exit("09_manifest.json 的 slots 必须是列表")

    edits, errors, warnings = [], [], []
    for i, slot in enumerate(mani.get("slots", [])):
        cat, text = slot.get("category", ""), slot.get("text", "")
        raw_occ = slot.get("occurrence", 1)
        try:
            occ = int(raw_occ)
        except (TypeError, ValueError):
            errors.append("slot#%d(%s) occurrence 非法:%r(须正整数)" % (i, cat, raw_occ))
            continue
        if occ < 1:
            errors.append("slot#%d(%s) occurrence=%d 须 ≥1" % (i, cat, occ))
            continue
        if cat in BLOCK_LEVEL:
            warnings.append("slot#%d %s 属块级容器(S4 写作时已做),跳过" % (i, cat))
            continue
        if cat not in WRAP:
            errors.append("slot#%d 未知类别:%r" % (i, cat))
        elif not text:
            errors.append("slot#%d(%s) text 为空" % (i, cat))
        else:
            pos = find_nth(original, text, occ)
            if pos < 0:
                errors.append("slot#%d(%s) 第 %d 次出现找不到:%r" % (i, cat, occ, text[:40]))
            elif BLOCK_BOUNDARY.search(original[pos:pos + len(text)]):
                # 上色文字横跨单元格/块边界 → 包出跨格 <span>,飞书 v2 落档拆表(实测),拒绝
                errors.append("slot#%d(%s) text 横跨单元格/块边界(含 td/p/li 等标签),须拆到单块内上色:%r"
                              % (i, cat, text[:40]))
            else:
                edits.append((pos, pos + len(text), cat))

    edits.sort()
    accepted, last_end, counts = [], -1, {}
    for start, end, cat in edits:  # 区间重叠的后到者弃用,记 error
        if start < last_end:
            errors.append("槽位区间重叠,弃用:%s@%d" % (cat, start))
            continue
        accepted.append((start, end, cat))
        last_end = end
    styled = original
    for start, end, cat in reversed(accepted):  # 从后往前施加,偏移不漂
        o, c = WRAP[cat]
        styled = styled[:start] + o + styled[start:end] + c + styled[end:]
        counts[cat] = counts.get(cat, 0) + 1

    legend_line = ""
    color_cats = [c for c in WRAP if c in counts]
    if len(color_cats) >= 2:
        legend_line = "> 📖 图例:" + "、".join(LEGEND[c] for c in color_cats)
        lines = styled.splitlines(True)
        idx = next((k + 1 for k, l in enumerate(lines)
                    if l.lstrip().startswith("#") or l.lstrip().startswith("<title")),
                   next((k + 1 for k, l in enumerate(lines) if l.strip()), 0))
        lines.insert(idx, legend_line + "\n")
        styled = "".join(lines)

    # hash 保真门:剥掉本脚本添加的标签与图例行,与定稿逐字比对(定稿此前已文本冻结,不该含这些标签)
    # 剥离逻辑单源=strip_styling(lint.py H17 同源共用)
    stripped = strip_styling(styled, legend_line)
    if stripped != original:
        i = next((k for k, (a, b) in enumerate(zip(stripped, original)) if a != b),
                 min(len(stripped), len(original)))
        print("hash 保真门未过:首个差异在第 %d 字符,剥离后=%r vs 定稿=%r"
              % (i, stripped[i:i + 30], original[i:i + 30]))
        sys.exit(2)

    out_p = os.path.join(work, "09_带样式.xml")
    if not errors:  # 有施加错误不产出成品(防 gate 误推进;lint H8 双保险)
        open(out_p, "w", encoding="utf-8").write(styled)
        print("已写 %s" % out_p)
    else:
        if os.path.isfile(out_p):
            os.remove(out_p)  # 清掉旧产物,防 gate 按存在性误推进
        print("有施加错误,不写 09_带样式.xml(旧产物已清,修 manifest 后重跑)")
    print("各类计数:%s" % json.dumps(counts, ensure_ascii=False))
    print("图例:%s" % (legend_line or "未插入(用色<2 种)"))
    for w in warnings:
        print("warning: %s" % w)
    for e in errors:
        print("error: %s" % e)
    und = mani.get("undecided") or []
    if und:
        print("undecided 转发(%d 条,交 lint 报告):%s" % (len(und), json.dumps(und, ensure_ascii=False)))
    # 施加统计落盘供 lint H8 对账(各类成功计数 vs manifest 槽位数)
    stats = {"applied": counts, "slots": {}, "errors": len(errors), "legend": legend_line}
    for s in mani.get("slots", []):
        c = s.get("category")
        if c in WRAP:  # 块级(callout/quote_container)已 warning 跳过,不进对账
            stats["slots"][c] = stats["slots"].get(c, 0) + 1
    open(os.path.join(work, "09_apply_stats.json"), "w", encoding="utf-8").write(
        json.dumps(stats, ensure_ascii=False))
    if errors:
        print("✗ 有 %d 个槽位施加失败——修 manifest(text 须逐字/occurrence=全文第 N 次)后重跑" % len(errors))
        sys.exit(2)


if __name__ == "__main__":
    main()
