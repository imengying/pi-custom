import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface Assessment {
  approval: boolean;
  reasons: string[];
  /** Only simple, vetted read commands are rewritten to trusted executables. */
  safeCommand?: string;
}

const ask = (reason: string): Assessment => ({ approval: true, reasons: [reason] });
const allow = (): Assessment => ({ approval: false, reasons: [] });

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Resolve even a missing target through existing or dangling symlink parents. */
export function canonicalPath(path: string, depth = 0): string {
  if (depth > 80) throw new Error("路径或符号链接层级过深");
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      if (lstatSync(absolute).isSymbolicLink()) {
        return canonicalPath(resolve(dirname(absolute), readlinkSync(absolute)), depth + 1);
      }
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException).code !== "ENOENT") throw linkError;
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(canonicalPath(parent, depth + 1), basename(absolute));
  }
}

/** Match pi's native write/edit path normalization, including file: URLs and @. */
export function resolveToolPath(input: string, cwd: string): string {
  let path = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ");
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  return resolve(cwd, path);
}

function inside(path: string, root: string): boolean {
  const local = relative(root, path);
  return local === "" || (!local.startsWith(".." + sep) && local !== ".." && !isAbsolute(local));
}

function sensitive(path: string): boolean {
  const segments = path.split(sep);
  return segments.some((part) => [".ssh", ".gnupg", ".aws", ".kube"].includes(part)) ||
    /^\.env(?:$|\.)/.test(basename(path)) ||
    /(?:^|\/)(?:shadow|gshadow)$/.test(path) ||
    /\/(?:\.pi|\.codex)\/.*(?:auth|models|credentials).*\.json$/.test(path) ||
    /\/proc\/(?:self|\d+)\/(?:environ|mem)$/.test(path);
}

export function assessPath(operation: "read" | "write", input: unknown, cwd: string): Assessment {
  if (typeof input !== "string" || !input || input.includes("\0")) return ask("无法确认目标路径");
  try {
    const original = resolveToolPath(input, cwd);
    const target = canonicalPath(original);
    if (sensitive(original) || sensitive(target)) return ask("目标涉及凭据或敏感配置");
    if (operation === "read") return allow();
    const root = canonicalPath(cwd);
    if (!inside(target, root)) return ask("目标位于当前工作目录之外（已解析符号链接）");
    if ([original, target].some((path) =>
      path.split(sep).some((part) => [".git", ".pi", ".codex", ".agents"].includes(part)) ||
      basename(path) === "AGENTS.md"
    )) return ask("目标涉及 Git 元数据、代理配置或权限规则");
    try {
      if (lstatSync(target).nlink > 1) return ask("目标存在硬链接，写入可能影响其他路径");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return allow();
  } catch {
    return ask("目标路径无法可靠解析，需要人工确认");
  }
}

interface Segment { words: string[]; operator?: string }

/**
 * Intentionally recognize a small literal-shell subset, not an entire shell.
 * Expansions, redirects, background jobs, scripts and unsupported syntax ASK.
 * Nothing unrecognized is ever assumed safe.
 */
export function parseLiteralCommands(command: string): Segment[] | string {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  const flushWord = () => {
    if (started) words.push(word);
    word = "";
    started = false;
  };
  const flushSegment = (operator?: string) => {
    flushWord();
    if (!words.length) return false;
    segments.push({ words, operator });
    words = [];
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "\0" || /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(char)) {
      return "命令含控制字符";
    }
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
      continue;
    }
    if (char === "$" || char.charCodeAt(0) === 96) return "命令含变量、替换或动态 shell 表达式";
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\") {
        const next = command[++i];
        if (next === undefined) return "命令转义不完整";
        if (next !== "\n") word += ['"', "\\", "$"].includes(next) || next.charCodeAt(0) === 96 ? next : "\\" + next;
      } else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\") {
      const next = command[++i];
      if (next === undefined) return "命令转义不完整";
      if (next !== "\n") { word += next; started = true; }
    } else if (char === "#" && !started) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
    } else if (char === " " || char === "\t" || char === "\r") {
      flushWord();
    } else if (char === "\n" || char === ";" || char === "|" || char === "&") {
      let operator = char === "\n" ? ";" : char;
      if ((char === "|" || char === "&") && command[i + 1] === char) { operator += char; i++; }
      if (operator === "&") return "后台命令需要确认";
      if (!flushSegment(operator) && (char !== "\n" || !segments.length)) return "无法可靠解析复合命令";
    } else if ("<>(){}*?[]".includes(char)) {
      return "<>".includes(char) ? "重定向可能写入文件或执行脚本" : "通配符或复合 shell 语法需要确认";
    } else {
      started = true;
      word += char;
    }
  }
  if (quote) return "命令引号未闭合";
  const hadFinalCommand = flushSegment();
  if (!hadFinalCommand && segments.length && segments.at(-1)?.operator !== ";") return "复合命令不完整";
  if (segments.length) segments[segments.length - 1].operator = undefined;
  return segments;
}

const READ_COMMANDS = new Set([
  "pwd", "ls", "cat", "head", "tail", "wc", "stat", "readlink", "realpath",
  "printf", "echo", "true", "false", "cut", "tr", "du", "df", "uname",
  "rg", "grep", "find", "sort", "file", "sed", "git",
]);

function trustedExecutable(command: string): string | undefined {
  const name = basename(command);
  if (!READ_COMMANDS.has(name)) return undefined;
  for (const candidate of command.includes("/") ? [command] : ["/usr/bin/" + name, "/bin/" + name]) {
    if (!isAbsolute(candidate)) continue;
    try {
      const path = realpathSync(candidate);
      if (!["/usr/bin", "/bin"].includes(dirname(path))) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch { /* An unavailable executable is not auto-approved. */ }
  }
  return undefined;
}

function commandReason(name: string): string {
  if (["rm", "rmdir", "unlink", "shred", "wipe"].includes(name)) return "命令会删除文件，需要确认目标";
  if (["sudo", "su", "doas", "pkexec", "runuser"].includes(name)) return "命令会提升权限或切换用户";
  if (/^(?:mkfs|fsck)(?:\.|$)/.test(name) || ["dd", "fdisk", "parted", "mount", "umount", "reboot", "shutdown"].includes(name)) {
    return "命令可能修改磁盘、挂载或系统状态";
  }
  if (["git", "gh"].includes(name)) return "Git 写操作、发布或自定义配置需要确认";
  if (["curl", "wget", "ssh", "scp", "rsync"].includes(name)) return "网络传输或远程命令需要确认";
  if (["bash", "sh", "zsh", "fish", "python", "python3", "node", "bun", "deno", "perl", "ruby", "awk", "eval", "source"].includes(name)) {
    return "脚本可执行任意操作，需先查看完整命令";
  }
  return "该命令不在已验证的简单只读命令范围内";
}

function knownOptions(args: string[], longFlags: string, short: RegExp): boolean {
  const known = new Set(longFlags.split(" "));
  for (const arg of args) {
    if (arg === "--") break;
    if (arg.startsWith("--") && !known.has(arg.split("=")[0])) return false;
    if (arg.startsWith("-") && !arg.startsWith("--") && arg !== "-" && !short.test(arg)) return false;
  }
  return true;
}

function vetSegment(words: string[], cwd: string): Assessment & { words?: string[] } {
  const [command, ...args] = words;
  const name = basename(command);
  if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(command)) return ask("环境变量赋值可能改变命令的执行方式");
  const executable = trustedExecutable(command);
  if (!executable) return ask(commandReason(name));
  // Vetted read operations must not sneak in subcommands or output-file flags.
  if (name === "rg" && args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) {
    return ask("搜索参数会启动外部程序");
  }
  if (name === "find" && args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg))) {
    return ask("find 参数会执行命令、删除或写入文件");
  }
  if (name === "sort" && args.some((arg) => /^--(?:output|compress-program)(?:=|$)/.test(arg) || /^-[^-]*o/.test(arg))) {
    return ask("sort 参数会写入文件或执行外部程序");
  }
  if (name === "file" && args.some((arg) => /^--uncompress/.test(arg) || /^-[^-]*[zZ]/.test(arg))) {
    return ask("file 解压参数可能调用外部程序");
  }
  // Reject unknown and abbreviated options as well: GNU --out can mean --output.
  if (name === "sort" && !knownOptions(args,
    "--numeric-sort --general-numeric-sort --human-numeric-sort --version-sort --reverse --unique --stable " +
    "--ignore-case --ignore-leading-blanks --field-separator --key --check --help --version",
    /^-[nNgGhHrVuMsbfcdm]+$|^-[kt].*$/,
  )) return ask("sort 参数未被确认为只读");
  if (name === "file" && !knownOptions(args,
    "--brief --mime --mime-type --mime-encoding --dereference --separator --keep-going --version --help",
    /^-[bikLNprsv0]+$/,
  )) return ask("file 参数未被确认为只读");
  if (name === "rg" && !knownOptions(args,
    "--files --hidden --no-ignore --no-ignore-vcs --no-ignore-parent --no-ignore-global --glob --iglob --type " +
    "--type-not --type-list --line-number --no-line-number --count --count-matches --with-filename --no-filename " +
    "--ignore-case --smart-case --case-sensitive --fixed-strings --word-regexp --line-regexp --invert-match " +
    "--max-count --max-depth --max-filesize --context --before-context --after-context --color --colors " +
    "--heading --no-heading --sort --sortr --stats --json --only-matching --replace --trim --pcre2 " +
    "--multiline --multiline-dotall --follow --files-without-match --files-with-matches --null --null-data " +
    "--text --regexp --file --quiet --encoding --no-messages --version --help --crlf",
    /^-[nHhIilLovswxUaFcqSPz0u]+$|^-[egftTrABCm].*$/,
  )) return ask("rg 参数未被确认为只读");
  if (name === "find") {
    const known = new Set(("-name -iname -path -ipath -regex -iregex -type -maxdepth -mindepth -print -print0 " +
      "-ls -empty -size -mtime -mmin -atime -amin -ctime -cmin -newer -anewer -cnewer -user -group " +
      "-perm -a -and -o -or -not -true -false -readable -writable -executable -P -H -L").split(" "));
    if (args.some((arg) => arg.startsWith("-") && !known.has(arg) && !/^-\d+$/.test(arg))) {
      return ask("find 参数未被确认为只读");
    }
  }
  if (name === "sed") {
    const rest = args[0] === "-n" ? args.slice(1) : args;
    if (!/^(?:\d+(?:,(?:\d+|\$))?|\$)?p$/.test(rest[0] ?? "") ||
        rest.slice(1).some((arg) => arg.startsWith("-"))) {
      return ask("只自动放行 sed 的行范围打印；编辑、脚本及其他参数需要确认");
    }
  }
  // Check literal path arguments too; shell code is not used to resolve them.
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (arg.includes("/") || arg.startsWith(".env") || arg === "~") {
      const decision = assessPath("read", arg, cwd);
      if (decision.approval) return decision;
    }
  }
  if (name === "git") {
    const [subcommand, ...options] = args;
    if (!["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree"].includes(subcommand)) {
      return ask(commandReason("git"));
    }
    if (options.some((arg) =>
      /^--(?:ext-diff|textconv|output|config-env|exec-path)(?:=|$)/.test(arg) ||
      /^-c(?:$|[^-])/.test(arg) || /^-O/.test(arg) || /%G/.test(arg)
    )) return ask("Git 参数可能执行外部程序或写入文件");
    if (!knownOptions(options,
      "--stat --shortstat --numstat --name-only --name-status --check --summary --cached --staged --no-index " +
      "--patch --no-patch --color --no-color --word-diff --word-diff-regex --ignore-space-at-eol --ignore-space-change " +
      "--ignore-all-space --ignore-blank-lines --exit-code --quiet --no-ext-diff --no-textconv --unified " +
      "--oneline --decorate --graph --all --branches --tags --remotes --max-count --pretty --format --since --until " +
      "--author --committer --grep --date --abbrev-commit --reverse --first-parent --follow --no-merges --merges " +
      "--short --porcelain --branch --untracked-files --ignored --ignore-submodules --show-toplevel --git-dir " +
      "--absolute-git-dir --show-prefix --is-inside-work-tree --verify --abbrev-ref --symbolic-full-name --sq " +
      "--end-of-options --git-path --stage --deleted --modified --others --exclude-standard --error-unmatch " +
      "--full-name --eol --long --full-tree --object-only",
      /^-(?:\d+|n\d*|[pswbrzR]+|U\d*|M\d*|C\d*|S.*|G.*)$/,
    )) return ask("Git 参数未被确认为只读");
    const safeOptions = ["diff", "log", "show"].includes(subcommand)
      ? ["--no-ext-diff", "--no-textconv", ...options] : options;
    return {
      ...allow(),
      words: [executable, "--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false",
        "-c", "core.hooksPath=/dev/null", subcommand, ...safeOptions],
    };
  }
  return { ...allow(), words: [executable, ...args] };
}

export function assessCommand(command: unknown, cwd: string): Assessment {
  if (typeof command !== "string" || !command.trim()) return ask("命令为空或格式不正确");
  if (command.length > 128 * 1024) return ask("命令过长，无法自动判断");
  const parsed = parseLiteralCommands(command);
  if (typeof parsed === "string") return ask(parsed);
  if (!parsed.length) return ask("未找到可执行命令");
  const normalized: string[] = [];
  for (const segment of parsed) {
    const decision = vetSegment(segment.words, cwd);
    if (decision.approval) return decision;
    normalized.push((decision.words ?? segment.words).map(shellQuote).join(" "));
    if (segment.operator) normalized.push(segment.operator);
  }
  return { ...allow(), safeCommand: normalized.join(" ") };
}

export function assessTool(name: string, input: Record<string, unknown>, cwd: string): Assessment {
  if (name === "bash") return assessCommand(input.command, cwd);
  if (name === "powershell") return ask("PowerShell 脚本需要人工确认");
  if (name === "write" || name === "edit") return assessPath("write", input.path ?? input.file_path, cwd);
  if (["read", "grep", "find", "ls"].includes(name)) return assessPath("read", input.path ?? cwd, cwd);
  return ask("自定义工具尚未归类，需要确认其操作");
}
