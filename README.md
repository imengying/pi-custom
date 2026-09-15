这是为 pi 0.85.1 配置的紧凑显示和执行授权扩展，配合全局 `codex-dark` 主题使用。

配色参考 Codex CLI：正文使用终端默认前景色，思考、输出和底栏使用不同层次的中性灰；边框和标题采用灰白，普通命令使用终端原有背景。用户消息使用浅一层的深灰底色，链接与选中项保留少量蓝青色，状态和修改差异使用红绿配色。暗色差异底色参考 [Codex 的差异渲染](https://github.com/openai/codex/blob/main/codex-rs/tui/src/diff_render.rs)（新增 `#213a2b`、删除 `#4a221d`），整体层次参考其[界面样式](https://github.com/openai/codex/blob/main/codex-rs/tui/src/style.rs)。

斜杠菜单已隐藏 `scoped-models`、`import`、`export`、`share`、`copy`、`hotkeys`、`fork`、`clone`、`trust`、`llama`、`login`、`logout`、`changelog`、`thoughts`、`tree`。其余当前命令的说明已汉化，命令名称保持原来的输入形式。这是通过公开补全接口进行的菜单精简；直接输入原命令仍可使用，Pi 的更新机制和项目授权检查照常运行。

界面还通过 pi 的全局配置精简：`quietStartup: true` 隐藏启动提示，`collapseChangelog: true` 收起更新日志，`enableSkillCommands: false` 关闭技能快捷菜单。技能仍可按需使用，更新检查照常运行。

- 思考生成时只显示最近两行，内容持续刷新；生成结束后显示一行摘要。原始思考保留在会话中，输入 `/thoughts` 可以在独立的只读窗口查看，不会铺满聊天记录。全局 `hideThinkingBlock` 需为 `false`，由显示转换器控制预览。
- AI 命令输出默认显示末尾 5 个屏幕行，多行命令本身也收成一行标题。`Ctrl+O` 展开或收起完整输出，新一轮任务重新收起。手动 `!` / `!!` 命令继续使用 pi 原生的有限预览（最多 20 行），同样经过授权检查。
- 文件修改显示红底删除、绿底新增、行号和增删统计，默认最多预览 14 行；大量替换时会同时展示旧内容和新内容。新建文件显示为新增，覆盖文件显示实际前后差异。过大的覆盖写入省略差异计算，以免界面卡顿。
- 底栏显示 `↑ 175k   ↓ 174k   󱘲 99.5%   17.3k/1.0M`，依次为累计输入、累计输出、最近一次请求的缓存命中率、当前上下文 token 数与容量。图标与数值间留一个空格，各项间用三个空格分隔。缓存使用 Nerd Fonts 的数据库轮廓图标（U+F1632），不再显示竖线、R/W 累计量、CH 标签或 `(auto)`；模型名前不显示 `(work)` 等提供商前缀。上下文数值由 pi 实际统计，压缩后暂不可知时显示 `?`，超过容量 70% / 90% 时保留警告色 / 错误色。目录、Git 分支、会话名和思考等级继续显示。
- 授权面板固定在终端底部，使用完整底色和醒目边框，优先展示完整操作，再显示原因、工作目录；文件操作还显示解析符号链接后的实际目标。默认选中“允许本次操作”，`↑↓` / `Tab` 切换选项，`Enter` 确认；`a` / `1` 允许本次，`Esc` / `2` / `n` 拒绝。`Page Up` / `Page Down`、`j` / `k`、`Home` / `End` 滚动详情，选项始终可见。等待确认没有超时，命令执行超时从批准后开始计算；任务取消或会话结束仍会撤销待处理授权，没有永久放行前缀。

简单的字面量只读命令可以自动执行；目录内普通文件的 `edit` / `write` 也可自动执行。删除、提权、Git 写操作、网络传输、脚本、重定向、变量或命令替换、未知选项、自定义工具，以及目录外或受保护路径的写入均需要授权。简单只读命令会改用系统可执行文件；Git 只读命令另外禁用外部 diff、textconv、pager、fsmonitor 和 hooks。修改审批参数或符号链接目标后会重新检查。无交互界面、取消、检查失败时，需要授权的操作会被阻止。

输入 `/permissions` 可查看当前规则。这里实现的是 pi 执行入口的审批层，系统级沙箱没有由此扩展启用。已授权脚本的内部行为、已有 shell/Git 配置，以及其他扩展直接运行的代码仍依赖 pi 本身和本机环境；不能将它作为不可信代码的隔离边界。OpenAI 官方文档也将[审批策略和系统沙箱](https://developers.openai.com/codex/cli/reference/)列为不同控制项。

代码入口是 `extensions/compact-workflow/index.ts`，使用 pi 的公开扩展 API。`policy.ts` 负责权限分类，`guard.ts` 负责逐次授权，`ui.ts` 和 `renderers.ts` 负责预览、查看窗口和红绿差异，`compact-footer.ts` 负责底栏显示。

开发验证：

```sh
bun install --ignore-scripts
bun run typecheck
bun test
```

安装目录为 `~/.pi/agent/extensions/compact-workflow/`。测试依赖仅位于本项目的 `node_modules`，扩展运行时复用 pi 提供的模块。将扩展目录中的所有 `.ts` 文件复制到全局扩展目录，将 `themes/codex-dark.json` 复制到 `~/.pi/agent/themes/`，在全局设置中选择 `theme: "codex-dark"`，并保持 `hideThinkingBlock: false`。已打开的 pi 可执行 `/reload`，重启也会自动加载。历史配置备份已按要求清理，后续安装不自动生成新备份。

若要撤回扩展，可将 `~/.pi/agent/extensions/compact-workflow/` 移到 extensions 目录之外后重启；主题与启动界面的偏好可通过 pi 的设置菜单或 `~/.pi/agent/settings.json` 单独调整。
