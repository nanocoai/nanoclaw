#!/usr/bin/env python3
"""PRD 出品硬门 lint:硬门违规=红(exit 1),另附非阻塞统计报告。

用法: python3 lint.py /tmp/prd_work/<slug>/
读 00_meta.json(domain)/08_定稿.md/09_manifest.json/09_带样式.xml(+03/04),
stdout 打 JSON 报告并写 10_lint_report.json;violations 按 owning_stage 打回定点修。
"""
import json
import os
import re
import sys

from apply_format import strip_styling  # 单源剥离,与 apply_format hash 门共用(H17)

LOG_BANNER = "〔pm-lite 内部日志·供排错与续跑，非面向用户的内容〕"

COLOR_TAGS = {  # xml 标签片段 → 类别名,与 apply_format.py 的 WRAP 同步校准(dry-run 实测语法;R3 六类;底色淡色 light-*)
    'text-color="red"': "红字", 'text-color="green"': "绿字",
    'background-color="light-yellow"': "黄底",
    'background-color="light-red"': "红底", 'background-color="light-green"': "绿底", 'background-color="light-blue"': "蓝底",
}
A_CHAPTERS = {  # A 类章名(去序号)——章号连排(H16)后序号会漂,身份=章名,匹配锚定 ## 标题行
    "交易": ["需求背景", "需求价值", "需求范围", "功能详细说明"],
    "履约": ["需求背景", "需求价值", "需求范围", "功能详细说明"],
    "nine": ["背景与现状", "目标与价值", "需求概述", "范围", "功能详细说明", "技术约束", "验收标准"],
}
CN_NUM = {"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
HEADING_RE = re.compile(r"^#{1,2}(?!#)\s*(?:([一二三四五六七八九十]+)、)?\s*(.+)$")


def cn_to_int(s):
    """中文数字→int,覆盖 一~十九;非法串(十十/廿…)返回 None(按非章标题跳过)。"""
    if s in CN_NUM:
        return CN_NUM[s]
    if len(s) == 2 and s[0] == "十" and s[1] in CN_NUM and CN_NUM[s[1]] < 10:
        return 10 + CN_NUM[s[1]]
    return None
FAKE_LIST = re.compile(r"[①②③④⑤⑥⑦⑧⑨⑩].{8,}[①②③④⑤⑥⑦⑧⑨⑩]")
# H18:块边界标签——<span> 若横跨它们即跨单元格/块,飞书 v2 落档 unwrap 整表(6.3 表塌根因)
SPAN_BLOCK = re.compile(r"</?(?:td|tr|th|p|li|ul|ol|table|thead|tbody|grid|column|callout|quote_container)\b")
BAD_LABEL = re.compile(r'\[(?!")[^\]"]*[():：/][^\]]*\]')  # 近似:标签含特殊字符且未 ["..."] 包裹


def read(work, name):
    p = os.path.join(work, name)
    try:
        return open(p, encoding="utf-8").read() if os.path.isfile(p) else None
    except (OSError, UnicodeDecodeError):
        return None


def main():
    if len(sys.argv) != 2:
        sys.exit("用法: python3 lint.py /tmp/prd_work/<slug>/")
    work = sys.argv[1]
    print(LOG_BANNER, file=sys.stderr)
    if not os.path.isdir(work):
        sys.exit("工作目录不存在:%s" % work)
    meta_raw = read(work, "00_meta.json")
    if meta_raw is None:
        sys.exit("缺 00_meta.json——先跑 gate.py 看当前工序")
    draft, xml, mani_raw = read(work, "08_定稿.md"), read(work, "09_带样式.xml"), read(work, "09_manifest.json")
    if draft is None or xml is None or mani_raw is None:
        sys.exit("缺 08_定稿.md / 09_manifest.json / 09_带样式.xml 之一——先跑 gate.py 看当前工序")
    try:
        meta, mani = json.loads(meta_raw), json.loads(mani_raw)
    except ValueError as e:
        sys.exit("meta/manifest JSON 解析失败:%s" % e)

    v, notes = [], []
    add = lambda rule, detail, stage: v.append({"rule": rule, "detail": detail, "owning_stage": stage})

    # H1 图例 ↔ 实际用色集一致;≥2 色必须有图例
    # 只统计 S9 施加的行内 <span> 样式;<td background-color> 是块级局部图例(归 S4),不进 H1 对账
    span_frags = re.findall(r"<span ([^>]+)>", xml)
    used = {cat for frag, cat in COLOR_TAGS.items() if any(frag in s for s in span_frags)}
    legend_line = next((l for l in xml.splitlines() if "📖 图例" in l), "")  # 与 apply_format.py 写入格式同步
    listed = {cat for cat in COLOR_TAGS.values() if cat in legend_line}
    if len(used) >= 2 and not legend_line:
        add("H1", "实际用色 %d 类(%s)但无图例块" % (len(used), "、".join(sorted(used))), "S9")
    elif legend_line and used != listed:
        add("H1", "图例列出(%s)≠实际用色(%s)" % ("、".join(sorted(listed)), "、".join(sorted(used))), "S9")

    # ``` 围栏 = 技术样例专用通道,对所有内容门一致不可见(H2/H9/H12/H16/H15/信号词都豁免;
    # H11 是"手写标记本职门",检的就是围栏外裸标记,自带 toggle 不用这套)。toggle 语义:未闭合围栏豁免其后全部行。
    draft_lines_all = draft.splitlines()
    in_fence_flags, unfenced_lines, _fence = [], [], False
    for l in draft_lines_all:
        if l.strip().startswith("```"):
            _fence = not _fence
            in_fence_flags.append(True)   # 围栏标记行本身算围栏
            unfenced_lines.append("")     # 边界占位空行:保住 H15 连续性重置,防两表被剥接成一张
            continue
        in_fence_flags.append(_fence)
        if not _fence:
            unfenced_lines.append(l)
    unfenced_text = "\n".join(unfenced_lines)

    # H2 假列表:含表格单元格(基线主病灶正是 cell 内 ①②③ 成坨);短枚举(2 圈号且行<60字)豁免;围栏内样例豁免
    for n, line in enumerate(draft_lines_all, 1):
        if in_fence_flags[n - 1]:
            continue
        circ = len(re.findall(r"[①②③④⑤⑥⑦⑧⑨⑩]", line))
        if (circ >= 3 and FAKE_LIST.search(line)) or (circ == 2 and FAKE_LIST.search(line) and len(line) > 60):
            add("H2", "第 %d 行疑似假列表(圈号串成段,应用真列表分行):%s" % (n, line.strip()[:50]), "S4")

    mode = str(meta.get("mode", "new"))
    lite = bool(meta.get("lite"))

    # H-确认 骨架先行确认门:new(非 lite/非 rewrite)落档前必须有 03_方向确认.md 且有实质内容
    # (S3.5 骨架卡确认这一步必须发生过);借后端「lint 非 GREEN 拒 +create」焊死「先确认再落档」。
    # lite/rewrite 豁免(同 H3/H16 先例:lite 免 S3.5、rewrite 走原路)。
    if mode != "rewrite" and not lite:
        confirm = read(work, "03_方向确认.md")
        # ≥4 行结构化(答复原文/确认或调整点/时间/状态),与 gate check_file(>3行)+ S3.5 卡③口径一致
        if confirm is None or len([l for l in confirm.splitlines() if l.strip()]) < 4:
            add("H-确认", "落档前缺 03_方向确认.md 或内容不足4行(S3.5 骨架确认未发生?——须先出骨架卡给用户拍板方向、记确认(≥4行:答复原文/确认或调整点/时间/状态)再落档)", "S3.5")

    # 章标题序列(供 H3 按名匹配 + H16 连排):只认 #/## 标题行,### 及正文子串不算;
    # 容忍加粗标题「## **一、xx**」(剥 ** 后匹配,防合法形态被误杀连带 H16 假红)
    heads = [HEADING_RE.match(l.replace("**", "")) for l in unfenced_lines]
    heading_names = [m.group(2).strip() for m in heads if m]
    chapter_seq = [n for n in (cn_to_int(m.group(1)) for m in heads if m and m.group(1)) if n is not None]

    # H3 A 类标题按章名匹配(锚定标题行;章号连排后序号会漂,身份=章名);rewrite 降级为报告(C3)
    d = str(meta.get("domain", ""))
    key = "交易" if "交易" in d else "履约" if "履约" in d else "nine" if "nine" in d.lower() else None
    if key is None:
        add("H3", "meta.domain=%r 未识别(须含 交易/履约/nine)" % d, "S1")
    else:
        # startswith 非子串:防「灰度范围」类标题假满足短针「范围」(允许「需求范围（一期）」式后缀)
        missing = [h for h in A_CHAPTERS[key] if not any(hn.startswith(h) for hn in heading_names)]
        if key == "nine" and "文档元信息" not in draft:
            missing.insert(0, "文档元信息")
        if key in ("交易", "履约") and "协作" not in draft:
            missing.insert(0, "头部协作表")
        if missing:
            if mode == "rewrite":
                notes.append("rewrite 局部稿,A 类标题未全量出现(正常):%s" % "、".join(missing))
            else:
                add("H3", "A 类标题缺失:%s" % "、".join(missing), "S6")

    # H16 章号连排(仅 new;rewrite 对齐原文档号豁免,同 H3 先例):首章须从「一」起 + 后续逐章 +1
    if mode != "rewrite" and chapter_seq:
        if chapter_seq[0] != 1:
            add("H16-章号连排", "首个一级章编号是 %d(应从「一」起编)——章号按实际出现连排" % chapter_seq[0], "S4")
        bad = next(((a, b) for a, b in zip(chapter_seq, chapter_seq[1:]) if b != a + 1), None)
        if bad:
            add("H16-章号连排", "章节号 %d 后接 %d(跳号/乱序)——模板章号是身份非排位,省略章后须补位连排" % bad, "S4")

    # H4 对账表:存在且每个数据行 ≥3 个非空单元格
    ledger = read(work, "04_对账表.md")
    if ledger is None:
        add("H4", "缺 04_对账表.md", "S4")
    else:
        rows = [l for l in ledger.splitlines() if l.strip().startswith("|")]
        body = [r for r in rows[1:] if not re.match(r"^[\s|:\-]+$", r)]
        if not body:
            add("H4", "对账表无数据行", "S4")
        for r in body:
            if len([c for c in r.strip().strip("|").split("|") if c.strip()]) < 3:
                add("H4", "对账表行不足 3 个非空单元格(五章行id|分支id|6.3域·模块键):%s" % r.strip()[:50], "S4")
        body_doc = read(work, "04_六章主体.md") or ""
        ledger_lines = ledger.splitlines()
        for r in body:
            cells = [c.strip() for c in r.strip().strip("|").split("|") if c.strip()]
            if len(cells) >= 3 and cells[2] not in body_doc:
                # MINOR: 完全相同的两条坏行会都报首个行号(.index 取首现)——罕见,行文本已随附可区分,不做位置追踪
                rn = ledger_lines.index(r) + 1 if r in ledger_lines else None
                add("H4", "04_对账表.md 第%s行 6.3 落点 %r 在 04_六章主体.md 找不到(伪造/失效 id):%s" % (
                    rn if rn else "?", cells[2][:20], r.strip()[:50]), "S4")
        scope = read(work, "03_五章表.md")
        if scope and mode != "rewrite":
            srows = [l for l in scope.splitlines() if l.strip().startswith("|")]
            sbody = [r for r in srows[1:] if not re.match(r"^[\s|:\-]+$", r) and "本期不做" not in r and "范围外" not in r]
            if len(body) < len(sbody):
                add("H4", "对账表 %d 行 < 五章范围 %d 行(有范围行没有 6.3 落点)" % (len(body), len(sbody)), "S4")

    # H5 manifest 必答类覆盖:六类(红字/绿字/红底/黄底/绿底/蓝底)每类须现身 slots 或 none(reason 非空)
    # ——undecided 不替代必答;reason 质量不做机器判(装懂必误杀),弃权纪律靠 S9 卡候选句要求+下方信号词 note
    cats = {s.get("category") for s in (mani.get("slots") or []) + (mani.get("none") or [])}
    lack = [c for c in ("红字", "绿字", "红底", "黄底", "绿底", "蓝底") if c not in cats]
    if lack:
        add("H5", "manifest 必答类未覆盖(需槽位或 无+理由):%s" % "、".join(lack), "S9")
    empty_reason = [n.get("category") for n in (mani.get("none") or []) if not str(n.get("reason") or "").strip()]
    if empty_reason:
        add("H5", "none 弃权缺理由:%s" % "、".join(str(c) for c in empty_reason), "S9")

    # 信号词交叉提示(report-only):正文有风险/禁止级措辞但背景色全弃权,大概率是 S9 偷懒(R3④ 实证 0 底色)
    bg_slot_cats = {s.get("category") for s in (mani.get("slots") or [])} & {"红底", "黄底", "绿底", "蓝底"}
    if any(w in unfenced_text for w in ("不得", "禁止", "风险")) and not bg_slot_cats:
        notes.append("信号词(不得/禁止/风险)在稿中但底色槽位=0——复核红底/黄底候选是否被弃权(S9)")

    # H8 施加对账:各类成功施加数 ≥ manifest 槽位数(防上色静默失败穿门,C1)
    stats_raw = read(work, "09_apply_stats.json")
    if stats_raw is None:
        add("H8", "缺 09_apply_stats.json(apply_format.py 未跑或旧版)", "S9")
    else:
        st = json.loads(stats_raw)
        for cat, want in (st.get("slots") or {}).items():
            got = (st.get("applied") or {}).get(cat, 0)
            if got < want:
                add("H8", "%s 槽位 %d 个仅施加 %d 个(text 不匹配被吞?)" % (cat, want, got), "S9")
        if st.get("errors"):
            add("H8", "apply_format 报 %d 个施加错误" % st["errors"], "S9")

    # H6 mermaid 标签安全(03_图纸.md 可因 lite+static_change 合法缺席)
    diagram = read(work, "03_图纸.md")
    if diagram is None:
        notes.append("03_图纸.md 不存在,H6 跳过")
    else:
        in_mermaid = False
        for n, line in enumerate(diagram.splitlines(), 1):
            s = line.strip()
            if s.startswith("```"):
                in_mermaid = s.lstrip("`").strip().startswith("mermaid") if not in_mermaid else False
            elif in_mermaid and BAD_LABEL.search(line):
                add("H6", '图纸第 %d 行标签含特殊字符未用 ["..."] 包裹:%s' % (n, s[:50]), "S3")

    # H7 版本表:new=须 v1.0 行;rewrite=版本行走原文档局部精修,改查 A3 标记在正文(C3)
    if mode == "rewrite":
        if not ("AI 新增" in draft or "AI 改写" in draft):
            add("H7", "rewrite 稿缺 A3 契约标记(正文段首「AI 新增/AI 改写」)", "S4")
    elif not any("v1.0" in l and "（AI 辅助）" in l for l in draft.splitlines()):
        add("H7", "定稿缺版本表 v1.0 行(变更人须含「（AI 辅助）」)", "S6")

    # H9 水词:词表单源=同目录 prd-deslop.md 机器可读块(hard=硬门,warn=notes);读取失败=跳过并标注(fail-open)
    hard_words, warn_words = [], []
    try:
        deslop = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "prd-deslop.md"), encoding="utf-8").read()
        for line in deslop.splitlines():
            if line.startswith("hard:"):
                hard_words = line.split(":", 1)[1].split()
            elif line.startswith("warn:"):
                warn_words = line.split(":", 1)[1].split()
    except OSError:
        pass
    if not hard_words and not warn_words:
        notes.append("词表不可用,H9 跳过")
    else:
        for w in hard_words:
            hit_lines = [i + 1 for i, l in enumerate(draft_lines_all) if w in l and not in_fence_flags[i]]
            if hit_lines:
                # 位置可定位;×N 语义=命中行数(非出现次数),行号超 5 处截断
                loc = ",".join(str(x) for x in hit_lines[:5]) + ("…" if len(hit_lines) > 5 else "")
                add("H9-水词", "命中禁词「%s」×%d 行(行 %s)" % (w, len(hit_lines), loc), "S8")
        for w in warn_words:
            if w in unfenced_text:
                notes.append("H9-提示词「%s」在稿中,核对是否水词" % w)

    # H10 图片占位残留(前提=S10 次序:回填写回 09 之后才跑 lint,残留即真违规):
    # __IMG_N__ 任意位置红(查未剔除原文,连 <img src="__IMG_2__"> 畸形回填一起抓);
    # 裸 IMG_N 先全局剔除 <img> 标签(已回填 src 含 IMG_ 文件名不误报),
    # 单元格语境(| 开头行 或 含 <td 的 DocxXML 行)→红,散文→只记 notes(防截图文件名误报)。
    ph = re.findall(r"__IMG_\d+__", xml)
    bare_cell, bare_prose = [], []
    for l in xml.splitlines():
        # 按行剥离 <img>;跨行 img 标签不在剥离范围(机械回填产单行 img,已知边界)
        bares = re.findall(r"\bIMG_\d+\b", re.sub(r"<img[^>]*>", "", l))
        if not bares:
            continue
        (bare_cell if (l.strip().startswith("|") or "<td" in l) else bare_prose).extend(bares)
    if ph or bare_cell:
        found = sorted(set(ph + bare_cell))
        add("H10-图片占位", "占位残留 %d 处(%s)未回填真图" % (len(found), ",".join(found[:5])), "S10")
    for b in sorted(set(bare_prose)):
        notes.append("裸 IMG_ 字样在散文,核对是否漏回填:%s" % b)

    # H11 字面行内标记:行内颜色由出品工序(apply_format)机器施加,定稿出现 <span/<font/<code 即模型手写
    # ——会原样渲染成技术垃圾(E2E 实证 4 处包在行内代码里;R3 实证 <code> 双包 3 处)。行内代码唯一写法=反引号。
    # 块级 XML(callout/td/whiteboard)不受限;``` 围栏内样例豁免(toggle 语义同 H13,勿另写剥离逻辑);
    # 反引号内的标签不豁免——立门证据正是"标签包在行内代码里"。
    h11_fenced, span_lines = False, []
    for i, l in enumerate(draft.splitlines(), 1):
        if l.strip().startswith("```"):
            h11_fenced = not h11_fenced
            continue
        if not h11_fenced and re.search(r"<(span|font|code)\b", l):
            span_lines.append(i)
    if span_lines:
        add("H11-字面span", "定稿含手写 <span>/<font>/<code> %d 处(行 %s)——UI 文案用「」纯文本,上色归 S9,行内代码用反引号" % (
            len(span_lines), ",".join(str(x) for x in span_lines[:5])), "S4")

    # H12 坨格(≥2 才红,防硬拆凑数):150+ 字且无任何分行标记(md 列表/换行 或 XML ul/ol/li/br)
    def _is_blob(seg):
        if len(seg) <= 150:
            return False
        if re.search(r"<(ul|ol|li|br)\b", seg):
            return False
        # 分行标记须锚在格首——句中「3 - 5 天」的空格-连字符不算(Codex 反例);
        # 含 <br> 的 seg 已被上方 XML 标记检查提前豁免,此处无需再看 br
        return not re.search(r"^\s*([-*]|\d+\.)\s", seg)
    blob_hits = []  # (真实08行号 or None, 预览) —— 围栏内样例豁免;行号回 draft_lines_all 取(unfenced 下标≠08行号)
    for n, l in enumerate(draft_lines_all, 1):
        if in_fence_flags[n - 1]:
            continue
        if l.strip().startswith("|"):
            for c in l.split("|"):
                c = c.strip()
                if _is_blob(c):
                    blob_hits.append((n, c[:40]))
    for m in re.finditer(r"<td[^>]*>(.*?)</td>", unfenced_text, re.S):
        seg = m.group(1).strip()
        if _is_blob(seg):
            pos = draft.find(seg)                 # 完整坨格(>150字,唯一)反查真08行,不用 seg[:30] 防撞前缀
            ln = draft.count("\n", 0, pos) + 1 if pos >= 0 else None
            blob_hits.append((ln, seg[:40]))
    if len(blob_hits) >= 2:
        loc = "；".join("第%s行「%s…」" % (n if n else "?", p)
                       for n, p in sorted(blob_hits, key=lambda t: t[0] or 0)[:5])
        add("H12-坨格", "08_定稿.md 超长未分行单元格 %d 个(%s)——多步逻辑在 08_定稿.md 内嵌 XML 表用 <ul><li> 分行"
            % (len(blob_hits), loc), "S4")

    # H13 美元占位:只检 `${`(唯一实证被落档解析器当公式吃的形态,dryrun_r2 实证裸 $ 安全);围栏与行内代码豁免
    fenced = False
    h13_lines = []
    for n, l in enumerate(draft.splitlines(), 1):
        if l.strip().startswith("```"):
            fenced = not fenced
            continue
        if fenced:
            continue
        if "${" in re.sub(r"`[^`]*`", "", l):
            h13_lines.append(n)
    if h13_lines:
        add("H13-美元占位", "`${` 会被落档解析器当公式吃(行 %s)——占位写「{var}」" % ",".join(str(x) for x in h13_lines[:5]), "S4")

    # H15 前缀复读:表格首单元格「X · Y」复合前缀连续 ≥3 行=该拆域列没拆(R3② 实证 9 连被 report-only 无视)
    # 首单元格判定防误伤:md 行取第 1、2 个「|」间内容;XML 取单行完整 <tr> 的首 <td>(跨行 tr 不计=已知边界只漏报);
    # 拆过列的表首列=纯域名无「·」、rowspan 合并后续行首格=模块名,均不命中。
    # 已知边界:XML 表无 md 分隔行,若表头首格罕见地写成「X · Y」会和数据行拼 run(表头本应是列名不含「·」,现实不触发)。
    first_cells = []
    for l in unfenced_lines:
        s = l.strip()
        if s.startswith("|"):
            parts = s.split("|")
            first_cells.append(parts[1].strip() if len(parts) > 1 else "")
        else:
            trs = re.findall(r"<tr[^>]*>(.*?)</tr>", l)
            for tr in trs:
                m = re.search(r"<td[^>]*>(.*?)</td>", tr)
                first_cells.append(re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else "")
            if not trs:
                first_cells.append("")  # 非表行=表边界,重置连续计数(两张相邻表/围栏占位行不得拼成一条 run)
    prev_pref, run15 = None, 0
    for cell in first_cells:
        pref = cell.split("·")[0].strip() if "·" in cell else None
        run15 = run15 + 1 if (pref and pref == prev_pref) else (1 if pref else 0)
        prev_pref = pref
        if run15 >= 3:
            add("H15-前缀复读", "「%s ·」首列前缀连续 ≥3 行未拆域列——域独立成列,同域行不逐行重复" % pref, "S4")
            break

    # H14 图位置:每个 <img> 须在 <td> 或 <grid> 分栏内(位置法判祖先,容忍跨行序列化);whiteboard 非 img 不涉
    for m in re.finditer(r"<img\b", xml):
        i = m.start()
        in_td = xml.rfind("<td", 0, i) > xml.rfind("</td>", 0, i)
        in_grid = xml.rfind("<grid", 0, i) > xml.rfind("</grid>", 0, i)
        if not (in_td or in_grid):
            add("H14-图位置", "存在表格/分栏之外的独立图片——截图须进所属场景的单元格/分栏", "S10")
            break

    # H17 定稿↔成品一致:09 剥样式 + 图片归一 后须与 08 逐字等(防改 08 不重跑 apply_format→发陈旧 09)。
    # 保真门非内容层门→不套围栏豁免;img 双侧归一到同一 sentinel→回填前(__IMG_N__)/回填后(<img>)都免疫,不锁死带图 PRD。
    # 图例用 apply_stats 里 apply_format 落的原文(单源权威),不猜"第一个📖图例"→防 08 自带图例行假红。
    stats_legend = ""
    if stats_raw is not None:
        try:
            stats_legend = json.loads(stats_raw).get("legend", "") or ""
        except ValueError:
            stats_legend = ""

    def _canon_img(t):
        t = re.sub(r"<img[^>]*>", "\x00IMG\x00", t)
        return re.sub(r"__IMG_\d+__", "\x00IMG\x00", t)
    if _canon_img(strip_styling(xml, stats_legend)) != _canon_img(draft):
        add("H17-定稿脱钩", "09_带样式.xml 剥样式后与 08_定稿.md 不一致——改 08 后须重跑 apply_format(S9)+回填(S10),勿手改 09", "S9")

    color_total = xml.count("<span ")
    tables, prev = 0, False
    for l in draft.splitlines():
        cur = l.strip().startswith("|")
        tables, prev = tables + (1 if cur and not prev else 0), cur
    reports = {
        "着色总数": color_total,
        "着色密度_每百行": round(color_total * 100.0 / max(1, len(xml.splitlines())), 1),
        "加粗计数": len(re.findall(r"\*\*[^*\n]+\*\*", draft)) + xml.count("<b>"),
        "undecided": mani.get("undecided") or [],
        "表格数": tables,
        "字数": len(re.sub(r"\s", "", draft)),
        "notes": notes,
    }
    # 单元格卫生(report-only,防 Goodhart):底色用没用、长单元格有没有分行
    long_cells = 0
    for l in draft.splitlines():
        if l.strip().startswith("|"):
            for cell in l.split("|"):
                c = cell.strip()
                if len(c) > 150 and "<br" not in c and not re.search(r"^\s*[-*\d]", c):
                    long_cells += 1
    reports["td底色数"] = draft.count("<td background-color")
    reports["超长未分行单元格"] = long_cells
    if long_cells:
        notes.append("超长未分行单元格 %d 个——多步逻辑用真列表分行(S4 落笔自查)" % long_cells)
    # (前缀归并已升 H15 硬门,report-only 提示删除防双报)
    # 引用容器提示(report-only)
    if not any(ln.lstrip().startswith(">") for ln in draft.splitlines()) and len(re.sub(r"\s", "", draft)) > 3000:
        notes.append("全篇无引用块——现状参考/协作待办/旁注建议进引用块(S4)")

    # H18 span 内含性(6.3 表塌根因):S9 上色可产出"未关在单元格内"的 <span>——①未闭合
    # ②横跨单元格/块边界(计数仍配平)——飞书 v2 `+create` 当孤儿标签把整表 unwrap(实测复现)。
    # 扫的是 xml(09_带样式.xml,S9 施加的样式在这里),不是 draft(08 里 H11 已禁 span、扫它=空门);
    # 技术样例围栏内 span 豁免——对 xml 字符串独立重算 fence(不复用 draft 的 in_fence_flags)。
    xu_lines, _xf = [], False
    for l in xml.splitlines():
        if l.strip().startswith("```"):
            _xf = not _xf
            continue
        if not _xf:
            xu_lines.append(l)
    xu = "\n".join(xu_lines)
    n_open, n_close = len(re.findall(r"<span\b", xu)), xu.count("</span>")
    if n_open != n_close:
        add("H18-span未闭合", "09_带样式.xml 有 %d 个 <span> 开 vs %d 个 </span> 闭(未闭合 span 会被飞书当孤儿标签拆表)" % (n_open, n_close), "S9")
    else:
        for m in re.finditer(r"<span\b[^>]*>(.*?)</span>", xu, re.S):
            if SPAN_BLOCK.search(m.group(1)):
                add("H18-span跨块", "09_带样式.xml 有 <span> 横跨单元格/块边界(含 td/p/li 等标签)——飞书 v2 落档会 unwrap 整表:%r"
                    % m.group(1)[:40].replace("\n", " "), "S9")
                break

    # H-IMG 图丢失门(仅 mode==new;rewrite 走 append 原图留原档→比对必误红,豁免——同 H3/H7/H16 对 rewrite 降级):
    # 真强制点在 gate(02_图清单.json 是 new+源文档的 S2 必产物);逃生口=丢图逐图进门③(07_待确认清单)
    # + meta.img_decision,由用户拍板,非模型自清/非 lint 报告(报告到不了用户,pipeline 禁工件名进用户消息)。
    if mode == "new":
        imglist_raw = read(work, "02_图清单.json")
        if imglist_raw is None:
            if meta.get("source_doc_token"):
                add("H-IMG-缺清单", "有源文档(source_doc_token)却无 02_图清单.json——S2 拆图被跳过,先 +fetch|extract_source_images.py", "S2")
        else:
            try:
                _il = json.loads(imglist_raw)
                # 非 dict 的合法 JSON(清单被写坏成 [..]/数字/字符串)保守取 0，不让坏输入崩掉 lint
                src_n = int(_il.get("source_img_count", 0) or 0) if isinstance(_il, dict) else 0
            except (ValueError, TypeError):
                src_n = 0
            if src_n > 0:  # 源无图(含解析失败保守取 0)→ 跳过本门
                out_img = len(re.findall(r"<img\b", xml))
                dropped = (meta.get("img_decision") or {}).get("dropped") or []
                # acct=逐图声明丢弃的图号,去重且限 1..src_n(防越界号/重复号灌大 acct 绕过)
                acct = len({int(d["n"]) for d in dropped if isinstance(d, dict)
                            and str(d.get("n", "")).lstrip("-").isdigit() and 1 <= int(d["n"]) <= src_n})
                if out_img + acct < src_n:
                    add("H-IMG-丢图", "源 %d 图:带入 %d + 逐图声明丢弃 %d,缺 %d 张既未带入也未声明——丢图须逐图进门③待确认清单让用户拍板,不许静默丢"
                        % (src_n, out_img, acct, src_n - out_img - acct), "S4")

    report = {"status": "RED" if v else "GREEN", "violations": v, "reports": reports}
    out = json.dumps(report, ensure_ascii=False, indent=2)
    print(out)
    open(os.path.join(work, "10_lint_report.json"), "w", encoding="utf-8").write(out)
    sys.exit(1 if v else 0)


if __name__ == "__main__":
    main()
