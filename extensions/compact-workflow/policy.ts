import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface Assessment {
  approval: boolean;
  reasons: string[];
  /**
   * Two to four characters naming the rule that asked, shown on the dialog's existing
   * title row. The full `reason` is too long to fit there without adding a line, and
   * the panel is deliberately kept to a fixed height, so the tag carries the gist and
   * `reason` is what the model is told.
   */
  tag?: string;
  /** Only simple, vetted read commands are rewritten to trusted executables. */
  safeCommand?: string;
}

/**
 * The shell dialect used for the rewrite. Quoting is shared by bash and zsh, but zsh
 * performs expansions bash does not, and unquoted ones (`=cmd`, `~+`) survive the
 * plain single quotes this file emits. Those constructs are refused explicitly when
 * zsh is the shell that will run the rewrite. See `zshRewriteRisk` for why `^foo` is
 * not treated the same way.
 */
export type ShellDialect = "bash" | "zsh";

/**
 * Ask for approval.
 *
 * `tag` is what the panel shows on its title row and has to stay a couple of characters
 * long, so every call site passes its own: a default derived from the sentence would cut
 * a word in half at whatever column four happens to land on. The fallback exists only so
 * a future call site that forgets one still compiles and still shows something readable.
 */
const ask = (reason: string, tag = "需确认"): Assessment => ({ approval: true, reasons: [reason], tag });
const allow = (): Assessment => ({ approval: false, reasons: [] });

/** The shell that will run rewritten commands, resolved once per pi process. */
let dialect: ShellDialect = "bash";
let shellPath: string | undefined;

export function setShellDialect(next: ShellDialect, path?: string): void {
  dialect = next;
  shellPath = path;
}

export function currentShellDialect(): ShellDialect {
  return dialect;
}

/**
 * The configured `shellPath`, or undefined when pi falls back to its built-in default.
 * Surfaced in the approval title because pi names the tool `bash` on every platform,
 * which otherwise hides whether zsh or bash will actually run the command.
 */
export function currentShellPath(): string | undefined {
  return shellPath;
}

export function dialectForShellPath(shellPath: string | undefined): ShellDialect {
  return shellPath && /(?:^|[\\/])zsh(?:\.exe)?$/i.test(shellPath) ? "zsh" : "bash";
}

function shellQuote(value: string): string {
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

const SENSITIVE_DIRS = new Set([".ssh", ".gnupg", ".aws", ".kube"]);
/** Extra directories that count only under the user's home directory. */
const HOME_DIRS = new Set([".docker", ".azure", ".gcloud"]);
/**
 * Multi-segment credential locations relative to the home directory.
 * The agent harnesses are listed too: pi keeps provider keys in `~/.pi/agent/auth.json`
 * and `~/.pi/agent/models.json` (its `models.json` stores `apiKey` verbatim), and codex,
 * Claude Code and Gemini keep the same kind of live secret under their own directories.
 * Reading one of these hands out a working credential, so they ask like any other.
 */
const HOME_PATHS = new Set([
  ".config/gh", ".config/gcloud", ".config/glab-cli", ".config/hub", ".config/doctl",
  ".pi", ".codex", ".claude", ".gemini", ".continue", ".aider",
]);
/**
 * Secret-bearing basenames that are only meaningful outside a project checkout.
 * A repository may legitimately contain a fixture called `auth.json` or `credentials`, so
 * these are checked solely below the home directory; npm's own `~/.npmrc` rule already
 * covers the generic config case. `age` and `keyring` files are named here because their
 * contents decrypt rather than merely configure.
 */
const HOME_NAME = /^(?:\.claude\.json|\.aider\.conf\.yml|auth\.json|oauth[_-]?creds?\.json|credentials(?:\.json|db)?|token\.json|login\.keyring|keyring\.[a-z0-9]+)$/i;
/** Credential-like names, matched on the basename anywhere: a directory-only rule
 *  misses `grep -r . .ssh`, which reads private keys without naming one. */
const SENSITIVE_NAME = /^(?:\.env(?:$|\.)|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.dockercfg|\.gitconfig|\.bash_history|\.zsh_history|\.python_history|\.mysql_history|\.psql_history|\.wgetrc|\.curlrc|\.pgpass|\.authinfo|\.s3cfg|\.terraformrc|\.my\.cnf|\.mylogin\.cnf|\.kubeconfig|\.credentials\.json|\.envrc|\.htpasswd|credentials\.json|application_default_credentials\.json|service[-_]?account[^/]*\.json|hosts\.yml|id_[a-z0-9][^/]*)$/;

/** Private-key containers: the extension alone is enough to ask before reading. */
const SENSITIVE_SUFFIX = /\.(?:pem|key|pfx|p12|jks|keystore|ppk|kdbx|ovpn)$/i;

function sensitive(path: string, home: string): boolean {
  const segments = path.split(sep).filter(Boolean);
  if (segments.some((part) => SENSITIVE_DIRS.has(part))) return true;
  if (SENSITIVE_NAME.test(basename(path))) return true;
  if (SENSITIVE_SUFFIX.test(path)) return true;
  if (/(?:^|\/)(?:shadow|gshadow)$/.test(path)) return true;
  if (/\/proc\/(?:self|\d+)\/(?:environ|mem)$/.test(path)) return true;
  // The remaining rules only apply inside the user's own home directory.
  const local = relative(home, path);
  if (local === "" || local === ".." || local.startsWith(".." + sep) || isAbsolute(local)) return false;
  if (HOME_NAME.test(basename(path))) return true;
  const parts = local.split(sep).filter(Boolean);
  if (parts.some((part) => HOME_DIRS.has(part))) return true;
  for (let i = 1; i <= parts.length; i++) {
    if (HOME_PATHS.has(parts.slice(0, i).join("/"))) return true;
  }
  return false;
}

let homeCache: string | undefined;

/** The canonical home directory, resolved once: it is hit on nearly every check. */
function homeDirectory(): string {
  return homeCache ??= canonicalPath(homedir());
}

export function assessPath(operation: "read" | "write", input: unknown, cwd: string): Assessment {
  if (typeof input !== "string" || !input || input.includes("\0")) return ask("无法确认目标路径", "路径不明");
  try {
    const original = resolveToolPath(input, cwd);
    const target = canonicalPath(original);
    const home = homeDirectory();
    if (sensitive(original, home) || sensitive(target, home)) return ask("目标涉及凭据或敏感配置", "凭据");
    if (operation === "read") return allow();
    const root = canonicalPath(cwd);
    if (!inside(target, root)) return ask("目标位于当前工作目录之外（已解析符号链接）", "目录外");
    if ([original, target].some((path) =>
      path.split(sep).some((part) => [".git", ".pi", ".codex", ".agents"].includes(part)) ||
      basename(path) === "AGENTS.md"
    )) return ask("目标涉及 Git 元数据、代理配置或权限规则", "受保护");
    try {
      if (lstatSync(target).nlink > 1) return ask("目标存在硬链接，写入可能影响其他路径", "硬链接");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return allow();
  } catch {
    return ask("目标路径无法可靠解析，需要人工确认", "路径不明");
  }
}

/**
 * One parsed word. zsh decides some expansions from the *source* text rather than the
 * resulting value: a leading `=` or `~` is expanded only when it was not quoted or
 * escaped, in which case the quotes are stripped and `quoted` is false. `''=ls` stays
 * unquoted because an empty quote does not start the word.
 */
interface ParsedWord { value: string; quoted: boolean }

/** A command together with the operator that separated it from the next one. */
interface Segment { words: ParsedWord[]; operator?: string }

/**
 * Intentionally recognize a small literal-shell subset, not an entire shell.
 * Expansions, redirects, background jobs, scripts and unsupported syntax ASK.
 * Nothing unrecognized is ever assumed safe.
 */
export function parseLiteralCommands(command: string): Segment[] | string {
  const segments: Segment[] = [];
  let words: ParsedWord[] = [];
  let word = "";
  let started = false;
  // A quote or escape only protects expansion when it contributed the first character.
  let quotedStart = false;
  let quote: "'" | '"' | undefined;
  const flushWord = () => {
    if (started) words.push({ value: word, quoted: quotedStart });
    word = "";
    started = false;
    quotedStart = false;
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
      else { if (!word) quotedStart = true; word += char; }
      continue;
    }
    if (char === "$" || char.charCodeAt(0) === 96) return "命令含变量、替换或动态 shell 表达式";
    if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === "\\") {
        const next = command[++i];
        if (next === undefined) return "命令转义不完整";
        if (next !== "\n") {
          if (!word) quotedStart = true;
          word += ['"', "\\", "$"].includes(next) || next.charCodeAt(0) === 96 ? next : "\\" + next;
        }
      } else { if (!word) quotedStart = true; word += char; }
      continue;
    }
    if (char === "'" || char === '"') {
      // Opening a quote keeps an empty argument alive. The protection flag is set
      // later, once a character really lands in the word: `''=ls` still expands in zsh.
      quote = char;
      started = true;
    } else if (char === "\\") {
      const next = command[++i];
      if (next === undefined) return "命令转义不完整";
      if (next !== "\n") { word += next; started = true; quotedStart = true; }
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

/** Commands whose arguments are data rather than paths, so they are not path-checked. */
const DATA_ARG_COMMANDS = new Set(["echo", "printf", "true", "false", "uname", "df"]);

/**
 * Short options that absorb the rest of their own argument as a path.
 *
 * `assessPath` used to run only on whole arguments, so `-f/home/user/.ssh/id_rsa`
 * slipped through untouched while `--file=/home/user/.ssh/id_rsa` was checked: the
 * two spellings reach the same file, and `grep -f`, `file -f` and BSD `du -X` all
 * read arbitrary files that way. Letters are consumed left to right as flags until
 * one takes a value, so `-nfFILE` is `-n -f FILE` and not `-n -fFILE`.
 */
const SHORT_PATH_OPTIONS: Record<string, Record<string, "read" | "write">> = {
  grep: { f: "read" },
  rg: { f: "read" },
  file: { f: "read", m: "read" },
  du: { X: "read" },
  sort: { o: "write", T: "write" },
};

/** The literal value a glued short option would take, e.g. `FILE` from `-nfFILE`. */
function gluedShortValue(command: string, arg: string): { value: string; operation: "read" | "write" } | undefined {
  const options = SHORT_PATH_OPTIONS[command];
  if (!options) return undefined;
  for (let i = 1; i < arg.length; i++) {
    const operation = options[arg[i]];
    if (operation) return { value: arg.slice(i + 1), operation };
  }
  return undefined;
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

/** A tag for `ask` that names the rule in a couple of characters, for the title row. */
function commandTag(name: string): string {
  if (["rm", "rmdir", "unlink", "shred", "wipe"].includes(name)) return "删除";
  if (["sudo", "su", "doas", "pkexec", "runuser"].includes(name)) return "提权";
  if (/^(?:mkfs|fsck)(?:\.|$)/.test(name) || ["dd", "fdisk", "parted", "mount", "umount", "reboot", "shutdown"].includes(name)) {
    return "系统";
  }
  if (["git", "gh"].includes(name)) return "Git";
  if (["curl", "wget", "ssh", "scp", "rsync"].includes(name)) return "网络";
  if (["bash", "sh", "zsh", "fish", "python", "python3", "node", "bun", "deno", "perl", "ruby", "awk", "eval", "source"].includes(name)) {
    return "脚本";
  }
  return "未分类";
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

/** A leading ~ survives the quoting rewrite only if it is expanded first. */
function expandHome(value: string, dialect: ShellDialect): string | undefined {
  if (value === "~") return homeDirectory();
  if (value.startsWith("~/")) return canonicalPath(join(homeDirectory(), value.slice(2)));
  // zsh expands ~+ and ~- to directory-stack entries. Those never reach a quoted
  // argument as a literal, so the command is sent to the user instead of guessed.
  if (dialect === "zsh" && (value === "~+" || value === "~-" || value.startsWith("~+/") || value.startsWith("~-/"))) {
    return undefined;
  }
  // A ~user form is left to a human; guessing a home directory here would be wrong.
  if (value.startsWith("~")) return undefined;
  return value;
}

/**
 * zsh-only spelling that, unlike the quoted rewrite, bash would leave alone. Such a
 * word means the vetted command and the executed command would differ, so it is sent
 * to the user rather than translated.
 *
 * `EQUALS` (command-path expansion) is the only operator that applies here: it is on
 * by default and `=ls` is never a real path. `^foo` is deliberately allowed, because
 * with the option set pi uses it is only a glob (`^` at a word start) or a plain
 * literal, and `grep '^import'` is far too common to refuse. A leading `=` inside a
 * longer word (`a=b.txt`) is not an expansion in zsh and is left untouched.
 */
function zshRewriteRisk(value: string): boolean {
  return value.length > 1 && value.startsWith("=");
}

function vetSegment(words: ParsedWord[], cwd: string, dialect: ShellDialect): Assessment & { words?: string[] } {
  const [command, ...rawArgs] = words;
  const name = basename(command.value);
  if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(command.value)) return ask("环境变量赋值可能改变命令的执行方式", "赋值");
  if (dialect === "zsh" && !command.quoted && zshRewriteRisk(command.value)) {
    return ask("zsh 会对此命令名做 =命令 展开，无法确认实际执行的文件", "zsh 展开");
  }
  const executable = trustedExecutable(command.value);
  if (!executable) return ask(commandReason(name), commandTag(name));
  const args: string[] = [];
  for (const raw of rawArgs) {
    // A quoted or escaped leading ~ is literal in both shells, so the rewrite is
    // already equivalent and nothing has to be expanded or guessed.
    const expanded = raw.quoted ? raw.value : expandHome(raw.value, dialect);
    if (expanded === undefined) return ask("参数中含无法可靠解析的 shell 展开（如 ~user 或 zsh 的 ~+）", "展开不确定");
    if (dialect === "zsh" && !raw.quoted && zshRewriteRisk(expanded)) {
      return ask("参数会被 zsh 的 =命令 展开改写，无法确认实际参数", "zsh 展开");
    }
    args.push(expanded);
  }
  // Vetted read operations must not sneak in subcommands or output-file flags.
  if (name === "rg" && args.some((arg) => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) {
    return ask("搜索参数会启动外部程序", "外部程序");
  }
  if (name === "find" && args.some((arg) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg))) {
    return ask("find 参数会执行命令、删除或写入文件", "find 参数");
  }
  if (name === "sort" && args.some((arg) => /^--(?:output|compress-program)(?:=|$)/.test(arg) || /^-[^-]*o/.test(arg))) {
    return ask("sort 参数会写入文件或执行外部程序", "sort 参数");
  }
  if (name === "file" && args.some((arg) => /^--uncompress/.test(arg) || /^-[^-]*[zZ]/.test(arg))) {
    return ask("file 解压参数可能调用外部程序", "file 参数");
  }
  // Reject unknown and abbreviated options as well: GNU --out can mean --output.
  if (name === "sort" && !knownOptions(args,
    "--numeric-sort --general-numeric-sort --human-numeric-sort --version-sort --reverse --unique --stable " +
    "--ignore-case --ignore-leading-blanks --field-separator --key --check --help --version",
    /^-[nNgGhHrVuMsbfcdm]+$|^-[kt].*$/,
  )) return ask("sort 参数未被确认为只读", "sort 参数");
  if (name === "file" && !knownOptions(args,
    "--brief --mime --mime-type --mime-encoding --dereference --separator --keep-going --version --help",
    /^-[bikLNprsv0]+$/,
  )) return ask("file 参数未被确认为只读", "file 参数");
  if (name === "rg" && !knownOptions(args,
    "--files --hidden --no-ignore --no-ignore-vcs --no-ignore-parent --no-ignore-global --glob --iglob --type " +
    "--type-not --type-list --line-number --no-line-number --count --count-matches --with-filename --no-filename " +
    "--ignore-case --smart-case --case-sensitive --fixed-strings --word-regexp --line-regexp --invert-match " +
    "--max-count --max-depth --max-filesize --context --before-context --after-context --color --colors " +
    "--heading --no-heading --sort --sortr --stats --json --only-matching --replace --trim --pcre2 " +
    "--multiline --multiline-dotall --follow --files-without-match --files-with-matches --null --null-data " +
    "--text --regexp --file --quiet --encoding --no-messages --version --help --crlf",
    /^-[nHhIilLovswxUaFcqSPz0u]+$|^-[egftTrABCm].*$/,
  )) return ask("rg 参数未被确认为只读", "rg 参数");
  if (name === "find") {
    const known = new Set(("-name -iname -path -ipath -regex -iregex -type -maxdepth -mindepth -print -print0 " +
      "-ls -empty -size -mtime -mmin -atime -amin -ctime -cmin -newer -anewer -cnewer -user -group " +
      "-perm -a -and -o -or -not -true -false -readable -writable -executable -P -H -L").split(" "));
    if (args.some((arg) => arg.startsWith("-") && !known.has(arg) && !/^-\d+$/.test(arg))) {
      return ask("find 参数未被确认为只读", "find 参数");
    }
  }
  if (name === "sed") {
    const rest = args[0] === "-n" ? args.slice(1) : args;
    if (!/^(?:\d+(?:,(?:\d+|\$))?|\$)?p$/.test(rest[0] ?? "") ||
        rest.slice(1).some((arg) => arg.startsWith("-"))) {
      return ask("只自动放行 sed 的行范围打印；编辑、脚本及其他参数需要确认", "sed 参数");
    }
  }
  // Check every argument a literal path could hide in, including option values such
  // as `--file=...`. `cat id_rsa` matters as much as `cat .ssh/id_rsa`, and printing
  // commands carry data rather than paths, so they are exempt. Shell code is never
  // used to resolve these.
  if (!DATA_ARG_COMMANDS.has(name)) {
    // A glued short option carries its value inside the same argument, and an option
    // whose value sits in the next argument has to keep that target for the next loop.
    let pending: "read" | "write" | undefined;
    for (const arg of args) {
      if (arg === "--") { pending = undefined; continue; }
      if (pending && !arg.startsWith("-")) {
        const decision = assessPath(pending, arg, cwd);
        pending = undefined;
        if (decision.approval) return decision;
        continue;
      }
      pending = undefined;
      if (arg.startsWith("-") && !arg.startsWith("--")) {
        const glued = gluedShortValue(name, arg);
        if (glued) {
          if (!glued.value) { pending = glued.operation; continue; }
          const decision = assessPath(glued.operation, glued.value, cwd);
          if (decision.approval) return decision;
          continue;
        }
      }
      const values = arg.startsWith("-") && !arg.startsWith("-/") && !arg.startsWith("-~")
        ? (arg.includes("=") ? [arg.slice(arg.indexOf("=") + 1)] : [])
        : [arg];
      for (const value of values) {
        if (!value) continue;
        const decision = assessPath("read", value, cwd);
        if (decision.approval) return decision;
      }
    }
  }
  if (name === "git") {
    const [subcommand, ...options] = args;
    // `<rev>:<path>` reads a blob, so the path after the colon needs the same checks.
    for (const arg of options) {
      const colon = arg.indexOf(":");
      if (colon > 0 && !arg.startsWith("-")) {
        const decision = assessPath("read", arg.slice(colon + 1), cwd);
        if (decision.approval) return decision;
      }
    }
    if (!["status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree"].includes(subcommand)) {
      return ask(commandReason("git"), commandTag("git"));
    }
    if (options.some((arg) =>
      /^--(?:ext-diff|textconv|output|config-env|exec-path)(?:=|$)/.test(arg) ||
      /^-c(?:$|[^-])/.test(arg) || /^-O/.test(arg) || /%G/.test(arg)
    )) return ask("Git 参数可能执行外部程序或写入文件", "Git 参数");
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
    )) return ask("Git 参数未被确认为只读", "Git 参数");
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

export function assessCommand(command: unknown, cwd: string, dialect: ShellDialect = "bash"): Assessment {
  if (typeof command !== "string" || !command.trim()) return ask("命令为空或格式不正确", "命令为空");
  if (command.length > 128 * 1024) return ask("命令过长，无法自动判断", "命令过长");
  const parsed = parseLiteralCommands(command);
  if (typeof parsed === "string") return ask(parsed, "语法");
  if (!parsed.length) return ask("未找到可执行命令", "无命令");
  const normalized: string[] = [];
  for (const segment of parsed) {
    const decision = vetSegment(segment.words, cwd, dialect);
    if (decision.approval) return decision;
    const words = decision.words ?? segment.words.map((word) => word.value);
    normalized.push(words.map(shellQuote).join(" "));
    if (segment.operator) normalized.push(segment.operator);
  }
  return { ...allow(), safeCommand: normalized.join(" ") };
}

export function assessTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  dialect: ShellDialect = "bash",
): Assessment {
  if (name === "bash") return assessCommand(input.command, cwd, dialect);
  if (name === "powershell") return ask("PowerShell 脚本需要人工确认", "PowerShell");
  if (name === "write" || name === "edit") return assessPath("write", input.path ?? input.file_path, cwd);
  if (["read", "grep", "find", "ls"].includes(name)) return assessPath("read", input.path ?? cwd, cwd);
  return ask("自定义工具尚未归类，需要确认其操作", "自定义工具");
}
