export interface EnvLookupOptions {
  default?: string;
}

export interface EnvAccessor<K extends string = string> {
  (name: K, options?: EnvLookupOptions): string;
  optional(name: K): string | undefined;
  has(name: K): boolean;
  keys(): K[];
  register(...names: readonly string[]): void;
}

export function createEnvAccessor(): EnvAccessor<string>;
export function createEnvAccessor<const Keys extends readonly string[]>(
  knownKeys: Keys,
): EnvAccessor<Keys[number]>;
export function createEnvAccessor(knownKeys?: readonly string[]): EnvAccessor<string> {
  const registered = new Set<string>(knownKeys ?? []);

  const read = ((name: string, options?: EnvLookupOptions) => {
    registered.add(name as string);
    const value = process.env[name];
    if (value == null) {
      if (options && "default" in options) {
        return options.default as string;
      }
      throw new Error(`Missing environment variable: ${name}`);
    }
    return value;
  }) as EnvAccessor<string>;

  read.optional = (name: string) => {
    registered.add(name as string);
    const value = process.env[name];
    if (value == null) return undefined;
    return value;
  };

  read.has = (name: string) => {
    if (registered.has(name as string)) return true;
    if (Object.hasOwn(process.env, name)) return true;
    return false;
  };

  read.keys = () => {
    const keys = new Set<string>([...registered, ...Object.keys(process.env)]);
    return Array.from(keys) as string[];
  };

  read.register = (...names: readonly string[]) => {
    for (const name of names) {
      registered.add(name);
    }
  };

  return read;
}

export const env = createEnvAccessor();
