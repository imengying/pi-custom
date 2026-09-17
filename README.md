# pi 紧凑显示与执行授权扩展

为 pi 0.85.1 准备的扩展，配合 `codex-dark` 主题使用。它做两件事：让聊天记录更紧凑，以及让每个有风险的操作在执行前先问你。

## 界面

- **思考**：生成时只显示最近两行并持续刷新，结束后收成一行「思考完成」。原始内容仍保存在会话里，用 `/thoughts` 可在独立只读窗口查看，不会铺满聊天记录。需要全局设置 `hideThinkingBlock: false`。
- **命令输出**：默认显示末尾 5 行，多行命令本身也缩成一行标题。`Ctrl+O` 展开或收起，新一轮任务自动收起。手动 `!` / `!!` 命令沿用 pi 原生预览（最多 20 行），同样经过授权检查。
- **文件修改**：红底删除、绿底新增，带行号和增删统计，默认预览 14 行；大段替换会同时展示新旧内容。新建文件算新增，覆盖文件显示实际差异；过大的写入跳过差异计算以免卡顿。
- **底栏**：`↑ 175k   ↓ 174k   󱘲 99.5%   17.3k/1M`，依次是累计输入、累计输出、最近一次请求的缓存命中率、当前上下文 token 数与容量。缓存图标是 Nerd Fonts 的数据库轮廓（U+F1632）。上下文超过容量 70% / 90% 时显示警告色 / 错误色，压缩后暂不可知时显示 `?`。token 数按 k / M 缩放并保留一位小数，整数结果不带小数点（`256k`、`1M`，而不是 `256.0k`、`1.0M`）。
- **底栏配色**：按 codex 的语义规则区分字段，而不是整行一个颜色——用量三项（↑ ↓ 缓存）用绿色，路径用绿色，Git 分支用品红，模型名用强调色，会话名和括号用中灰/暗灰。上下文数字平时中灰，超过 70% / 90% 转警告色 / 错误色。
- **斜杠菜单**：隐藏了 `scoped-models`、`import`、`export`、`share`、`copy`、`hotkeys`、`fork`、`clone`、`trust`、`llama`、`login`、`logout`、`changelog`、`thoughts`、`tree`、`permissions`，其余说明已汉化。直接输入原命令仍然可用。

## 授权

需要授权的操作会在终端底部贴底显示一条全宽面板（不是居中的悬浮窗），与聊天内容用一条细分隔线分开；标题行的短标签（如「· 删除」「· 凭据」「· 目录外」）说明触发规则，正文原文显示命令或参数，默认选中「允许本次操作」——面板总高度不变，标签只是让标题自带原因。

- `↑↓` / `Tab` 切换选项，`Enter` 确认
- `a` / `1` 允许本次，`Esc` / `2` / `n` 拒绝
- `Page Up` / `Page Down`、`j` / `k`、`Home` / `End` 滚动长命令
- 等待确认没有超时；命令超时从批准后开始计算，显示的耗时也只统计命令本身的运行时间
- 授权只对当次操作有效，没有永久放行前缀；取消任务或结束会话会撤销待处理授权

面板使用终端自身的深色背景，正文为中灰（`muted`），标题与两个选项用强调色 `accent`；选中项额外加粗并带高亮底色与 `›` 标记。金色 `warning` 保留给底栏的上下文告警。

命令标题遵循 codex 的配色：`$` 提示符用品红（`bashPrompt`），命令本体按 shell 语法高亮（`highlightCode`），✓ / ✗ 用绿 / 红并加粗，耗时和收起的行数用中灰。文件工具的路径用强调色。语法高亮只影响显示，去掉转义后与原始命令逐字一致。

### 自动执行

- 简单的字面量只读命令（`ls`、`cat`、`grep`、`git status`、`sed -n '1p'` 等）
- 当前目录内普通文件的 `edit` / `write`

### 需要授权

- 删除、提权、Git 写操作、网络传输、脚本、重定向、变量或命令替换、未知选项、自定义工具
- 目录外或受保护路径的写入
- 凭据与敏感配置：`.env*`、`.ssh`、`.gnupg`、`.aws`、`.kube`、`.netrc`、`.git-credentials`、`.npmrc`、`.pypirc`、`.gitconfig`、`.bash_history`、`.pgpass`、`~/.config/gh`、`~/.config/gcloud`、`~/.docker` 等目录与文件，以及 `id_rsa`、`credentials.json`、`service-account*.json`、`*.pem`、`*.key` 一类名称
- 代理工具自己的凭据：`~/.pi`（`auth.json`、存有 `apiKey` 的 `models.json`）、`~/.codex`、`~/.claude`、`~/.claude.json`、`~/.gemini`、`~/.continue`、`~/.aider`，以及 `~/.local/share/keyrings` 下的 `login.keyring`、`auth.json`、`token.json`、`oauth*creds.json`

检查逐个参数进行，包括选项值：`--file=...` 和 `-fFILE` 两种写法都会拆出被指向的路径（`-nfFILE` 按 `-n -f FILE` 理解），所以 `grep -f ~/.ssh/id_rsa x`、`grep -r KEY .ssh`、`cat id_rsa` 都会先询问；`echo`、`printf` 等以数据为参数的命令不参与路径检查。只有家目录下的文件才套用 `auth.json`、`credentials*` 这类通用名字，免得误伤项目里的同名文件。

自动放行的只读命令会改用系统可执行文件执行，Git 只读命令额外禁用外部 diff、textconv、pager、fsmonitor 和 hooks。改过参数或符号链接目标后会重新检查；没有交互界面、被取消或检查失败时，需要授权的操作不会执行。被拒绝时完整原因会回传（如「未获得用户授权，操作未执行（目标涉及凭据或敏感配置）」），模型不必重试同一条命令。

手动 `!` / `!!` 命令每一条只弹一次面板；只有其他扩展改写了待执行的命令时才会重新询问。设置了 `shellCommandPrefix` 时前缀照旧生效，也不会因此多问一次。

输入 `/permissions` 可以随时查看当前规则。

## 使用 zsh

pi 在 Unix 上固定用 `/bin/bash`，不读取 `$SHELL`。想让命令真正跑在 zsh 里，需要在 `~/.pi/agent/settings.json` 指定：

```json
{ "shellPath": "/usr/bin/zsh" }
```

设置后扩展会切换到 zsh 并同步启动它执行命令（`bash` 是 pi 固定使用的工具名，与是否装了 bash 无关）。zsh 比 bash 多一类 `=命令` 展开（`=ls` → `/usr/bin/ls`），会被单引号阻止，因此这种写法改为请求授权；源码里已经用引号或反斜杠保护的写法（`'=ls'`、`"=ls"`、`\=ls`）在 zsh 下本来就是字面量，照常自动执行。`~+` / `~-` 这类目录栈路径也会询问。未设置 `shellPath` 时行为与之前一致。

## 安装

推荐用 pi 直接安装（仓库已带 `pi` 清单）：

```sh
pi install /绝对路径/pi-custom      # 也支持 git:github.com/imengying/pi-custom
```

随后在 `~/.pi/agent/settings.json` 中设置：

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

手动安装（不经过 pi）：把 `extensions/compact-workflow/` 下的所有 `.ts` 文件复制到 `~/.pi/agent/extensions/compact-workflow/`，把 `themes/codex-dark.json` 复制到 `~/.pi/agent/themes/`，同样设置上面两项。

注意：`~/.pi/agent/extensions/` 是 pi 的全局自动发现目录，两种方式不要同时用。两份同名扩展会互相冲突（报 `Tool "bash" conflicts with ...`），而且先加载的那份会遮住另一份——手工复制的副本不会随仓库更新，安全修复会悄悄失效。

卸载：`pi remove /路径/pi-custom`；手动安装的则把 `~/.pi/agent/extensions/compact-workflow/` 移出 extensions 目录后重启，主题和启动偏好可在设置菜单中单独调整。

## 边界

这里实现的是 pi 执行入口的审批层，不启用系统级沙箱。已授权脚本的内部行为、你已有的 shell / Git 配置，以及其他扩展直接运行的代码，都仍受 pi 本身和本机环境约束——它不能当作运行不可信代码的隔离边界。OpenAI 官方文档也把[审批策略和系统沙箱](https://developers.openai.com/codex/cli/reference/)列为两项独立控制。

只读工具（`read`、`grep`、`find`、`ls`）没有接管，所以模型仍可直接读敏感文件，只有 `bash` 侧会拦住。若要真正限制读取范围，需要 pi 本身的沙箱或权限机制。非交互模式（无 UI）下需要授权的写操作会直接失败，不会静默放行。

## 开发

```sh
bun install --ignore-scripts
bun run typecheck   # extensions/ 与 tests/ 一起检查
bun test
```

开发环境为 bun 1.4.x、TypeScript 7.0.2、Node 类型 24。代码入口是 `extensions/compact-workflow/index.ts`，只使用 pi 的公开扩展 API。`policy.ts` 负责权限分类，`guard.ts` 负责逐次授权，`ui.ts` 与 `renderers.ts` 负责预览、查看窗口和红绿差异，`compact-footer.ts` 负责底栏。`colors.ts` 集中处理主题中没有的类型角色。

测试的运行时依赖仅位于本项目的 `node_modules`，扩展运行时复用 pi 提供的模块。其中 `tests/upstream.test.ts` 单独锚定三处上游 `dist/` 内部路径：pi 升级若挪动它们，会在这里给出明确失败，而不是在别的测试里报一句“找不到模块”。
