# HTML 原型编辑器契约

## 页面识别

识别优先级如下：

1. 唯一 `[data-proto-app]` 业务根节点和 `data-proto-scope="page:*"` 页面。
2. `[data-page]`、`[data-proto-page]`、`.page`、`.screen`。
3. `[data-page-key]`、`[data-route-key]`、`[data-view-key]` 等导航证据，并使用 AST 解析 `pages/routes/screens/views` 配置对象。
4. `openPage/showPage/navigate/switchPage` 等打开函数、`aria-current` 和系统页签用于运行时打开与判定当前页面。
5. 无多页面证据时才将 `body` 作为唯一页面 `page:main`。

三级 `page:订单详情:基础信息` 视为“订单详情”页面内状态，不生成重复页面。页面显示名依次取 `data-title`、`aria-label`、页面标题元素和内部 ID。

逻辑页面和 DOM 模板必须分开：多个页面可以共用一个 `[data-page-scope="list"]`，但内部仍使用各自稳定页面 ID。抽屉、对话框和记录详情实例属于当前页面浮层或模板，不按每条数据生成固定页面。

页面映射可保存为 `.html-editor/{prototypeKey}/page-map.json`。自动映射与 Agent 映射都绑定源文件 hash；hash 改变后必须重新分析。Agent 页面至少包含 `key/title/selector`，可包含 `group/rootSelector/activeSelector/openFunction/template`。

`surfaces` 描述页面内交互面：`id/title/kind/pageId/rootSelector` 为必填，`contentSelector/openSelector/openFunction/openArgs/activeSelector/parentId` 为可选。`pageId` 决定归属页面，`parentId` 组成抽屉、弹窗、Popover 的多级链路。同一个复用浮层可针对不同页面保存多条映射，但每条映射必须有唯一 `id` 和对应入口。

## 元素目标

每个修改目标包含：

- `existingId`：原节点已有 ID，优先使用。
- `domPath`：从 `documentElement` 开始的元素子节点索引路径。
- `runtimePageId`：目标所属页面，防止相似页面间串位。
- `runtimeScope`：`page` 表示页面内部目标，`global` 表示页头、导航、侧栏或标注等跨页面公共目标。
- `runtimePath`：从当前页面 scope 根节点开始的相对元素路径，是动态页面的主要定位依据。
- `runtimeRootSelector`：逻辑页面复用模板时，指向当前可见模板根；运行时还必须核对活动路由 key，防止共用模板之间串改。
- `tagName`、`originalText` 和稳定业务属性：路径失效时用于页面内校验和回退，不在全文盲目匹配。

坐标只用于编辑器选框，不得作为写回目标。

## Session

```json
{
  "schemaVersion": 1,
  "patchMode": "runtime",
  "sessionId": "session-id",
  "sourcePath": "C:/absolute/prototype.html",
  "sourceHash": "sha256",
  "platform": "web",
  "pages": [],
  "commands": [],
  "cursor": 0,
  "ui": {},
  "status": "active"
}
```

`commands` 是按用户动作分组的历史记录；`cursor` 之前的命令构成当前草稿。撤销只移动游标，不删除历史；新命令会清除游标之后的重做分支。

`serve --new-session` 从未修改的源 HTML 新建空 session，并把 manifest 的活动 session 指向新记录；已有 session 文件只保留归档，不删除、不合并到新 session。

## 补丁类型

- `set-attribute`：设置或移除单个属性。样式变化统一提交完整 `style` 属性。
- `set-inner-html`：修改目标内部内容，适用于文字和局部结构。
- `set-inner-html` 也承担已验证的复制、粘贴、重复和删除操作，但只替换目标父容器的局部内容。

服务端保存命令时不再尝试把浏览器 DOM 硬匹配回 JavaScript 模板。预览和最终副本均按页面内定位重放相同补丁。

## 编辑状态

- 点击已选容器时，只有点击路径中存在更深可选元素才继续深入；点击容器自身空白区域保持当前选择，不循环回外层。
- 双击可编辑文字进入文字编辑态；编辑态第一次点击画布、左右栏空白或元素边线只结束文字编辑并保留选择，选中态再次点击空白才清除选择。
- 同一父容器内点击兄弟容器直接切换到同层目标；点击当前元素的祖先容器空白处时直接选中该祖先，不重新从外层开始。选中态按下鼠标准备拖动时立即清除并禁止原生文字选区。
- 单选只标记最近一级父容器；鼠标悬停时从当前选择层级开始，沿命中路径标记所有下级容器，不显示更上层容器。
- `data-he-selected`、`data-he-editing`、`data-he-dragging` 和尺寸手柄只存在本地编辑 iframe，写回前必须清理。
- 文字范围使用 iframe 原生 `Selection/Range`。无范围时样式写到整个选中元素；有非折叠范围时，富文本命令写入选中元素内部并提交该元素的 `set-inner-html`。
- 尺寸手柄必须创建在目标 iframe 的 `document.body` 内，位置使用同一 iframe 的 `getBoundingClientRect` 与滚动坐标，不得跨窗口计算 Moveable 控制框。
- 四边手柄是透明命中区，只有四角显示控制点，避免与元素选中轮廓形成重复边线。
- 选中、父级和悬停边界均使用 `document.body` 顶层 overlay，不能依赖目标元素自身的 `outline`，避免被定位子元素、背景或滚动容器遮挡。
- 撤销/重做接口返回实际命令。前端生成反向/正向补丁并直接更新当前 DOM，不重新加载 iframe；随后用当前 `cursor` 下的完整有效补丁集合替换浏览器临时补丁，禁止累积已撤销的历史补丁。
- 原型标注层不设特殊隐藏规则，也不从选择系统中排除；页面树无需建立独立标注模块。

### JavaScript 动态页面

页面由模板字符串、`innerHTML` 或渲染函数动态生成时：

- 页面目标先按 `runtimePageId` 找到当前可见页面根节点，再按 `runtimePath` 找目标；`global` 目标从 `body` 定位，不受当前页面限制。
- 页面重新渲染或切换回来后，轻量 MutationObserver 只重放值确实不同的补丁。
- 正在选择、文字编辑或拖动的元素及其父容器暂停重放，避免结构补丁替换当前操作节点。
- 表格单元格、列表和下拉选项可修改现有内容；不尝试推断业务数据模型或新增表格结构。

## 写回

- 源 hash 不一致时拒绝写回。
- 原文件无版本号时输出 `-v1.1.html`；已有 `-vN.M` 时递增小版本。
- 文件已存在时继续递增，禁止覆盖。
- 最终文件注入一个 `data-he-patches` JSON 块和唯一一份 `data-he-patch-runtime` 脚本。
- 最终文件不得保留选框、编辑器样式、工作台状态或本地服务代码。
