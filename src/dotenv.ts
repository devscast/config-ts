import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

/** ────────────────────────────────────────────────────────────────────────────
 *  Hoisted regex & small helpers (avoid recompiles in hot paths)
 *  ──────────────────────────────────────────────────────────────────────────── */
const RX_VARNAME_STICKY = /_?[A-Z][A-Z0-9_]*/y; // sticky var name
const RX_EXPORT_STICKY = /export[ \t]*/y; // sticky export
const RX_EOL_OR_COMMENT = /[ \t]*(?:#.*)?$/my; // value: end or #...
const RX_DOUBLE_QUOTE_ESCAPES = /\\"/g; // \" -> "
const RX_CRLF = /\r\n/g; // normalize EOL
const RX_TRAILING_WS = /[ \t]+$/g; // trim end ws
const RX_TRAILING_NEWLINES = /[\n\r]+$/g; // trim end \n
const SENTINEL_VARS = "NODE_DOTENV_VARS";
const SENTINEL_PATH = "NODE_DOTENV_PATH";

function countBackslashesLocal(s: string, index: number): number {
  let c = 0;
  for (let i = index - 1; i >= 0 && s[i] === "\\"; i--) c++;
  return c;
}

/** ────────────────────────────────────────────────────────────────────────────
 *  Errors
 *  ──────────────────────────────────────────────────────────────────────────── */
export class FormatError extends Error {
  constructor(
    message: string,
    readonly filepath: string,
    readonly line: number,
    readonly column: number
  ) {
    super(`${message} at ${filepath}:${line}:${column}`);
    this.name = "FormatError";
  }
}

export class PathError extends Error {
  constructor(readonly filepath: string) {
    super(`Env path not readable or is a directory: ${filepath}`);
    this.name = "PathError";
  }
}

/** ────────────────────────────────────────────────────────────────────────────
 *  Types
 *  ──────────────────────────────────────────────────────────────────────────── */
type StringMap = Record<string, string>;

/** ────────────────────────────────────────────────────────────────────────────
 *  Dotenv
 *  ──────────────────────────────────────────────────────────────────────────── */
export default class Dotenv {
  // public constant for external validation
  static readonly VARNAME_REGEX = /^_?[A-Z][A-Z0-9_]*$/i;
  static readonly STATE_VARNAME = 0;
  static readonly STATE_VALUE = 1;

  private path_!: string;
  private cursor!: number;
  private lineno!: number;
  private data_!: string;
  private end_!: number;
  private values: StringMap = {};
  private prodEnvs: string[] = ["prod"];
  private usePutenv = false; // parity flag only

  constructor(
    private envKey = "APP_ENV",
    private debugKey = "APP_DEBUG"
  ) {}

  setProdEnvs(prodEnvs: string[]) {
    this.prodEnvs = [...prodEnvs];
    return this;
  }

  useProcessPutenv(use = true) {
    this.usePutenv = use; // no-op in Node, kept for parity/tests
    return this;
  }

  load(p: string, ...extra: string[]) {
    this.doLoad(false, [p, ...extra]);
  }

  overload(p: string, ...extra: string[]) {
    this.doLoad(true, [p, ...extra]);
  }

  /**
   * Symfony-like semantics:
   * - load .env (or .env.dist if .env missing)
   * - infer APP_ENV (default 'dev') if missing
   * - load .env.local unless in test env
   * - skip if APP_ENV == 'local'
   * - load .env.$env
   * - load .env.$env.local
   */
  loadEnv(
    p: string,
    envKey: string | null = null,
    defaultEnv = "dev",
    testEnvs: string[] = ["test"],
    overrideExisting = false
  ) {
    this.populatePath(p);

    const k = envKey ?? this.envKey;
    const primary = tryReadFile(p);
    const dist = primary === null ? tryReadFile(`${p}.dist`) : null;

    if (primary !== null) {
      this.loadBuffer(primary, p, overrideExisting);
    } else if (dist !== null) {
      this.loadBuffer(dist, `${p}.dist`, overrideExisting);
    } else {
      throw new PathError(p);
    }

    let env = process.env[k];
    if (env == null) {
      this.populate({ [k]: defaultEnv }, overrideExisting);
      env = defaultEnv;
    }

    const localBuf = !testEnvs.includes(env) ? tryReadFile(`${p}.local`) : null;
    if (localBuf) {
      this.loadBuffer(localBuf, `${p}.local`, overrideExisting);
      env = process.env[k] ?? env;
    }

    if (env === "local") return;

    const envBuf = tryReadFile(`${p}.${env}`);
    if (envBuf) this.loadBuffer(envBuf, `${p}.${env}`, overrideExisting);

    const envLocalBuf = tryReadFile(`${p}.${env}.local`);
    if (envLocalBuf) this.loadBuffer(envLocalBuf, `${p}.${env}.local`, overrideExisting);
  }

  bootEnv(p: string, defaultEnv = "dev", testEnvs: string[] = ["test"], overrideExisting = false) {
    const jsLocal = `${p}.local.cjs`;
    const k = this.envKey;
    let loaded: StringMap | null = null;

    // Try CJS object { KEY: "VALUE", ... }
    const localObj = tryRequireObject(jsLocal);
    if (localObj) loaded = { ...localObj };

    if (loaded && (overrideExisting || !loaded[k] || (process.env[k] ?? loaded[k]) === loaded[k])) {
      this.populatePath(p);
      this.populate(loaded, overrideExisting);
    } else {
      this.loadEnv(p, k, defaultEnv, testEnvs, overrideExisting);
    }

    // Compute APP_DEBUG
    const dk = this.debugKey;
    const currentEnv = process.env[this.envKey] ?? defaultEnv;
    const defaultDebug = !this.prodEnvs.includes(currentEnv);
    const debugRaw = process.env[dk];
    process.env[dk] = this.castBool(debugRaw ?? defaultDebug) ? "1" : "0";
  }

  populate(values: StringMap, overrideExisting = false) {
    let updateLoadedVars = false;
    const loadedVars = new Set(
      (process.env[SENTINEL_VARS] ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    );

    for (const [name, value] of Object.entries(values)) {
      if (!loadedVars.has(name) && !overrideExisting && process.env[name] != null) {
        continue;
      }
      process.env[name] = value; // no real putenv in Node
      if (!loadedVars.has(name)) {
        loadedVars.add(name);
        updateLoadedVars = true;
      }
    }

    if (updateLoadedVars) {
      process.env[SENTINEL_VARS] = Array.from(loadedVars).join(",");
    }
  }

  parse(data: string, filepath = ".env"): StringMap {
    this.path_ = filepath;
    this.data_ = data.indexOf("\r") >= 0 ? data.replace(RX_CRLF, "\n") : data;
    this.lineno = 1;
    this.cursor = 0;
    this.end_ = this.data_.length;
    let state = Dotenv.STATE_VARNAME;
    this.values = {};
    let name = "";

    this.skipEmptyLines();

    while (this.cursor < this.end_) {
      switch (state) {
        case Dotenv.STATE_VARNAME:
          name = this.lexVarname();
          state = Dotenv.STATE_VALUE;
          break;
        case Dotenv.STATE_VALUE:
          this.values[name] = this.lexValue();
          state = Dotenv.STATE_VARNAME;
          break;
      }
    }

    if (state === Dotenv.STATE_VALUE) {
      this.values[name] = "";
    }

    try {
      return { ...this.values };
    } finally {
      this.values = {};
      // cleanup volatile fields
      // @ts-expect-error
      this.path_ = this.cursor = this.lineno = this.data_ = this.end_ = undefined;
    }
  }

  /** ── Lexing & parsing internals ─────────────────────────────────────────── */

  private lexVarname(): string {
    // optional "export"
    RX_EXPORT_STICKY.lastIndex = this.cursor;
    const exportMatch = RX_EXPORT_STICKY.exec(this.data_);
    if (exportMatch) this.moveCursor(exportMatch[0]);

    RX_VARNAME_STICKY.lastIndex = this.cursor;
    const m = RX_VARNAME_STICKY.exec(this.data_);
    if (!m) throw this.createFormatError("Invalid character in variable name");

    const varname = m[0];
    this.moveCursor(m[0]);

    const ch = this.peek();
    if (this.cursor === this.end_ || ch === "\n" || ch === "#") {
      if (exportMatch) throw this.createFormatError("Unable to unset an environment variable");
      throw this.createFormatError("Missing = in the environment variable declaration");
    }
    if (ch === " " || ch === "\t") {
      throw this.createFormatError("Whitespace characters are not supported after the variable name");
    }
    if (ch !== "=") throw this.createFormatError("Missing = in the environment variable declaration");
    this.cursor++;
    return varname;
  }

  private lexValue(): string {
    // empty or comment till EOL
    RX_EOL_OR_COMMENT.lastIndex = this.cursor;
    const m = RX_EOL_OR_COMMENT.exec(this.data_);
    if (m && m.index === this.cursor) {
      this.moveCursor(m[0]);
      this.skipEmptyLines();
      return "";
    }

    if (this.peek() === " " || this.peek() === "\t") {
      throw this.createFormatError("Whitespace are not supported before the value");
    }

    const loadedVars = new Set(
      (process.env[SENTINEL_VARS] ?? "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    );

    const chunks: string[] = [];

    do {
      const ch = this.peek();
      if (ch === "'") {
        // single-quoted: literal until next unescaped '
        let len = 0;
        while (true) {
          if (this.cursor + ++len === this.end_) {
            this.cursor += len;
            throw this.createFormatError("Missing quote to end the value");
          }
          if (this.data_[this.cursor + len] === "'") break;
        }
        chunks.push(this.data_.substring(this.cursor + 1, this.cursor + len));
        this.cursor += 1 + len;
      } else if (ch === '"') {
        // double-quoted: escapes + variable/command expansion
        this.cursor++;
        if (this.cursor === this.end_) throw this.createFormatError("Missing quote to end the value");

        const start = this.cursor;
        const inner: string[] = [];
        while (true) {
          if (this.cursor === this.end_) throw this.createFormatError("Missing quote to end the value");
          if (this.data_[this.cursor] === '"') {
            // ensure not escaped by odd count of backslashes
            let backslashCount = 0;
            for (let i = this.cursor - 1; i >= start && this.data_[i] === "\\"; i--) backslashCount++;
            if (backslashCount % 2 === 0) break;
          }
          inner.push(this.data_[this.cursor]!);
          this.cursor++;
        }
        this.cursor++; // consume closing "

        let value = inner.join("").replace(RX_DOUBLE_QUOTE_ESCAPES, '"').replace(/\\r/g, "\r").replace(/\\n/g, "\n");
        value = this.resolveCommands(value, loadedVars);
        value = this.resolveVariables(value, loadedVars).replace(/\\\\/g, "\\");
        chunks.push(value);
      } else {
        // bare value until EOL or quote or comment-after-space
        let prev = this.data_[this.cursor - 1];
        const bare: string[] = [];
        while (
          this.cursor < this.end_ &&
          !["\n", '"', "'"].includes(this.data_[this.cursor]!) &&
          !((prev === " " || prev === "\t") && this.data_[this.cursor] === "#")
        ) {
          if (
            this.data_[this.cursor] === "\\" &&
            this.data_[this.cursor + 1] &&
            (this.data_[this.cursor + 1] === '"' || this.data_[this.cursor + 1] === "'")
          ) {
            this.cursor++;
          }
          prev = this.data_[this.cursor];

          if (this.data_[this.cursor] === "$" && this.data_[this.cursor + 1] === "(") {
            this.cursor++;
            bare.push("(" + this.lexNestedExpression() + ")");
            this.cursor++;
            continue;
          }

          bare.push(this.data_[this.cursor]!);
          this.cursor++;
        }

        let value = bare.join("").replace(RX_TRAILING_WS, "");
        let resolved = this.resolveCommands(value, loadedVars);
        resolved = this.resolveVariables(resolved, loadedVars).replace(/\\\\/g, "\\");
        if (resolved === value && /\s/.test(value)) {
          throw this.createFormatError("A value containing spaces must be surrounded by quotes");
        }
        chunks.push(resolved);

        if (this.cursor < this.end_ && this.data_[this.cursor] === "#") {
          // eat comment until EOL
          while (this.cursor < this.end_ && this.data_[this.cursor] !== "\n") this.cursor++;
          break;
        }
      }
    } while (this.cursor < this.end_ && this.data_[this.cursor] !== "\n");

    this.skipEmptyLines();
    return chunks.join("");
  }

  private lexNestedExpression(): string {
    // entered after reading "$("
    this.cursor++; // step past '('
    const out: string[] = [];

    while (this.data_[this.cursor] !== "\n" && this.data_[this.cursor] !== ")") {
      const c = this.data_[this.cursor]!;
      out.push(c);
      if (c === "(") {
        out.push(this.lexNestedExpression(), ")");
      }
      this.cursor++;
      if (this.cursor === this.end_) {
        throw this.createFormatError("Missing closing parenthesis.");
      }
    }
    if (this.data_[this.cursor] === "\n") {
      throw this.createFormatError("Missing closing parenthesis.");
    }
    return out.join("");
  }

  private skipEmptyLines() {
    while (this.cursor < this.end_) {
      const ch = this.data_[this.cursor];
      if (ch === " " || ch === "\t" || ch === "\r") {
        this.cursor++;
        continue;
      }
      if (ch === "\n") {
        this.cursor++;
        this.lineno++;
        continue;
      }
      if (ch === "#") {
        while (this.cursor < this.end_ && this.data_[this.cursor] !== "\n") {
          this.cursor++;
        }
        continue;
      }
      break;
    }
  }

  private resolveCommands(value: string, loadedVars: Set<string>): string {
    if (!value.includes("$(")) return value;

    let out = "";
    let cursor = 0;

    while (cursor < value.length) {
      const start = value.indexOf("$(", cursor);
      if (start === -1) {
        out += value.slice(cursor);
        break;
      }

      // escaped sequence?
      const backslashes = countBackslashesLocal(value, start);
      if (backslashes % 2 === 1) {
        // keep literal "$(" and drop one backslash
        out += value.slice(cursor, Math.max(cursor, start - 1)) + "$(";
        cursor = start + 2;
        continue;
      }

      out += value.slice(cursor, start);
      const { content, endIndex } = this.extractCommand(value, start + 2);
      out += this.executeCommand(content, loadedVars);
      cursor = endIndex + 1;
    }

    return out;
  }

  private extractCommand(value: string, start: number): { content: string; endIndex: number } {
    let depth = 1;
    let i = start;
    const acc: string[] = [];

    while (i < value.length) {
      const char = value[i]!;
      if (char === "(") {
        depth++;
      } else if (char === ")") {
        depth--;
        if (depth === 0) {
          return { content: acc.join(""), endIndex: i };
        }
      }
      acc.push(char);
      i++;
    }

    throw this.createFormatError("Missing closing parenthesis.");
  }

  private executeCommand(content: string, loadedVars: Set<string>): string {
    if (process.platform === "win32") {
      throw new Error("Resolving commands is not supported on Windows.");
    }

    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    // overlay parse-time values when appropriate
    for (const [name, val] of Object.entries(this.values)) {
      if (loadedVars.has(name) || process.env[name] == null) {
        childEnv[name] = val;
      }
    }

    // run content directly; no echo trampoline
    const out = spawnSync(content, {
      env: childEnv,
      shell: "/bin/sh",
      encoding: "utf8",
    });

    if (out.error || out.status !== 0) {
      const err = (out.stderr || out.error?.message || "").trim();
      throw this.createFormatError(`Issue expanding a command (${err})`);
    }
    return out.stdout.replace(RX_TRAILING_NEWLINES, "");
  }

  private resolveVariables(value: string, loadedVars: Set<string>): string {
    if (!value.includes("$")) return value;

    const re =
      /(?<!\\)(?<backslashes>\\*)\$(?!\()(?<opening_brace>\{)?(?<name>_?[A-Z][A-Z0-9_]*)?(?<default>:[-=][^}]*)?(?<closing_brace>\})?/g;

    return value.replace(
      re,
      (m, backslashes: string, opening?: string, name?: string, def?: string, closing?: string) => {
        // odd backslashes => escaped $
        if (backslashes && backslashes.length % 2 === 1) {
          return m.slice(1);
        }
        // bare '$' not followed by a name
        if (!name) return m;

        if (opening === "{" && !closing) {
          throw this.createFormatError("Unclosed braces on variable expansion");
        }

        let val = "";
        if (loadedVars.has(name) && this.values[name] != null) {
          val = this.values[name];
        } else if (process.env[name] != null) {
          val = process.env[name] as string;
        } else if (this.values[name] != null) {
          val = this.values[name];
        } else {
          val = "";
        }

        if (val === "" && def && def !== "") {
          const defaultBody = def.slice(2);
          const bad = Dotenv.findInvalidDefaultChar(defaultBody);
          if (bad) {
            throw this.createFormatError(
              `Unsupported character "${bad}" found in the default value of variable "$${name}".`
            );
          }
          const dval = defaultBody;
          val = dval;
          if (def[1] === "=") {
            this.values[name] = dval;
          }
        }

        if (!opening && closing) {
          val += "}";
        }

        return (backslashes ?? "") + val;
      }
    );
  }

  private moveCursor(text: string) {
    this.cursor += text.length;
    const nl = text.match(/\n/g);
    if (nl) this.lineno += nl.length;
  }

  private peek(): string {
    return this.data_[this.cursor]!;
  }

  private createFormatError(message: string): FormatError {
    return new FormatError(message, this.path_, this.lineno, this.cursor);
  }

  private static findInvalidDefaultChar(input: string): string | null {
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === "'" || ch === '"' || ch === "{") {
        return ch;
      }
      if (ch === "\\") {
        if (input[i + 1] === "$") return "$";
        return "\\";
      }
      if (ch === "$") return "$";
    }
    return null;
  }

  /** ── I/O helpers ────────────────────────────────────────────────────────── */

  private doLoad(overrideExisting: boolean, paths: string[]) {
    for (const p of paths) {
      const buf = tryReadFile(p);
      if (buf === null) throw new PathError(p);
      // directory reads throw, so reaching here means it's a regular file-like
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        throw new FormatError("Loading files starting with a byte-order-mark (BOM) is not supported.", p, 1, 0);
      }
      const parsed = this.parse(buf.toString("utf8"), p);
      this.populate(parsed, overrideExisting);
    }
  }

  private loadBuffer(buf: Buffer, filepath: string, overrideExisting: boolean) {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
      throw new FormatError("Loading files starting with a byte-order-mark (BOM) is not supported.", filepath, 1, 0);
    }
    const parsed = this.parse(buf.toString("utf8"), filepath);
    this.populate(parsed, overrideExisting);
  }

  private populatePath(p: string) {
    process.env[SENTINEL_PATH] = p;
  }

  private castBool(val: unknown): boolean {
    if (typeof val === "boolean") return val;
    if (typeof val === "number") return val !== 0;
    if (typeof val === "string") {
      const t = val.trim().toLowerCase();
      if (t === "1" || t === "true" || t === "yes" || t === "on") return true;
      if (t === "0" || t === "false" || t === "no" || t === "off" || t === "") return false;
    }
    return Boolean(val);
  }
}

/** ────────────────────────────────────────────────────────────────────────────
 *  Small util fns (sync, race-safe, low syscalls)
 *  ──────────────────────────────────────────────────────────────────────────── */
function tryReadFile(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function tryRequireObject(p: string): unknown | null {
  try {
    if (!fs.existsSync(p)) return null;

    const mod = require(path.resolve(p));
    return mod && typeof mod === "object" ? mod : null;
  } catch {
    return null;
  }
}
