# Config : Typesafe configuration loader
![npm](https://img.shields.io/npm/v/@devscast/config?style=flat-square)
![npm](https://img.shields.io/npm/dt/@devscast/config?style=flat-square)
[![Lint](https://github.com/devscast/config-ts/actions/workflows/lint.yml/badge.svg?branch=main)](https://github.com/devscast/config-ts/actions/workflows/lint.yml)
[![Tests](https://github.com/devscast/config-ts/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/devscast/config-ts/actions/workflows/test.yml)
![GitHub](https://img.shields.io/github/license/devscast/config-ts?style=flat-square)

---

## Overview

`@devscast/config` provides a batteries-included configuration loader for Node.js projects. It lets you:

- Load configuration from JSON, YAML, INI, or native TypeScript modules
- Reference environment variables in text files with the `%env(FOO)%` syntax
- Bootstrap environment values from `.env` files (including `.env.local`, `.env.<env>`, `.env.<env>.local`)
- Validate the resulting configuration with a [Zod v4](https://zod.dev) schema before your app starts
- Consume the same `env()` helper inside TypeScript configuration files for typed access to `process.env`

## Installation

```bash
npm install @devscast/config zod
```

> `@devscast/config` treats [Zod v4](https://zod.dev) as a required peer dependency, so make sure it is present in your project.
> This package imports from `zod/mini` internally to keep bundles lean. If your schemas only rely on the features exposed by the mini build (objects, strings, numbers, enums, unions, coercion, effects, etc.), consider importing `z` from `zod/mini` in your own code as well for consistent tree-shaking.
> **Need YAML or INI parsing?** Install the optional peers alongside the core package:
>
> ```bash
> npm install yaml ini
> ```

### Example Usage

```ts
import path from "node:path";
import { z } from "zod/mini";
import { loadConfig } from "@devscast/config";

const schema = z.object({
  database: z.object({
    host: z.string(),
    port: z.coerce.number(),
    username: z.string(),
    password: z.string(),
  }),
  featureFlags: z.array(z.string()).default([]),
});

const { config, env } = loadConfig({
  schema,
  cwd: process.cwd(),
  env: { path: path.join(process.cwd(), ".env") },
  sources: [
    path.join("config", "default.yaml"),
    { path: path.join("config", `${env("APP_ENV", { default: "dev" })}.yaml`), optional: true },
    { featureFlags: ["beta-search"] },
  ],
});

console.log(config.database.host);
```

### Additional Use Cases

#### Combine multiple formats with fallbacks

```ts
import path from "node:path";
import { loadConfig } from "@devscast/config";

const { config, env } = loadConfig({
  schema,
  env: true,
  sources: [
    path.join("config", "base.json"),
    path.join("config", "defaults.yaml"),
    { path: path.join("secrets", "overrides.ini"), optional: true },
    { featureFlags: (env.optional("FEATURE_FLAGS") ?? "").split(",").filter(Boolean) },
  ],
});
```

- String entries infer the format from the extension; optional INI/YAML support depends on the peer deps above.
- Inline objects in `sources` are merged last, so they are useful for computed values or environment overrides.

#### Typed environment accessor for reusable helpers

```ts
import { loadConfig } from "@devscast/config";

const { config, env } = loadConfig({
  schema,
  env: {
    path: ".env",
    knownKeys: ["APP_ENV", "DB_HOST", "DB_PORT"] as const,
  },
});

export function createDatabaseUrl() {
  return `postgres://${env("DB_HOST")}:${env("DB_PORT")}/app`;
}
```

- Providing `knownKeys` narrows the `env` accessor typings, surfacing autocomplete within your app.
- The accessor mirrors `process.env` but throws when a key is missing; switch to `env.optional("DB_HOST")` when the variable is truly optional.

#### Environment-only configuration (no external files)

```ts
import { z } from "zod/mini";
import { createEnvAccessor } from "@devscast/config";

const schema = z.object({
  appEnv: z.enum(["dev", "prod", "test"]).default("dev"),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  redisUrl: z.string().url(),
});

const env = createEnvAccessor(["APP_ENV", "APP_PORT", "REDIS_URL"] as const);

const config = schema.parse({
  appEnv: env("APP_ENV", { default: "dev" }),
  port: Number(env("APP_PORT", { default: "3000" })),
  redisUrl: env("REDIS_URL"),
});
```

- `createEnvAccessor` gives you the same typed helper without invoking `loadConfig`, ideal for lightweight scripts.
- You can still validate the derived values with Zod (or any other validator) before using them.

#### Executable TypeScript configuration modules

```ts
// config/services.ts
import type { EnvAccessor } from "@devscast/config";

export default ({ env }: { env: EnvAccessor<string> }) => ({
  redis: {
    host: env("REDIS_HOST"),
    port: Number(env("REDIS_PORT", { default: "6379" })),
  },
});

// loader
import path from "node:path";
import { loadConfig } from "@devscast/config";

const { config } = loadConfig({
  schema,
  sources: [
    { path: path.join("config", "services.ts"), format: "ts" },
  ],
});
```

- TS sources run inside a sandbox with the same `env` helper, so you can compute complex structures at load time.
- Returning a function lets you access the accessor argument explicitly; you can also export plain objects if no logic is needed.

### Referencing environment variables

- **Text-based configs** (JSON, YAML, INI): use `%env(DB_HOST)%`
- **TypeScript configs**: call `env("DB_HOST")`; the helper is available globally when the module is evaluated
  - For tighter autocomplete you can build a project-local accessor via `createEnvAccessor(["DB_HOST", "DB_PORT"] as const)`

The `env()` helper throws when the variable is missing. Provide a default with `env("PORT", { default: "3000" })` or switch to `env.optional("PORT")`.

### Dotenv loading

`loadConfig` automatically understands `.env` files when the `env` option is provided. The resolver honours the following precedence, mirroring Symfony's Dotenv component:

1. `.env` (or `.env.dist` when `.env` is missing)
2. `.env.local` (skipped when `APP_ENV === "test"`)
3. `.env.<APP_ENV>`
4. `.env.<APP_ENV>.local`

Local files always win over base files. The loaded keys are registered on the shared `env` accessor so they show up in editor autocomplete once your editor reloads types.

### Command expansion opt-in

Command substitution via `$(...)` is now opt-in for `.env` files. By default these sequences are kept as literal strings. To re-enable shell execution, add a directive comment at the top of the file:

```dotenv
# @dotenv-expand-commands
SECRET_KEY=$(openssl rand -hex 32)
```

Once the tag is present, all subsequent entries can use command expansion; omitting it keeps parsing side-effect free.
If a command exits with a non-zero status or otherwise fails, the parser now keeps the original `$(...)` literal so `.env` loading continues without interruption.

## Contributors

<a href="https://github.com/devscast/config-ts/graphs/contributors" title="show all contributors">
  <img src="https://contrib.rocks/image?repo=devscast/config-ts" alt="contributors"/>
</a>
