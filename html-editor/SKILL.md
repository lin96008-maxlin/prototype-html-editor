---
name: html-editor
description: "为已有的自包含单 HTML Web 或移动端原型启动轻量本地编辑工作台，重点支持可靠的页面定位、文字与表单内容修改、组件移动、基础尺寸样式、快捷键、session 恢复及生成新版本文件。仅在用户明确调用 $html-editor 或要求打开 HTML 原型编辑器时使用；不负责从零设计原型、业务交互配置、复杂布局重构或页面关系画布。"
---

# HTML 原型编辑器

对已有自包含单 HTML 进行本地、可恢复、非破坏式的可视化修改。

## 任务路由

### 打开或继续编辑

1. 确认目标是存在的 `.html` 文件；不要读取或修改 `.env`。
2. 首次处理或源文件变化后运行 `node scripts/html-editor-session.mjs inspect "目标.html" --fresh`。自动分析必须综合显式页面标记、`data-*-key` 路由、AST 中的 `pages/routes/screens/views` 配置、打开函数、复用模板，以及弹窗、抽屉、Popover 等交互面。
   - 只有确认现有 Agent map 已过度识别或失效时，才使用 `inspect "目标.html" --fresh --replace-map` 以新版自动映射覆盖它；该命令不删除旧 session。
3. Agent 只复核自动分析报告中的低置信度、无归属或无打开入口项目，不手工枚举全部按钮和状态。确认存在遗漏、错归或单页回退时，才在干净预览中验证相关入口并生成映射 JSON，再运行 `node scripts/html-editor-session.mjs page-map "目标.html" --input "映射.json"`。交互面使用 `surfaces`，至少提供 `id/title/kind/pageId/rootSelector`，并提供 `openSelector` 或 `openFunction/openArgs`；多级交互用 `parentId`。不得把普通按钮、Tab、表格行或步骤状态伪造成交互面。
4. 运行 `node scripts/html-editor-session.mjs serve "目标.html"`，使用命令实际输出的 `editUrl`；端口由服务自动选择。
   - 用户要求从原版重新开始，或编辑器 Skill 自身刚完成优化时，运行 `serve "目标.html" --new-session`。必须保留旧 session，不得删除。
5. 在 Codex 中打开该 URL，确认根节点 `data-html-editor-status="ready"`。逐页或按风险抽样验证页面树目标、活动导航和当前可见页面根一致；不要代替用户执行内容修改。
6. 保持服务运行。浏览器修改只写入目标文件旁的 `.html-editor/` session，不修改原 HTML。

### 应用本轮修改

用户说“改完了”“应用修改”或同义表达时：

1. 运行 `node scripts/html-editor-session.mjs status "目标.html"`，确认唯一活动 session、源路径和修改数量。
2. 运行 `node scripts/html-editor-session.mjs apply "目标.html" --session "sessionId"`。
3. `apply` 必须校验源文件 hash；源文件已变化时停止，不自动合并。
4. 读取输出的 `outputPath` 和 `verificationPlan`。运行 `validate`，再只执行计划要求的浏览器检查。
5. 打开新版本预览。原文件必须保持不变；新文件按 `-v1.1`、`-v1.2` 递增命名。

### 检查

使用 `node scripts/html-editor-session.mjs validate "目标.html" [--session "sessionId"]` 检查页面映射、session、补丁可应用性和自包含资源。只报告问题时不要写回文件。

## 行为边界

- 预览模式完整运行原型已有 JavaScript、页面、Tab、弹窗和表单交互。
- 编辑模式聚焦文字、按钮文案、输入提示、图片、现有下拉选项、现有列表内容、表格单元格文字、位置、宽高和基础文字样式；不新增或修改业务交互。
- 左树提供“完整目录”和“仅页面”两种图标模式。切页后收起非当前页面；选中其他对象后收起旧对象分支，只展开新对象祖先路径。
- 弹窗、抽屉和多级交互面必须按映射归入真实页面及父级。点击左树时先执行原型自身打开入口，等待动画稳定后再选中定位；禁止对画布外隐藏节点直接执行 `scrollIntoView`。
- 文字样式使用图标工具栏，支持加粗、斜体、下划线、删除线、对齐、字号和常用色板。未框选文字时作用于整个元素或容器；进入文字编辑并框选后只作用于选区。
- 单选可调整尺寸的元素时，在 iframe 内显示四边四角 8 个手柄；不得使用跨 iframe 坐标的外部选框。
- 选中、父级和悬停边界必须使用 iframe `body` 顶层 overlay 绘制，不能使用可能被子容器遮挡的元素自身 outline。四条边只作为透明缩放热区，视觉上只保留一条选中轮廓和四个角点。
- 单选时用淡虚线显示最近一级父容器；悬停边界使用清晰的青绿色，只显示当前选择层级到鼠标命中的最深下级容器链。
- 同一父容器内点击兄弟容器必须直接切换选择；点击当前元素的任意祖先容器空白处，必须直接选中实际点击的最近祖先，不从最外层重新开始。
- 选中态拖动时必须阻止浏览器文字选择；只有双击进入文字编辑态后才允许框选文字。
- 表格不支持新增/删除行列；动态表格只编辑现有单元格文字。下拉框只编辑选项名称和默认项，不暴露内部值。
- 不提供 Flex/Grid、任意层级、隐藏、锁定、阴影、透明度或大型组件库。不得为了“完整”重新加入未经真实流程验证的低频功能。
- 页面优先使用 `data-proto-scope` / `data-proto-route`，兼容 `data-page`、`.page`、`.screen` 和常见 `navigate/showPage/switchPage`。
- 非标准路由同时识别 `data-page-key/data-route-key/data-view-key`、`aria-current`、系统页签、页面配置对象和 `openPage` 等函数。逻辑页面与 `list/detail/builder` 等复用模板必须分开建模。
- 左树按“页面分组 → 逻辑页面 → 当前可见容器”展示。未显示的页面模板、抽屉和对话框不得进入当前树；浮层打开后才展示。
- 左侧始终列出全部页面，并在当前页面下展示实时页面内容及页头、导航、侧栏、标注入口等公共区域；不得缓存其他页面的 DOM 元素。公共区域修改必须跨页面持续生效。
- 已有 `prototype-annotation` 时，将标注视为原 HTML 的普通内容：预览和编辑模式都保持可见，编辑模式统一拦截点击用于选择，预览模式恢复原交互。不得单独隐藏、过滤或建立标注模块。
- Canvas、WebGL、跨域 iframe 和框架虚拟 DOM 内部内容作为整体元素处理。
- 不删除原文件、不覆盖已有版本。新版本可包含 `data-he-patches` JSON 和唯一一份轻量补丁运行脚本；不得包含编辑器界面、选框样式或 session 文件。

## 验证底线

- 使用目标原型的独立副本测试，不污染用户活动 session。
- 多页面原型必须逐页核对页面树目标与实际可见 scope；只测首页不算通过。
- 在非 100% 缩放下验证画布点击、左树跟随、鼠标拖动、Shift 锁向和 Ctrl 多选。
- 验证“选中 → 双击文字编辑 → 第一次点空白退出编辑并保留选择 → 第二次点空白取消选择”，边线点击也必须退出文字编辑并保留选择。
- 在 70% 与 100% 缩放下验证四边四角尺寸手柄贴合元素边框并能改变尺寸。
- 验证容器整体文字格式与局部文字选区格式不会相互混淆。
- 撤销/重做必须在当前 iframe 内应用正向或反向补丁；验证 iframe 节点和 load 次数不变，不允许用整页重载造成闪烁。
- 含标注的原型必须验证浮点在编辑模式可见可选、在预览模式可打开菜单。
- 对动态原型至少验证一次文字、表格单元格、下拉选项或列表的“修改 → 页面切换 → 撤销/重做 → 服务重启”。
- 检查浏览器控制台、session 拒绝数量、原文件 hash 和最终副本交互。任何拒绝或页面错位都必须先解决再交付。

## 资源导航

- `references/editor-contract.md`：页面识别、session、操作和写回契约。
- `scripts/html-editor-session.mjs`：检查、服务、状态、应用与验证命令。
- `.html-editor/{prototypeKey}/page-map.json`：按源 hash 缓存的自动或 Agent 页面及交互面映射。
- `assets/editor-app/`：已构建的本地编辑工作台；调用时不需要安装依赖。
