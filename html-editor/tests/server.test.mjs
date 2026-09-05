import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyCommands, applyPatchToSource, injectPatchRuntime, inspectHtml, repairSession } from "../scripts/html-editor-session.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));

test("识别显式 Web 页面", async () => {
  const report = await inspectHtml(join(testDir, "fixture.html"));
  assert.equal(report.platform, "web");
  assert.deepEqual(report.pages.map((page) => page.id), ["page:home", "page:detail"]);
});

test("识别移动端页面与平台", async () => {
  const report = await inspectHtml(join(testDir, "mobile-fixture.html"));
  assert.equal(report.platform, "mobile");
  assert.deepEqual(report.pages.map((page) => page.id), ["page:home", "page:detail"]);
});

test("识别自定义路由清单和复用页面模板", async () => {
  const report = await inspectHtml(join(testDir, "route-manifest-fixture.html"), false);
  assert.deepEqual(report.pages.map((page) => page.id), ["page:home", "page:customers", "page:contacts"]);
  assert.equal(report.pages[1].group, "客户管理");
  assert.equal(report.pages[1].template, "list");
  assert.equal(report.pages[1].rootSelector, '[data-page-scope="list"],[data-route-scope="list"],[data-view-scope="list"]');
  assert.equal(report.pages[1].openFunction, "openPage");
});

test("识别分组菜单数组和动态 renderPage 根节点", async () => {
  const report = await inspectHtml(join(testDir, "group-manifest-fixture.html"), false);
  assert.deepEqual(report.pages.map((page) => page.id), ["page:dashboard", "page:employees", "page:audit"]);
  assert.equal(report.pages[1].title, "员工");
  assert.equal(report.pages[1].group, "人员中心");
  assert.equal(report.pages[1].rootSelector, '[data-page-scope="page:employees"]');
  assert.equal(report.pages[1].openFunction, "renderPage");
});

test("合并 data-page 路由和 -page 内容容器", async () => {
  const report = await inspectHtml(join(testDir, "suffix-route-fixture.html"), false);
  assert.deepEqual(report.pages.map((page) => page.id), ["page:chat", "page:tasks"]);
  assert.equal(report.pages[0].rootSelector, "#chat-page");
  assert.equal(report.pages[0].openFunction, "switchPage");
});

test("识别 data-zmann-scope 页面和 data-nav 路由", async () => {
  const report = await inspectHtml(join(testDir, "zmann-route-fixture.html"), false);
  assert.deepEqual(report.pages.map((page) => page.title), ["任务中心", "任务列表"]);
  assert.equal(report.pages[1].selector, '[data-nav="list"]');
  assert.equal(report.pages[1].confidence, "high");
});

test("识别交互面所属页面、父级关系和复用入口", async () => {
  const report = await inspectHtml(join(testDir, "surface-map-fixture.html"), false);
  const alphaDrawer = report.surfaces.find((surface) => surface.id === "surface:alpha-drawer");
  const nested = report.surfaces.find((surface) => surface.id === "surface:nested-modal");
  const deep = report.surfaces.find((surface) => surface.id === "surface:deep-drawer");
  const wizard = report.surfaces.find((surface) => surface.id === "surface:wizard-surface");
  const deletes = report.surfaces.filter((surface) => surface.rootSelector === "#delete-modal");
  assert.equal(alphaDrawer?.pageId, "page:alpha");
  assert.equal(nested?.pageId, "page:alpha");
  assert.equal(nested?.parentId, "surface:alpha-drawer");
  assert.equal(deep?.parentId, "surface:nested-modal");
  assert.equal(wizard?.pageId, "page:alpha");
  assert.equal(wizard?.kind, "panel");
  assert.equal(wizard?.openSelector, "#open-wizard");
  assert.deepEqual(deletes.map((surface) => surface.pageId).sort(), ["page:alpha", "page:beta"]);
  assert.equal(new Set(deletes.map((surface) => surface.id)).size, 2);
});

test("按已有 ID 局部修改文字", () => {
  const source = '<!doctype html><html><body><section id="page"><p>旧文字</p></section></body></html>';
  const result = applyPatchToSource(source, {
    type: "set-inner-html",
    target: { existingId: "page", domPath: [1, 0], tagName: "section" },
    html: "<p>新文字</p>",
  });
  assert.match(result, /<section id="page"><p>新文字<\/p><\/section>/);
  assert.match(result, /^<!doctype html>/);
});

test("无 ID 节点写入稳定 data-he-id 后修改属性", () => {
  const source = '<html><head></head><body><main><p class="copy">文字</p></main></body></html>';
  const result = applyPatchToSource(source, {
    type: "set-attribute",
    target: { heId: "node-1", domPath: [1, 0, 0], tagName: "p" },
    name: "style",
    value: "color: red;",
  });
  assert.match(result, /<p class="copy" data-he-id="node-1" style="color: red;">/);
});

test("撤销游标只重放游标前命令", () => {
  const source = '<html><head></head><body><p id="copy">原文</p></body></html>';
  const commands = [
    { id: "1", label: "改文字", pageId: "page:main", createdAt: "2026-01-01", patches: [{ type: "set-inner-html", target: { existingId: "copy", domPath: [1, 0], tagName: "p" }, html: "第一次" }] },
    { id: "2", label: "改文字", pageId: "page:main", createdAt: "2026-01-01", patches: [{ type: "set-inner-html", target: { existingId: "copy", domPath: [1, 0], tagName: "p" }, html: "第二次" }] },
  ];
  const result = applyCommands(source, commands, 1);
  assert.equal(result.errors.length, 0);
  assert.match(result.html, />第一次<\/p>/);
});

test("修改 JavaScript 模板动态生成的唯一文字", () => {
  const source = '<html><body><div id="content"></div><script>function render(){return `<section><p>动态原始文字</p></section>`}</script></body></html>';
  const result = applyPatchToSource(source, {
    type: "set-inner-html",
    target: { heId: "dynamic-1", domPath: [1, 0, 0], tagName: "p", originalText: "动态新文字" },
    before: "动态原始文字",
    html: "动态新文字",
  });
  assert.match(result, /<p data-he-id="dynamic-1">动态新文字<\/p>/);
  assert.match(result, /function render/);
});

test("用长文本前缀定位动态段落并修改样式", () => {
  const text = "全省通用标签由省中心统一建设和维护，用来保证全省对同类民生诉求有统一识别口径，同时支持规则配置、样例维护、授权范围和算法版本管理。";
  const source = `<html><body><script>function render(){return \`<section><p>${text}</p></section>\`}</script></body></html>`;
  const result = applyPatchToSource(source, {
    type: "set-attribute",
    target: { heId: "dynamic-copy", domPath: [1, 0], tagName: "p", originalText: `${text.slice(0, 80)}…`, sourceAttributes: {} },
    name: "style",
    value: "position: relative; left: 1px;",
  });
  assert.match(result, /<p data-he-id="dynamic-copy" style="position: relative; left: 1px;">/);
});

test("用属性组合定位动态表单控件", () => {
  const source = '<script>function render(){return `<input data-action="filter" name="keyword" type="text"><input data-action="filter" name="status" type="text">`}</script>';
  const result = applyPatchToSource(source, {
    type: "set-attribute",
    target: { heId: "dynamic-input", domPath: [1, 0], tagName: "input", originalText: "", sourceAttributes: { "data-action": "filter", name: "keyword", type: "text" } },
    name: "placeholder",
    value: "请输入关键词",
  });
  assert.match(result, /name="keyword" type="text" data-he-id="dynamic-input" placeholder="请输入关键词"/);
  assert.doesNotMatch(result, /name="status" type="text"[^>]*placeholder/);
});

test("按 data-page 精准修改重复导航名称", () => {
  const source = `<script>const pages=[{ id: "home", label: "首页" },{ id: "detail", label: "首页" }];function nav(item){return \`<button data-page="${"${item.id}"}">${"${item.label}"}</button>\`}</script>`;
  const result = applyPatchToSource(source, {
    type: "set-inner-html",
    target: { domPath: [1, 0], tagName: "button", originalText: "详情页", sourceAttributes: { "data-page": "detail" } },
    before: "首页",
    html: "详情页",
  });
  assert.match(result, /id: "detail", label: "详情页"/);
  assert.match(result, /id: "home", label: "首页"/);
});

test("坏命令归档并恢复到最后有效状态", () => {
  const source = '<html><head></head><body><p id="copy">原文</p></body></html>';
  const valid = { id: "1", label: "有效修改", pageId: "page:main", createdAt: "2026-01-01", patches: [{ type: "set-inner-html", target: { existingId: "copy", domPath: [1, 0], tagName: "p" }, before: "原文", html: "新文" }] };
  const invalid = { id: "2", label: "无效修改", pageId: "page:main", createdAt: "2026-01-01", patches: [{ type: "set-inner-html", target: { domPath: [9, 9], tagName: "button", originalText: "不存在" }, before: "不存在", html: "失败" }] };
  const session = { commands: [valid, invalid], cursor: 2, rejectedCommands: [], updatedAt: "2026-01-01" };
  const result = repairSession(source, session);
  assert.equal(result.changed, true);
  assert.equal(session.commands.length, 1);
  assert.equal(session.cursor, 1);
  assert.equal(session.rejectedCommands.length, 1);
});

test("运行时补丁 session 重启时不再按源码模式归档", () => {
  const source = '<html><body><div id="app"></div></body></html>';
  const command = { id: "runtime", label: "修改文字", pageId: "page:main", createdAt: "2026-01-01", patches: [{ type: "set-inner-html", target: { domPath: [9, 9], runtimePageId: "page:main", runtimePath: [0, 1], tagName: "td" }, before: "旧", html: "新" }] };
  const session = { patchMode: "runtime", commands: [command], cursor: 1, rejectedCommands: [], updatedAt: "2026-01-01" };
  const result = repairSession(source, session);
  assert.equal(result.changed, false);
  assert.equal(session.commands.length, 1);
  assert.equal(session.cursor, 1);
  assert.equal(session.rejectedCommands.length, 0);
});

test("运行时补丁按页面内路径写入且保留原型源码", () => {
  const source = '<!doctype html><html><body><div id="app"></div><script>render()</script></body></html>';
  const commands = [{
    id: "runtime-1",
    label: "修改文字",
    pageId: "page:detail",
    createdAt: "2026-01-01",
    patches: [{ type: "set-inner-html", target: { domPath: [1, 0], runtimePageId: "page:detail", runtimePath: [1, 2], tagName: "td", originalText: "原内容" }, before: "原内容", html: "新内容" }],
  }];
  const result = injectPatchRuntime(source, commands, 1, "session-a");
  assert.match(result, /<script>render\(\)<\/script>/);
  assert.match(result, /data-he-patches="session-a"/);
  assert.match(result, /data-he-patch-runtime/);
  assert.match(result, /"runtimePageId":"page:detail"/);
  assert.match(result, /"runtimePath":\[1,2\]/);
});

test("再次应用只追加补丁数据而不重复注入运行脚本", () => {
  const source = '<html><body><p>原文</p></body></html>';
  const command = (id, text) => ({ id, label: "修改文字", pageId: "page:main", createdAt: "2026-01-01", patches: [{ type: "set-inner-html", target: { domPath: [1, 0], runtimePageId: "page:main", runtimePath: [0], tagName: "p", originalText: "原文" }, before: "原文", html: text }] });
  const first = injectPatchRuntime(source, [command("1", "第一次")], 1, "session-a");
  const second = injectPatchRuntime(first, [command("2", "第二次")], 1, "session-b");
  assert.equal((second.match(/<script data-he-patch-runtime>/g) || []).length, 1);
  assert.equal((second.match(/data-he-patches=/g) || []).length, 2);
  assert.match(second, /data-he-patches="session-b"/);
});

test("补丁注入跳过 JavaScript 字符串中的 body 结束标签", () => {
  const source = '<html><body><script>const template="</body>";</script><main>页面</main></body></html>';
  const commands = [{ id: "1", label: "修改", pageId: "page:main", createdAt: "2026-01-01", patches: [{ type: "set-inner-html", target: { domPath: [1, 1], runtimePageId: "page:main", runtimePath: [0], tagName: "main" }, before: "页面", html: "新页面" }] }];
  const result = injectPatchRuntime(source, commands, 1, "session-body");
  assert.match(result, /const template="<\/body>";<\/script><main>页面<\/main>/);
  assert.ok(result.indexOf('data-he-patches="session-body"') > result.indexOf("</main>"));
});

test("运行时补丁区分页面内容和公共区域", () => {
  const source = '<html><body><header>公共导航</header><main id="app"></main></body></html>';
  const commands = [{
    id: "scope",
    label: "修改公共导航",
    pageId: "page:detail",
    createdAt: "2026-01-01",
    patches: [
      { type: "set-inner-html", target: { domPath: [1, 0], runtimeScope: "global", runtimePath: [0], tagName: "header", originalText: "公共导航" }, before: "公共导航", html: "新导航" },
      { type: "set-inner-html", target: { domPath: [1, 1], runtimePageId: "page:detail", runtimePath: [0], tagName: "p" }, before: "旧内容", html: "新内容" },
    ],
  }];
  const result = injectPatchRuntime(source, commands, 1, "session-scope");
  const payload = JSON.parse(result.match(/data-he-patches="session-scope">([^<]+)<\/script>/)[1]);
  assert.equal(payload[0].target.tagName, "header");
  assert.equal(payload[0].target.runtimeScope, "global");
  assert.equal(payload[1].target.runtimeScope, "page");
});

test("空 session 的编辑预览也注入运行时监听器", () => {
  const source = "<html><body><main>原型</main></body></html>";
  const preview = injectPatchRuntime(source, [], 0, "empty-session", true);
  const output = injectPatchRuntime(source, [], 0, "empty-session");
  assert.match(preview, /data-he-patch-runtime/);
  assert.equal(output, source);
});

test("旧 session 不重放会冻结导航的整块全局容器", () => {
  const source = '<html><body><div id="app"></div></body></html>';
  const command = {
    id: "legacy-shell",
    label: "设置选中文字",
    pageId: "page:detail",
    createdAt: "2026-01-01",
    patches: [
      { type: "set-inner-html", target: { domPath: [1, 0], runtimePageId: "page:detail", tagName: "div", originalText: "整个动态工作区" }, html: "冻结整个工作区" },
      { type: "set-inner-html", target: { domPath: [1, 0, 0], runtimePageId: "page:detail", tagName: "button", originalText: "旧导航", sourceAttributes: { "data-action": "page" } }, html: "新导航" },
    ],
  };
  const result = injectPatchRuntime(source, [command], 1, "legacy-shell");
  assert.doesNotMatch(result, /冻结整个工作区/);
  assert.match(result, /新导航/);
});
