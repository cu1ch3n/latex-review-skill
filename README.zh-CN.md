# LaTeX Review Skill

[English](README.md) · **简体中文**

[![CI](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/cu1ch3n/latex-review-skill/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/cu1ch3n/latex-review-skill)](LICENSE)
![Node.js 22.22+](https://img.shields.io/badge/Node.js-22.22%2B-339933)
![macOS and Linux](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)

直接在排版后的文档中审阅 AI agent 的 LaTeX 修改，并逐项对照源文件差异。

LaTeX Review Skill 将编程 agent 的编辑流程与本地 PDF 审阅页面连接起来。Agent 在独立的 Git worktree 中修改文档；你可以接受、拒绝或评论每项改动。接受的修改会合入你的稿件，审阅意见则通过结构化 CLI 返回给 agent。

![演示：agent 提出 LaTeX 修改，用户在 PDF 中逐项审阅、接受或评论](docs/demo.gif)

[快速开始](#快速开始) · [审阅流程](#审阅流程) · [Agent 接口](#agent-接口) · [开发与测试](#开发与测试)

## 功能

- **结合上下文审阅。** 在矢量 PDF 预览中查看文字、公式和图表，保留周围内容，并提供修改前后视图及对应的 LaTeX 差异。
- **选择与复制。** 直接选择预览中的文字进行复制。**Copy reference** 会同时复制所选文字、源文件路径、行号、PDF 页码和审阅轮次。
- **决定哪些修改进入稿件。** 逐项接受，或一次接受全部待定修改。撤销操作可以恢复单项决定或整批修改。
- **让 agent 获得完整反馈。** 决定、完整评论、消息、源文件位置和构建错误均可通过 CLI 获取，agent 无需访问浏览器即可跟进审阅。
- **保留现有 Git 工作流。** 接受的修改以未提交状态保留在你的工作区中。审阅流程不会改变当前分支、`HEAD` 或暂存区。

## 快速开始

### 环境要求

| 依赖     | 要求                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 操作系统 | macOS 或 Linux                                                             |
| Node.js  | 22.22 或更高版本，包含 npm                                                 |
| Git      | 已安装且可通过 `PATH` 调用；稿件须位于 Git 仓库中                          |
| LaTeX    | TeX Live 或 MacTeX，包含 `latexmk`、`synctex` 以及文档所需的编译引擎和宏包 |
| Agent    | 支持 skills 的 agent，例如 Codex 或 Claude Code                            |

### 安装

使用 [skills CLI](https://skills.sh) 安装，并选择你使用的 agent：

```sh
npx skills add cu1ch3n/latex-review-skill -g
```

也可以手动将此仓库克隆到 agent 的 skills 目录，例如 Codex 的 `~/.agents/skills/latex-review-skill`。

在安装后的 skill 目录中，安装依赖、构建审阅页面并检查环境：

```sh
npm ci
npm run build
node scripts/review.mjs doctor
```

### 发起审阅

在 agent 中打开你的 LaTeX 仓库，然后提出请求：

> 使用 latex-review-skill 精简第 3 节，保留原有技术含义。修改合入稿件之前，让我先审阅。

Agent 会创建任务，在独立工作区中编辑，并发布本地审阅链接。打开链接即可审阅修改。

如果想先用内置示例论文体验流程，可在 skill 目录中运行：

```sh
npm run demo
```

示例使用临时仓库。如果无法自动识别你自己项目的主 `.tex` 文件，可在仓库根目录添加 `.latex-review.json`：

```json
{ "main": "paper/main.tex" }
```

编译引擎、多文件文档和局部编译的设置见[配置参考（英文）](docs/reference.md#configuration)。

## 审阅流程

1. **查看修改。** 阅读 PDF 预览，按需切换到 LaTeX 源文件差异。可以选中文字进行复制，也可以使用 **Copy reference** 一并复制定位信息。
2. **作出决定。** 接受会将修改合入稿件；拒绝会在 agent 的工作区中撤回该修改；评论用于要求进一步修订。**Accept all** 一次接受当前轮次的全部待定修改，已有评论和拒绝决定会保留。一次撤销即可恢复整批修改。
3. **让 agent 继续处理。** 当 agent 正通过 `feedback --wait` 等待时，完成整轮审阅后，你的决定和评论会自动返回给 agent。请保持 agent 会话运行；此机制无法唤醒已结束的会话。
4. **审阅下一轮。** 修订会与对应评论一起显示，未决定的修改会延续到下一轮。完成后仍可查看审阅页面；不再需要预览或撤销时，再让 agent 关闭任务。

你也可以直接告诉 agent **“全部接受”**。它会通过 CLI 批量应用修改，无需打开浏览器逐项点击。

点击 **All reviews** 可打开当前仓库的任务总览，按标题或任务名称搜索，筛选等待审阅的任务，并查看各任务的最新轮次和决定数量。

### 快捷键

| 操作                  | 快捷键                 |
| --------------------- | ---------------------- |
| 接受／拒绝／评论      | `A` / `R` / `C`        |
| 下一项／上一项        | `J` / `K` 或 `→` / `←` |
| 下一项待定修改        | `N`                    |
| 切换 LaTeX 源文件视图 | `S`                    |
| 撤销                  | `U`、`⌘Z` 或 `Ctrl+Z`  |
| 显示快捷键            | `?`                    |

## Agent 接口

浏览器用于用户审阅。Agent 通过 CLI 返回的 JSON 发布修改、查询进度和读取反馈。[SKILL.md（英文）](SKILL.md) 定义了完整工作流。

以下命令在任务工作区中运行；请将路径替换为实际的 skill 安装位置：

```sh
review="/path/to/latex-review-skill/scripts/review.mjs"
node "$review" publish
node "$review" feedback --wait
node "$review" feedback --all
node "$review" status
node "$review" accept --all  # 用户授权全部接受后执行
node "$review" undo
```

`feedback --all` 会重放各轮仍然有效的反馈，包含完整评论和源文件位置，且不会推进反馈读取游标。构建失败时，`feedback --wait` 也会返回，agent 可直接读取诊断信息。批量接受具有原子性：若任何一项写入与你的编辑发生冲突，整批操作都会失败，不会写入部分修改。

创建任务、限定编辑范围和管理本地服务的完整用法见[命令参考（英文）](docs/reference.md#commands)。

## 开发与测试

项目使用 TypeScript 实现：React 和 Vite 构建审阅页面，Fastify 提供本地 API，SQLite 保存审阅状态，MuPDF WebAssembly 负责 PDF 内容提取与矢量渲染。SyncTeX 将源文件修改映射到 PDF 位置。本地服务监听 `127.0.0.1`。

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:browser
npm run test:corpus
```

| 检查                   | 覆盖范围                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `npm run check`        | 类型检查、单元与集成测试、生产构建                                                    |
| `npm run test:browser` | 原生文字选择、剪贴板复制、带定位信息的引用、审阅决定和批量撤销                        |
| `npm run test:corpus`  | 对完整 Raft 博士论文进行两轮审阅，检查源文件与 PDF 的一致性，以及稿件状态是否得到保留 |

回归语料采用 Diego Ongaro 的 [_Consensus: Bridging Theory and Practice_](https://github.com/ongardie/dissertation)，固定上游版本，并依据 CC-BY-4.0 使用。运行需要完整的 TeX 环境和 `rsvg-convert`（macOS 安装 `librsvg`，Linux 安装 `librsvg2-bin`）。

额外的渲染测试覆盖双栏、脚注、连字、对齐公式、删除、重复文本、浮动体、跨页移动、图注、逐字环境空白和跨页表格。CLI 测试覆盖长评论、跨轮反馈历史、撤销和构建失败。语料来源、准备步骤和失败产物见[回归语料文档（英文）](docs/corpus.md)。

提交源文件与 PDF 对齐、反馈传递相关的修复时，请附上对应的回归用例。开发服务器用法和代码结构见[开发参考（英文）](docs/reference.md#development)。

## 文档

- [Agent 指南（英文）](SKILL.md)：任务生命周期与审阅协议。
- [技术参考（英文）](docs/reference.md)：CLI、配置、架构与限制。
- [回归语料（英文）](docs/corpus.md)：上游来源、测试场景与可复现验证。

复制 PDF 文字时会遵循文档的文本提取顺序，不会重建 LaTeX 公式。需要精确的 TeX 时，请使用源文件视图。更多说明见[限制与保证（英文）](docs/reference.md#limits-and-guarantees)。

## 许可证

项目源码采用 [MIT 许可证](LICENSE)。内置字体保留其[上游许可](src/web/fonts/README.md)。外部回归语料遵循其[上游许可与署名要求](docs/corpus.md)。
