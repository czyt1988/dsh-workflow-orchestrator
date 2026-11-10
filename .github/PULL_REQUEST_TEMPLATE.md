## 变更类型

<!-- 勾选本 PR 涉及的项（可多选），与提交信息的 Conventional Commits 类型对应。 -->

- [ ] 🐞 Bug 修复（`fix`）
- [ ] ✨ 新功能（`feat`）
- [ ] 📝 文档（`docs`）
- [ ] ♻️ 重构（`refactor`）
- [ ] 🎨 代码风格（`style`）
- [ ] ⚡ 性能优化（`perf`）
- [ ] ✅ 测试（`test`）
- [ ] 🔧 CI / 构建 / 杂项（`ci` / `build` / `chore`）
- [ ] 🌐 翻译 / 文案（`locale`）

## 关联 issue

<!-- 用关键字关联，例如 Closes #12、Fixes #34；没有关联 issue 可写「无」并说明原因。 -->

Closes #

## 变更说明

<!-- 说明「改了什么、为什么这样改」，以及需要人工注意的兼容性影响。 -->

## 测试证明

<!-- 给出实际执行过的命令与结果；CI 通过不能代替本地验证。 -->

```powershell
npm test
npm run check
```

结果：

<!-- 例如：# pass 11 / # fail 0；npm run check 输出 OK。 -->

## 文档与 CHANGELOG

- [ ] 已同步更新 README 与相关文档（`docs/`）
- [ ] 已在 [CHANGELOG.md](https://github.com/czyt1988/dsh-workflow-orchestrator/blob/main/CHANGELOG.md) 的 `[Unreleased]` 记录用户可见变更
- [ ] 本次改动不需要文档 / CHANGELOG 更新（请在下面说明原因）

## 影响范围

- [ ] 用户界面 / 交互
- [ ] 执行引擎 / 调度语义
- [ ] JSON API 路由 / 存储格式
- [ ] 插件包清单 / 加载配置（`package.json`、`cordis.patch.yml`、`locale/`）
- [ ] 仅文档 / 注释 / 测试

## 截图

<!-- UI 改动请附「改动前 / 改动后」截图，图片可直接拖入。非 UI 改动可写「不适用」。 -->

| 改动前 | 改动后 |
| --- | --- |
|  |  |

## 提交前自查

- [ ] 提交信息符合 Conventional Commits，并已按 DCO 签名（`git commit -s`）
- [ ] 未新增运行时依赖、未引入构建步骤
- [ ] 未提交 `.e2e-home/`、`.e2e/`、`.probe/`、`node_modules/` 等本地产物或凭据
- [ ] 涉及安全问题时已按 [SECURITY.md](https://github.com/czyt1988/dsh-workflow-orchestrator/blob/main/SECURITY.md) 走私密渠道，而非本 PR

## 其他说明

<!-- 可选的补充：已知限制、后续计划、需要 reviewer 重点看的部分。 -->
