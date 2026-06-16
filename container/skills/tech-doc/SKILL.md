---
name: tech-doc
description: 把现有代码/系统的运作机制沉淀成图文一体的技术文档。用户说"沉淀文档"、"整理技术文档"、"把这套架构写成文档"、"画几张图讲清 XX 怎么运作"、"看下代码生成文档"时触发。流程:核实真实代码 → PlantUML 偏细分层画图 → 渲染 PNG → feishu-docs 图文一体飞书文档 → read 验证。区别于 prd(做之前的需求共识),tech-doc 是做之后基于真实代码的架构沉淀;不写代码、不改代码。
---

# tech-doc — 代码架构沉淀文档

把"系统/模块已经怎么运作"讲清楚,沉淀成一份图文一体、基于真实代码、可当 onboarding 用的技术文档。

**和 prd 的分工**:`prd` 是做**之前**的需求共识(目标/验收/E2E);`tech-doc` 是做**之后**的架构沉淀(基于已存在的真实代码讲"怎么运作")。两者共用同一套 PlantUML 渲染 + 图文一体飞书文档规则,但**图的语言皮肤不同、骨架不同**。

**图的语言层级(双皮肤 · 与 prd 对称,改一处须同步另一处)**:同一套流程逻辑,按受众切两种皮肤——

- **tech-doc 默认「工程术语版」**:泳道用真实系统/模块,动作用真实函数/接口/锁/回调/状态机名,异常出口全画(busy/need_login/need_verify/timeout),术语保留技术原名并标代码文件/行,收尾标代码出处/约束/边界,按粒度分层可多张。
- **业务文案版(prd 默认)**:泳道只分业务角色、动作人话+拟人、技术异常藏掉只留业务关心的、术语翻译成业务话、底部标价值点、1-2 张主线即可。完整规则与对照表在 `prd` skill 的 §图的语言层级。

这张双皮肤对照是两个 skill 的**共享契约**,任何一边改了,另一边同步改。

## 铁律(违反任一即不合格)

1. **先核到真实代码再画,禁止虚构**:每个结论、每条连线、每个状态都要能指到具体文件/行/符号。没核到的不许画,标"待核实"。
2. **图文一体,主载体飞书文档**:唯一交付物是**一个飞书 docx**,图 inline 在解释它的章节正文旁。禁止图文分离、禁止用 HTML/云盘附件顶替飞书文档。
3. **PlantUML 偏细 + 粒度分层**:工程图用 PlantUML;一图一层级,要更细就把框展开成下一张完整图,禁止单图硬塞多层。
4. **read 验证**:写完必须 `feishu-docs read` 核对图都 inline 入位、章节对齐,不许让用户当测试员。

## 工作流

### Step 1:锁定范围 + 找代码入口

先问清楚要沉淀**哪个系统/模块**、**讲到什么粒度**(整体架构 / 某条链路 / 某个内核)。然后定位代码主体:

- 用 `/code-index` 或 `grep -rn "class X"` 找核心类/入口/注册表。
- 追到**实际 I/O 边界**(HTTP/DB/子进程/事件落库),不要看到中间层就停。
- 明确**基准分支**(默认当前工作区;用户要线上口径就开 worktree 切 origin/dev 对比)。

### Step 2:核实(禁止虚构)

每张图开画前,核到支撑它的真实代码:

- 调用链:`grep` + `sed -n` 读关键方法主体,确认"谁调谁"。
- 状态/枚举:读真实定义(别凭记忆,状态值经常和事件混淆)。
- 分支/循环:读真实退出条件,别套"通用 ReAct"模板。

核到的证据(文件:行)记下来,文档开头写"代码基准"标明出处。

### Step 3:规划图谱(粒度分层)

按"一张图回答一类问题"拆。常用映射:

| 要讲的 | PlantUML 图类型 | 需 graphviz? |
|---|---|---|
| 系统由哪些模块组成、怎么依赖 | `component` / C4 | 是 |
| 谁调谁、什么顺序 | `sequence` | 否 |
| 对象有哪些状态、怎么转 | `state` | 是 |
| 流程有哪些分支/循环/并发 | `activity`(泳道 `\|x\|`) | 否 |
| 数据表/实体关系 | `class` / `entity` | 是 |

先列"图清单 + 每张回答什么问题",和用户对齐再开画。**层级混了就拆图**:上层框(如某内核)单独展开成下一张完整图。

### Step 4:画图 + 渲染

**先选图引擎(默认 mermaid 白板)**:
- **默认 mermaid → 飞书白板**:能用 mermaid 表达的(sequence/state/class/flowchart/component),**首选直接在正文写 ` ```mermaid ` 代码块**,`feishu-docs create/append` 会自动转成**可编辑白板块**(源码无损,用户能在飞书里直接改图)。省掉渲染 PNG、字体、graphviz 这一整套,且交付的是活图不是死截图。配色/高亮用 mermaid 自己的 `style`/`classDef` 语法。
- **退回 PlantUML PNG 的场景**:mermaid 画不出或画不好的——需要复杂泳道、精细 `skinparam` 皮肤、像素级焦点高亮、或一张图分多层级精排版时,才走下面的 PlantUML 渲染路线。

PlantUML 路线:写 `.puml` 源码,渲染 PNG。

**渲染命令**(中文正常):
```
java -jar /tmp/plantuml.jar -tpng x.puml -o <输出目录>
```
- 高清:源码内加 `skinparam dpi 140`(或 150)。
- 中文字体:`skinparam defaultFontName "PingFang SC"`。
- 依赖:`state`/`component`/`class` 需系统装 `graphviz`(`dot`,`brew install graphviz`;代理报 SSL 时 `env -u HTTPS_PROXY ... brew install`);`sequence`/`activity` 不需要。
- 环境无 jar/dot:降级 kroki.io 在线渲染,并标"图待渲染"。

**统一皮肤**(粘到每个 puml 的 `@startuml` 后,保证风格一致):
```
skinparam dpi 140
skinparam defaultFontName "PingFang SC"
skinparam shadowing false
skinparam roundCorner 8
skinparam backgroundColor #faf8f4
skinparam ArrowColor #4f5d75
skinparam componentStyle rectangle
```

**焦点高亮配色体系**(语义化,别乱配色;在节点后加 `#色值` 或 activity `#色值:文字`):

| 色值 | 语义 | 典型用途 |
|---|---|---|
| `#FFE0B2`(橙) | 挂起 / 关注 | 当前聚焦的核心节点、中间挂起态 |
| `#C8E6C9`(绿) | 成功 / 正常 | 正常收口、成功终态 |
| `#FFCDD2`(浅红) | 失败 | 失败终态、被拦截 |
| `#FF5252`(强红) | 误判 / 错误 | 真正的 bug 点、误判路径(最扎眼,慎用) |

背景 `#faf8f4`(米白) + 箭头 `#4f5d75`(灰蓝) + `roundCorner 8` + 关阴影是统一底色,保证多张图风格一致。要像素级精确控制才换手画 SVG(`diagram-design`)。

**微调手段**(从轻到重):改文字/加节点 → 局部高亮 `[X] #FFE0B2` → 分组 `package`/`partition`/泳道 → `skinparam` 全局样式 → 布局 `left to right direction`/`-[hidden]-`/`\n` 换行。注意 PlantUML 自动布局,**不能精确摆坐标**;要像素级控制才回退 `diagram-design`(手画 SVG)。

**渲染后必须 Read 截图自检**:中文有没有乱、节点有没有重叠、焦点高亮对不对。不合格就调源码重渲。

### Step 5:出图文一体飞书文档

用 `feishu-docs` 把正文和图**按章节顺序交替写入同一个飞书 docx**。两条路按 Step 4 选定的引擎走:

**mermaid 白板路线(默认)**:把 ` ```mermaid ` 代码块直接写进正文,`create`/`append` 时随正文一起导入,飞书自动转白板,图天然落在它解释的文字旁,**不需要 insert-image**。要事后精改单张图用 `lark-cli docs +whiteboard-update --input_format mermaid`。

**PlantUML PNG 路线(退回时)**:
1. 各图 `.puml` 渲染成 PNG(dpi 高清)。
2. `feishu-docs create "标题"`(stdin 传第 1 段正文,到第一张图之前)→ 拿 document_id。
3. `feishu-docs insert-image <doc> 图.png --width 720 --caption "图N · ..."` 插图。
4. `feishu-docs append <doc>`(stdin 传下一段正文)→ `insert-image` 插下一张图 → 交替到写完。
5. append/insert-image 都追加到文档末尾,**按章节顺序调用,图自然落对位置**。

图宽建议(PNG 路线):时序/事件谱系等横向图 760-820,流程/状态/组件 600-720。

### Step 6:read 验证

```
feishu-docs read <doc> | grep -ociE "image|whiteboard|mermaid"   # 图数 == 计划张数(白板/图片都数上)
feishu-docs read <doc> | grep -oiE "<h2>|图[0-9]"                 # 章节 + 图注顺序对位
```
mermaid 白板路线还要确认 `read` 回来的 mermaid 源码完整(没被截断)。图数不对或图注错位 → 修。验证通过才交付链接。

## 推荐文档骨架(按需裁剪)

```
标题 + > 代码基准(分支 + 核心文件:行)

一、为什么/背景      —— 这套机制解决什么、从哪来(纯描述)
二、整体架构总览     —— component 图:有哪些模块、怎么依赖
三、核心链路         —— sequence 图:一次典型流程谁调谁
四、内核/关键机制     —— activity 图:把核心框展开(粒度下钻)
五、生命周期与状态    —— state 图:对象状态机
六、数据/事件体系     —— 事件谱系/ER 图
七、对接点/边界       —— 两个子系统在哪缝合
附:里程碑 + 代码基准说明
```

不是每篇都要全部章节;小模块 3-4 节即可。原则:**每节配一张图、每张图基于真实代码、图就在它解释的文字旁**。

## 禁止事项

- 禁止凭记忆/docstring 推断画图,必须核到源码。
- 禁止图文分离、禁止 HTML/云盘附件当交付物(主载体必须飞书 docx)。
- 禁止单图硬塞多层级,该拆就拆。
- 禁止跳过 read 验证就把链接发给用户。
- 不写代码、不改代码、不提 PR。

## 完成标准

用户打开飞书文档能回答:这套机制解决什么?由哪些模块组成?一次典型流程怎么走?核心内核怎么转?状态/数据怎么组织?边界在哪对接?且每个结论都能指回真实代码。答不出就继续核代码补图。
