import fs from "node:fs";
import path from "node:path";

import * as ini from "ini";
import * as YAML from "yaml";
import * as z from "zod";

import Dotenv, { PathError } from "./dotenv";
import { EnvAccessor, createEnvAccessor } from "./env";

// Types & Public API
export type ConfigFormat = "json" | "yaml" | "ini";

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

export interface DefineConfigOptions<T extends z.core.$ZodType> {
  schema: T;
  sources?: ConfigSource | ConfigSource[];
  defaults?: z.input<T>;
  cwd?: string;
  env?: boolean | EnvConfigOptions;
}

export type LoadConfigOptions<T extends z.core.$ZodType> = DefineConfigOptions<T>;

export interface ConfigResult<T> {
  config: T;
  env: EnvAccessor<string>;
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
    readonly cause?: unknown,
  ) {
    super(`${message} (${filepath})`);
    this.name = "ConfigParseError";
    if (cause) (this as any).cause = cause;
  }
}

export class ConfigValidationError<T extends z.ZodType> extends ConfigError {
  constructor(readonly issues: z.ZodError<z.core.output<T>>) {
    const details = z.prettifyError(issues);
    super(`Configuration validation failed:\n${details}`);
    this.name = "ConfigValidationError";
  }
}

// Optimized constants / helpers (hoisted to avoid rework on hot paths)
// Support optional type prefixes in placeholders: %env(type:VAR)%
// - type can be one of: string | number | boolean (case-insensitive)
// - When the entire value is a single placeholder, we can return a non-string (number/boolean)
// - When embedded inside a larger string, we interpolate as a string
const ENV_PLACEHOLDER_ANY = /%env\((?:(string|number|boolean):)?([A-Z0-9_]+)\)%/gi;
const ENV_PLACEHOLDER_FULL = /^%env\((?:(string|number|boolean):)?([A-Z0-9_]+)\)%$/i;

const EXT_TO_FORMAT: Record<string, ConfigFormat | undefined> = {
  ".ini": "ini",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
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
export function defineConfig<T extends z.ZodType>(
  options: DefineConfigOptions<T>,
): ConfigResult<z.infer<T>> {
  const schema = options.schema;
  if (!schema) throw new ConfigError("A Zod schema is required to load configuration.");

  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const envOptions = normalizeEnvOptions(options.env);

  const envAccessor = createEnvAccessor(envOptions?.knownKeys ?? []);
  envAccessor.register(...Object.keys(process.env));

  if (envOptions) {
    loadEnvFiles(envOptions, cwd, envAccessor);
  }

  const sources = normalizeSources(options.sources);

  if (options.defaults && !isPlainObject(options.defaults)) {
    throw new ConfigError("Default configuration must be a plain object.");
  }

  let merged: unknown = options.defaults ? cloneValue(options.defaults) : {};

  for (const source of sources) {
    const parsed = resolveSource(source, cwd);
    if (parsed) merged = mergeValues(merged, parsed);
  }

  const resolved = resolvePlaceholders(merged, envAccessor);
  const validation = schema.safeParse(resolved);
  if (!validation.success) {
    throw new ConfigValidationError(validation.error);
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
    defaultEnv: "dev",
    envKey: "NODE_ENV",
    optional: true,
    overrideExisting: false,
    path: ".env",
    testEnvs: ["test"],
  };

  if (input === undefined || input === true) return defaults;
  if (input.enabled === false) return null;

  return {
    ...defaults,
    debugKey: input.debugKey,
    defaultEnv: input.defaultEnv ?? defaults.defaultEnv,
    environment: input.environment,
    envKey: input.envKey ?? defaults.envKey,
    knownKeys: input.knownKeys,
    optional: input.optional ?? defaults.optional,
    overrideExisting: input.overrideExisting ?? defaults.overrideExisting,
    path: input.path ?? defaults.path,
    prodEnvs: input.prodEnvs,
    testEnvs: input.testEnvs ?? defaults.testEnvs,
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
    dotenv.loadEnv(
      basePath,
      options.envKey,
      options.defaultEnv,
      options.testEnvs,
      options.overrideExisting,
    );
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
  const raw = process.env.NODE_DOTENV_VARS;
  return fastSplitCommaSet(raw);
}

// Source resolution & parsing
function resolveSource(source: ConfigSource, cwd: string): Record<string, unknown> | null {
  if (typeof source === "string") {
    return parseFile({ path: source }, cwd);
  }
  if (isFileSource(source)) {
    return parseFile(source, cwd);
  }
  if (!isPlainObject(source)) {
    throw new ConfigError("Inline configuration sources must be plain objects.");
  }
  return cloneValue(source);
}

function parseFile(source: FileSource, cwd: string): Record<string, unknown> | null {
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
      filepath,
    );
  }
  return ext;
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
    // If the entire string is exactly one placeholder, allow non-string returns
    const full = value.match(ENV_PLACEHOLDER_FULL);
    if (full) {
      const [, rawType, name] = full as unknown as [string, string | undefined, string];
      const type = rawType ? rawType.toLowerCase() : undefined;
      const raw = accessor(name as string);
      return coerceEnvValue(raw, type);
    }

    // Otherwise, interpolate placeholders inside the string
    return value.replace(ENV_PLACEHOLDER_ANY, (_m, rawType: string | undefined, name: string) => {
      const type = rawType ? rawType.toLowerCase() : undefined;
      const raw = accessor(name);
      const coerced = coerceEnvValue(raw, type);
      return String(coerced);
    });
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

function coerceEnvValue(raw: string, type?: string): unknown {
  switch (type) {
    case undefined:
    case "string":
      return raw;
    case "number": {
      const num = Number(raw);
      return num; // May be NaN; let schema validation catch invalid cases
    }
    case "boolean": {
      const norm = raw.trim().toLowerCase();
      if (norm === "true" || norm === "1" || norm === "yes" || norm === "y" || norm === "on")
        return true;
      if (norm === "false" || norm === "0" || norm === "no" || norm === "n" || norm === "off")
        return false;
      // Fallback: non-empty strings are truthy, empty is falsey
      return Boolean(norm);
    }
    default:
      return raw;
  }
}

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
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof (value as any).path === "string"
  );
}
