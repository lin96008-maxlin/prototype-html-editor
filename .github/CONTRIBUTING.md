# 参与贡献

感谢你改进 Prototype HTML Editor。

## 适合提交的内容

- 不同单 HTML 原型中的页面、路由、弹窗、抽屉和多级交互兼容问题；
- 文字、表格、列表、下拉选项、图片、位置和尺寸编辑改进；
- 选择、悬停、拖动、缩放、快捷键和目录定位问题；
- 会话恢复、冲突检查、版本写回和自包含验证改进；
- 文档、安装说明和脱敏测试场景修正。

## 提交 Issue

请说明：

1. 原型面向 Web 还是移动端；
2. 期望结果和实际结果；
3. 可复现的最小步骤；
4. 浏览器、Node.js 和操作系统版本；
5. 已脱敏的最小 HTML 或截图。

请勿提交真实客户名称、内部地址、账号、Token、未脱敏原型或其他敏感材料。安全问题按 [SECURITY.md](./SECURITY.md) 私下报告。

## 提交 Pull Request

1. 保持能力范围聚焦已有自包含单 HTML 的编辑与版本导出。
2. 新增识别规则时提供脱敏夹具，覆盖成功与失败路径。
3. 页面和交互面识别应使用结构、属性、AST 和运行状态的组合证据。
4. 修改工作台、服务或写回逻辑后运行：

```bash
cd html-editor
npm ci
npm run typecheck
npm test
npm run build
```

5. 涉及浏览器交互时，使用真实浏览器检查预览、编辑、页面切换、弹层和快捷键。
6. 新截图和测试材料必须完成脱敏。

提交信息可采用：

```text
fix: correct nested drawer navigation
feat: add page-only tree mode
docs: clarify version export workflow
test: cover shared interaction surfaces
```
