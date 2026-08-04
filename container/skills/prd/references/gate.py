#!/usr/bin/env python3
"""PRD 流水线工序门禁:检查工作目录产物,报告当前该做哪道工序。

用法: python3 gate.py /tmp/prd_work/<slug>/
幂等:产物已存在且合格则跳过,中断后重跑即从断点续。
序列由 00_meta.json 的 mode/lite/static_change 决定,meta 是唯一权威。
"""
import json
import os
import sys

LOG_BANNER = "〔pm-lite 内部日志·供排错与续跑，非面向用户的内容〕"

STAGE_HINTS = {
    "S1": ("定性骨架", "判域/判 mode/裁章节/lite 判定,产 01+meta"),
    "S2": ("事实查证", "三标签底稿+触发判定表"),
    "S3": ("图与范围", "mermaid 图纸+分支总账+五章范围表"),
    "S3.5": ("骨架确认", "缺 03_骨架卡.md→按 prd-pipeline S3.5 卡写骨架卡(PRD章节缩略:一二三各一句/五摘五章表·六摘分支总账/待确认全列影响逻辑的点);骨架卡在→当消息发用户等聊天确认,答复记 03_方向确认.md(≥4行:答复原文/确认或调整点/时间/状态)再进 S4"),
    "S4": ("六章主体", "对分支总账逐条落 6.3,产六章主体+对账表"),
    "S5": ("边界收口", "按触发表写命中的条件章"),
    "S6": ("价值组装", "一~四章+头部表+版本表,组装全文草稿"),
    "S7": ("对抗自审", "铁律核查+对账核收,产合稿+待确认清单"),
    "S8": ("deslop", "四层去 AI 味,产文本冻结的定稿"),
    "S9": ("格式标注 manifest", "必答槽位 manifest,跑 apply_format.py 产带样式 XML"),
    "S10": ("lint+落档", "跑 lint.py,绿后一次 +create 落档并回读"),
}


def build_sequence(meta):
    """按 meta(mode/lite/static_change)生成期望产物序列 [(工序, [文件名])]。"""
    lite, rewrite = bool(meta.get("lite")), meta.get("mode") == "rewrite"
    s2 = ["02_原文留底.md", "02_事实底稿.md"] if rewrite else ["02_事实底稿.md"]
    # new 且有源文档 → 强制产 02_图清单.json(逼 S2 跑 extract_source_images.py，机械记源图数，
    # 是 H-IMG 图丢失门的唯一真源)；rewrite 走 append 原图留原档、H-IMG 豁免，故不强制(免产无门校验的清单)。
    if not rewrite and meta.get("source_doc_token"):
        s2 = s2 + ["02_图清单.json"]
    seq = [("S1", ["01_定位卡.md"]), ("S2", s2)]
    if not lite:
        seq.append(("S3", ["03_图纸.md", "03_分支总账.md", "03_五章表.md"]))
    elif not meta.get("static_change"):  # lite 只要图纸;纯静态变更(static_change)连图纸也免
        seq.append(("S3", ["03_图纸.md"]))
    # S3.5 骨架确认:写六章正文前先出骨架卡给用户拍板方向(只 new & not lite;
    # rewrite 本就 update 原文档、lite 太小,均免)。产物门=骨架卡+方向确认,gate 靠文件放行不死循环。
    if not lite and not rewrite:
        seq.append(("S3.5", ["03_骨架卡.md", "03_方向确认.md"]))
    seq.append(("S4", ["04_六章主体.md", "04_对账表.md"]))
    if not lite:
        seq.append(("S5", ["05_边界章节.md"]))
    seq += [("S6", ["06_全文草稿.md"]), ("S7", ["07_合稿.md", "07_待确认清单.md"]),
            ("S8", ["08_定稿.md"]), ("S9", ["09_manifest.json", "09_带样式.xml"]),
            ("S10", ["10_published.json"])]
    return seq


def check_file(path):
    """最小结构校验,返回 None(合格)或一句问题描述。"""
    if not os.path.isfile(path):
        return "缺失"
    try:
        text = open(path, encoding="utf-8").read()
    except (OSError, UnicodeDecodeError) as e:
        return "读取失败(%s)" % e
    if path.endswith(".md"):
        if len([l for l in text.splitlines() if l.strip()]) <= 3:
            return "内容过短(md 需非空且>3 行)"
    elif path.endswith(".json"):
        try:
            json.loads(text)
        except ValueError as e:
            return "JSON 解析失败(%s)" % e
    elif path.endswith(".xml") and "<" not in text:
        return "不含任何 XML 标签"
    return None


def main():
    if len(sys.argv) != 2:
        sys.exit("用法: python3 gate.py /tmp/prd_work/<slug>/")
    work = sys.argv[1]
    print(LOG_BANNER, file=sys.stderr)
    if not os.path.isdir(work):
        sys.exit("工作目录不存在:%s(先 mkdir -p,再写 00_meta.json)" % work)
    meta_path = os.path.join(work, "00_meta.json")
    if not os.path.isfile(meta_path):
        print("第一步:写 00_meta.json,字段 {run_id, source_doc_token, source_hash, domain, mode, lite}")
        return
    try:
        meta = json.load(open(meta_path, encoding="utf-8"))
    except ValueError as e:
        sys.exit("00_meta.json 解析失败:%s——先修好它再继续" % e)
    # meta 硬校验(枚举+必填):缺/非法=阻断(换 MRD 复用旧目录会在 source_hash 处暴露)
    errs = []
    for k in ("run_id", "source_doc_token", "source_hash", "domain", "mode"):
        val = meta.get(k)
        if not (isinstance(val, str) and val.strip()) and not isinstance(val, (int, float)):
            errs.append("字段 %s 缺失或为空" % k)
    if "lite" not in meta:
        errs.append("缺字段 lite")
    if str(meta.get("mode")) not in ("new", "rewrite"):
        errs.append("mode 须为 new|rewrite,现=%r" % meta.get("mode"))
    dstr = str(meta.get("domain", ""))
    if not ("交易" in dstr or "履约" in dstr or "nine" in dstr.lower()):
        errs.append("domain 须含 交易/履约/nine,现=%r" % meta.get("domain"))
    if not isinstance(meta.get("lite"), bool):
        errs.append("lite 须为 true|false 布尔")
    if errs:
        print("✗ 00_meta.json 不合法,先修好:")
        for e in errs:
            print("  - %s" % e)
        sys.exit(2)
    # 会话戳:VM 按用户复用、/tmp 跨会话共享——首跑把本会话 ID 盖进 meta(机器盖戳),
    # 落档门禁据此区分"本会话流水线"与"他会话残留"。永不覆盖已有戳。
    conv = os.environ.get("CCVM_CONVERSATION_ID")
    if conv and not meta.get("conversation_id"):
        meta["conversation_id"] = conv
        open(meta_path, "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False, indent=2))
    elif conv and meta.get("conversation_id") not in (None, conv):
        print("⚠️ 本流水线属于另一会话(conversation_id 不匹配)。确认要接手再继续;否则另开 slug 或清理该目录。")
    hash_mark = os.path.join(work, ".source_hash")
    if os.path.isfile(hash_mark):
        if open(hash_mark, encoding="utf-8").read().strip() != str(meta.get("source_hash")):
            sys.exit("✗ source_hash 与本目录首次记录不一致——换了源文档就换新工作目录,别复用旧产物")
    else:
        open(hash_mark, "w", encoding="utf-8").write(str(meta.get("source_hash")))
    for stage, files in build_sequence(meta):
        problems = [(f, check_file(os.path.join(work, f))) for f in files]
        problems = [(f, p) for f, p in problems if p]
        if problems:
            name, hint = STAGE_HINTS[stage]
            print("当前工序:%s %s" % (stage, name))
            print("任务:%s" % hint)
            for f, p in problems:
                if p != "缺失":
                    print("⚠ %s 已存在但不合格:%s" % (f, p))
                print("产物落盘到:%s" % os.path.join(work, f))
            return
    print("全部工序完成,可落档(10_published.json 记录 URL 后本流水线结束)")


if __name__ == "__main__":
    main()
