import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import ini from "ini";
import ts from "typescript";
import YAML from "yaml";
import { ZodType } from "zod";
import { z } from "zod/mini";

import Dotenv, { PathError } from "./dotenv";
import { createEnvAccessor, env as defaultEnvAccessor, EnvAccessor } from "./env";

// Types & Public API
export type ConfigFormat = "json" | "yaml" | "ini" | "ts";

export interface FileSource {
  path: string;
  format?: ConfigFormat;
  optional?: boolean;
}

export type InlineSource = Record<string, unknown>;
export type ConfigSource = string | FileSource | InlineSource;

export interface EnvConfigOptions {
  enabled?: boolean;
  path?: string;
  envKey?: string;
  debugKey?: string;
  defaultEnv?: string;
  testEnvs?: string[];
  overrideExisting?: boolean;
  optional?: boolean;
  prodEnvs?: string[];
  environment?: string;
  knownKeys?: readonly string[];
}

interface NormalizedEnvOptions {
  path: string;
  envKey: string;
  debugKey?: string;
  defaultEnv: string;
  testEnvs: string[];
  overrideExisting: boolean;
  optional: boolean;
  prodEnvs?: string[];
  environment?: string;
  knownKeys?: readonly string[];
}

export interface LoadConfigOptions<T extends ZodType> {
  schema: T;
  sources?: ConfigSource | ConfigSource[];
  defaults?: z.input<T>;
  cwd?: string;
  env?: boolean | EnvConfigOptions;
}

export interface ConfigResult<T> {
  config: T;
  env: EnvAccessor<string>;
}

// Errors
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class ConfigFileNotFoundError extends ConfigError {
  constructor(readonly filepath: string) {
    super(`Configuration file not found: ${filepath}`);
    this.name = "ConfigFileNotFoundError";
  }
}

export class ConfigParseError extends ConfigError {
  constructor(
    message: string,
    readonly filepath: string,
    readonly cause?: unknown
  ) {
    super(`${message} (${filepath})`);
    this.name = "ConfigParseError";
    if (cause) (this as any).cause = cause;
  }
}

export class ConfigValidationError extends ConfigError {
  constructor(readonly issues: z.core.$ZodIssue[]) {
    super("Configuration validation failed");
    this.name = "ConfigValidationError";
  }
}

// Optimized constants / helpers (hoisted to avoid rework on hot paths)
const ENV_PLACEHOLDER_REGEX = /%env\(([A-Z0-9_]+)\)%/gi;

const TS_COMPILER_OPTS: ts.TranspileOptions = {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    esModuleInterop: true,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: "",
  reportDiagnostics: false,
};

const EXT_TO_FORMAT: Record<string, ConfigFormat | undefined> = {
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".ini": "ini",
  ".ts": "ts",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function tryReadText(filepath: string): string | null {
  try {
    return fs.readFileSync(filepath, "utf8");
  } catch {
    return null;
  }
}

function fastSplitCommaSet(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === ",") {
      const token = raw.slice(start, i).trim();
      if (token) out.push(token);
      start = i + 1;
    }
  }
  return out;
}

// Public entry
export function loadConfig<T extends ZodType>(options: LoadConfigOptions<T>): ConfigResult<z.infer<T>> {
  const schema = options.schema;
  if (!schema) throw new ConfigError("A Zod schema is required to load configuration.");

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const envOptions = normalizeEnvOptions(options.env);

  const envAccessor = createEnvAccessor(envOptions?.knownKeys ?? []);
  envAccessor.register(...Object.keys(process.env));

  if (envOptions) {
    loadEnvFiles(envOptions, cwd, envAccessor);
  }
  // keep the default exported accessor in sync
  defaultEnvAccessor.register(...envAccessor.keys());

  const sources = normalizeSources(options.sources);

  if (options.defaults && !isPlainObject(options.defaults)) {
    throw new ConfigError("Default configuration must be a plain object.");
  }

  let merged: unknown = options.defaults ? cloneValue(options.defaults) : {};

  for (const source of sources) {
    const parsed = resolveSource(source, cwd, envAccessor);
    if (parsed) merged = mergeValues(merged, parsed);
  }

  const resolved = resolvePlaceholders(merged, envAccessor);
  const validation = schema.safeParse(resolved);
  if (!validation.success) {
    throw new ConfigValidationError(validation.error.issues);
  }

  return { config: validation.data, env: envAccessor };
}

// Env handling
function normalizeSources(sources?: ConfigSource | ConfigSource[]): ConfigSource[] {
  return !sources ? [] : Array.isArray(sources) ? sources : [sources];
}

function normalizeEnvOptions(input?: boolean | EnvConfigOptions): NormalizedEnvOptions | null {
  if (input === false) return null;

  const defaults: NormalizedEnvOptions = {
    path: ".env",
    envKey: "APP_ENV",
    defaultEnv: "dev",
    testEnvs: ["test"],
    overrideExisting: false,
    optional: true,
  };

  if (input === undefined || input === true) return defaults;
  if (input.enabled === false) return null;

  return {
    ...defaults,
    path: input.path ?? defaults.path,
    envKey: input.envKey ?? defaults.envKey,
    debugKey: input.debugKey,
    defaultEnv: input.defaultEnv ?? defaults.defaultEnv,
    testEnvs: input.testEnvs ?? defaults.testEnvs,
    overrideExisting: input.overrideExisting ?? defaults.overrideExisting,
    optional: input.optional ?? defaults.optional,
    prodEnvs: input.prodEnvs,
    environment: input.environment,
    knownKeys: input.knownKeys,
  };
}

function loadEnvFiles(options: NormalizedEnvOptions, cwd: string, accessor: EnvAccessor<string>) {
  const basePath = path.isAbsolute(options.path) ? options.path : path.resolve(cwd, options.path);

  const dotenv = new Dotenv(options.envKey, options.debugKey);
  if (options.prodEnvs) dotenv.setProdEnvs(options.prodEnvs);

  if (options.environment) {
    process.env[options.envKey] = options.environment;
  }

  try {
    dotenv.loadEnv(basePath, options.envKey, options.defaultEnv, options.testEnvs, options.overrideExisting);
  } catch (error) {
    if (!(options.optional && error instanceof PathError)) {
      throw error;
    }
  }

  // Keep track of env keys that Dotenv says it touched
  const loadedKeys = extractLoadedEnvKeys();
  if (loadedKeys.length > 0) accessor.register(...loadedKeys);

  accessor.register(options.envKey);
  if (options.knownKeys?.length) accessor.register(...options.knownKeys);
}

function extractLoadedEnvKeys(): string[] {
  // Single env variable used as sentinel by our Dotenv
  const raw = process.env["NODE_DOTENV_VARS"];
  return fastSplitCommaSet(raw);
}

// Source resolution & parsing
function resolveSource(
  source: ConfigSource,
  cwd: string,
  accessor: EnvAccessor<string>
): Record<string, unknown> | null {
  if (typeof source === "string") {
    return parseFile({ path: source }, cwd, accessor);
  }
  if (isFileSource(source)) {
    return parseFile(source, cwd, accessor);
  }
  if (!isPlainObject(source)) {
    throw new ConfigError("Inline configuration sources must be plain objects.");
  }
  return cloneValue(source);
}

function parseFile(source: FileSource, cwd: string, accessor: EnvAccessor<string>): Record<string, unknown> | null {
  const targetPath = path.isAbsolute(source.path) ? source.path : path.resolve(cwd, source.path);
  const format = source.format ?? inferFormat(targetPath);

  const text = tryReadText(targetPath);
  if (text === null) {
    if (source.optional) return null;
    throw new ConfigFileNotFoundError(targetPath);
  }

  try {
    switch (format) {
      case "json":
        return ensureObject(JSON.parse(text), targetPath);
      case "yaml":
        return ensureObject(YAML.parse(text), targetPath);
      case "ini":
        return ensureObject(ini.parse(text), targetPath);
      case "ts":
        return ensureObject(loadTsModule(targetPath, text, accessor), targetPath);
      default:
        throw new ConfigParseError(`Unsupported configuration format: ${format}`, targetPath);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigParseError("Failed to parse configuration file", targetPath, error);
  }
}

function inferFormat(filepath: string): ConfigFormat {
  const ext = EXT_TO_FORMAT[path.extname(filepath).toLowerCase()];
  if (!ext) {
    throw new ConfigParseError(
      `Unable to infer configuration format for extension "${path.extname(filepath)}"`,
      filepath
    );
  }
  return ext;
}

// TypeScript module loading (no disk re-read, uses provided source)
function loadTsModule(filepath: string, code: string, accessor: EnvAccessor<string>): unknown {
  const opts = { ...TS_COMPILER_OPTS, fileName: filepath };
  const transpiled = ts.transpileModule(code, opts);

  const requireFromFile = createRequire(filepath);
  const module = { exports: {} as any };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require: requireFromFile,
    __dirname: path.dirname(filepath),
    __filename: filepath,
    process,
    console,
    env: accessor,
  });

  new vm.Script(transpiled.outputText, { filename: filepath }).runInContext(context);

  const rawExports = module.exports;
  const exported =
    rawExports && typeof rawExports === "object" && "default" in rawExports
      ? (rawExports as { default: unknown }).default
      : rawExports;

  return typeof exported === "function" ? exported({ env: accessor }) : exported;
}

// Value shaping
// Relaxed: accept any object-like (not null, not array). We clone own props anyway.
function ensureObject(value: unknown, origin: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigParseError("Configuration source must resolve to an object", origin);
  }
  return cloneValue(value as Record<string, unknown>);
}

function resolvePlaceholders(value: unknown, accessor: EnvAccessor<string>): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_PLACEHOLDER_REGEX, (_m, name: string) => accessor(name));
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = resolvePlaceholders(value[i], accessor);
    return out;
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolvePlaceholders(v, accessor);
    }
    return result;
  }
  return value;
}

/**
 * mergeValues:
 * - arrays: replace with next (clone)
 * - objects: deep-merge (clone branches)
 * - primitives: override with next
 */
function mergeValues(base: unknown, next: unknown): unknown {
  if (next === undefined) return cloneValue(base);
  if (base === undefined) return cloneValue(next);

  if (Array.isArray(base) && Array.isArray(next)) {
    const out = new Array(next.length);
    for (let i = 0; i < next.length; i++) out[i] = cloneValue(next[i]);
    return out;
  }

  if (isPlainObject(base) && isPlainObject(next)) {
    const b = base as Record<string, unknown>;
    const n = next as Record<string, unknown>;

    // Start with cloned base, then overlay next (recursively)
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(b)) result[k] = cloneValue(v);
    for (const [k, v] of Object.entries(n)) {
      result[k] = k in b ? mergeValues(b[k], v) : cloneValue(v);
    }
    return result;
  }

  return cloneValue(next);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneValue(value[i]);
    return out as unknown as T;
  }
  if (isPlainObject(value)) {
    const src = value as Record<string, unknown>;
    const dst: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) dst[k] = cloneValue(v);
    return dst as unknown as T;
  }
  return value;
}

// Narrowing helpers
function isFileSource(value: ConfigSource): value is FileSource {
  return typeof value === "object" && value !== null && "path" in value && typeof (value as any).path === "string";
}
