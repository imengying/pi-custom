# pi 紧凑显示与执行授权扩展

为 pi 0.85.1 准备的扩展，配合 `codex-dark` 主题使用。它做两件事：让聊天记录更紧凑，以及让每个有风险的操作在执行前先问你。

## 界面

- **思考**：生成时只显示最近两行并持续刷新，结束后收成一行「思考完成」。原始内容仍保存在会话里，用 `/thoughts` 可在独立只读窗口查看，不会铺满聊天记录。需要全局设置 `hideThinkingBlock: false`。
- **命令输出**：默认显示末尾 5 行，多行命令本身也缩成一行标题。`Ctrl+O` 展开或收起，新一轮任务自动收起。手动 `!` / `!!` 命令沿用 pi 原生预览（最多 20 行），同样经过授权检查。
- **文件修改**：红底删除、绿底新增，带行号和增删统计，默认预览 14 行；大段替换会同时展示新旧内容。新建文件算新增，覆盖文件显示实际差异；过大的写入跳过差异计算以免卡顿。
- **底栏**：`↑ 175k   ↓ 174k   󱘲 99.5%   17.3k/1.0M`，依次是累计输入、累计输出、最近一次请求的缓存命中率、当前上下文 token 数与容量。缓存图标是 Nerd Fonts 的数据库轮廓（U+F1632）。上下文超过容量 70% / 90% 时显示警告色 / 错误色，压缩后暂不可知时显示 `?`。目录、Git 分支、会话名和思考等级照常显示。
- **压缩提示**：不显示 pi 启动时的 `Session compacted N times` 一行；压缩摘要本身仍然照常显示。
- **斜杠菜单**：隐藏了 `scoped-models`、`import`、`export`、`share`、`copy`、`hotkeys`、`fork`、`clone`、`trust`、`llama`、`login`、`logout`、`changelog`、`thoughts`、`tree`，其余说明已汉化。直接输入原命令仍然可用。

## 授权

需要授权的操作会在终端底部贴底显示一条全宽面板（不是居中的悬浮窗），与聊天内容用一条细分隔线分开；标题标明工具名，正文原文显示命令或参数，默认选中「允许本次操作」。

- `↑↓` / `Tab` 切换选项，`Enter` 确认
- `a` / `1` 允许本次，`Esc` / `2` / `n` 拒绝
- `Page Up` / `Page Down`、`j` / `k`、`Home` / `End` 滚动长命令
- 等待确认没有超时；命令超时从批准后开始计算，显示的耗时也只统计命令本身的运行时间
- 授权只对当次操作有效，没有永久放行前缀；取消任务或结束会话会撤销待处理授权

面板使用终端自身的深色背景，正文为中灰（`muted`），标题与两个选项用强调色 `accent`；选中项额外加粗并带高亮底色与 `›` 标记。金色 `warning` 保留给底栏的上下文告警。

### 自动执行

- 简单的字面量只读命令（`ls`、`cat`、`grep`、`git status`、`sed -n '1p'` 等）
- 当前目录内普通文件的 `edit` / `write`

### 需要授权

- 删除、提权、Git 写操作、网络传输、脚本、重定向、变量或命令替换、未知选项、自定义工具
- 目录外或受保护路径的写入
- 凭据与敏感配置：`.env*`、`.ssh`、`.gnupg`、`.aws`、`.kube`、`.netrc`、`.git-credentials`、`.npmrc`、`.pypirc`、`.gitconfig`、`.bash_history`、`.pgpass`、`~/.config/gh`、`~/.config/gcloud`、`~/.docker` 等目录与文件，以及 `id_rsa`、`credentials.json`、`service-account*.json`、`*.pem`、`*.key` 一类名称

检查逐个参数进行（包括 `--file=...` 这类选项值），所以 `grep -r KEY .ssh` 和 `cat id_rsa` 也会先询问；`echo`、`printf` 等以数据为参数的命令不参与路径检查。

自动放行的只读命令会改用系统可执行文件执行，Git 只读命令额外禁用外部 diff、textconv、pager、fsmonitor 和 hooks。改过参数或符号链接目标后会重新检查；没有交互界面、被取消或检查失败时，需要授权的操作不会执行。

输入 `/permissions` 可以随时查看当前规则。

## 使用 zsh

pi 在 Unix 上固定用 `/bin/bash`，不读取 `$SHELL`。想让命令真正跑在 zsh 里，需要在 `~/.pi/agent/settings.json` 指定：

```json
{ "shellPath": "/usr/bin/zsh" }
```

设置后扩展会切换到 zsh 并同步启动它执行命令（`bash` 是 pi 固定使用的工具名，与是否装了 bash 无关）。zsh 比 bash 多一类 `=命令` 展开（`=ls` → `/usr/bin/ls`），会被单引号阻止，因此这种写法改为请求授权；源码里已经用引号或反斜杠保护的写法（`'=ls'`、`"=ls"`、`\=ls`）在 zsh 下本来就是字面量，照常自动执行。`~+` / `~-` 这类目录栈路径也会询问。未设置 `shellPath` 时行为与之前一致。

## 安装

1. 把 `extensions/compact-workflow/` 下的所有 `.ts` 文件复制到 `~/.pi/agent/extensions/compact-workflow/`
2. 把 `themes/codex-dark.json` 复制到 `~/.pi/agent/themes/`
3. 在 `~/.pi/agent/settings.json` 中设置：

```json
{
  "theme": "codex-dark",
  "hideThinkingBlock": false,
  "quietStartup": true,
  "collapseChangelog": true,
  "enableSkillCommands": false
}
```

前两项是扩展运行所必需的；后三项用于精简启动界面，可选。已打开的 pi 执行 `/reload` 即可生效，重启也会自动加载。

卸载：把 `~/.pi/agent/extensions/compact-workflow/` 移出 extensions 目录后重启，主题和启动偏好可在设置菜单中单独调整。

## 边界

这里实现的是 pi 执行入口的审批层，不启用系统级沙箱。已授权脚本的内部行为、你已有的 shell / Git 配置，以及其他扩展直接运行的代码，都仍受 pi 本身和本机环境约束——它不能当作运行不可信代码的隔离边界。OpenAI 官方文档也把[审批策略和系统沙箱](https://developers.openai.com/codex/cli/reference/)列为两项独立控制。

## 开发

```sh
bun install --ignore-scripts
bun run typecheck
bun test
```

开发环境为 bun 1.4.0、TypeScript 7.0.2、Node 类型 24。代码入口是 `extensions/compact-workflow/index.ts`，只使用 pi 的公开扩展 API。`policy.ts` 负责权限分类，`guard.ts` 负责逐次授权，`ui.ts` 与 `renderers.ts` 负责预览、查看窗口和红绿差异，`compact-footer.ts` 负责底栏，`transcript.ts` 负责去掉 pi 的压缩提示行（唯一一处触碰 pi 内部组件树的地方，失败时只退化为提示行照常显示）。测试依赖仅位于本项目的 `node_modules`，扩展运行时复用 pi 提供的模块。
