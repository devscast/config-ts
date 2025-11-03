import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/mini";

import {
  loadConfig,
  ConfigFileNotFoundError,
  ConfigValidationError,
} from "@/config";

const fixturesDir = path.resolve(__dirname, "fixtures");
const envDir = path.join(fixturesDir, "env");

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
  delete process.env.NODE_DOTENV_VARS;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  delete process.env.NODE_DOTENV_VARS;
});

describe("loadConfig", () => {
  it("loads configuration from JSON", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        port: z.number(),
        username: z.string(),
        password: z.string(),
      }),
      features: z.array(z.string()),
    });

    const { config } = loadConfig({
      schema,
      sources: path.join(fixturesDir, "config.json"),
      env: false,
    });

    expect(config.database.host).toBe("localhost");
    expect(config.database.port).toBe(5432);
    expect(config.features).toEqual(["analytics", "notifications"]);
  });

  it("loads configuration from YAML", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        port: z.number(),
        username: z.string(),
        password: z.string(),
      }),
      features: z.array(z.string()),
    });

    const { config } = loadConfig({
      schema,
      sources: path.join(fixturesDir, "config.yaml"),
      env: false,
    });

    expect(config.database).toMatchObject({
      host: "localhost",
      port: 5432,
      username: "admin",
      password: "securepassword",
    });
    expect(config.features).toEqual(["analytics", "notifications"]);
  });

  it("loads configuration from INI", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        port: z.coerce.number(),
        username: z.string(),
        password: z.string(),
      }),
      features: z.object({
        items: z.array(z.string()),
      }),
    });

    const { config } = loadConfig({
      schema,
      sources: path.join(fixturesDir, "config.ini"),
      env: false,
    });

    expect(config.database.port).toBe(5432);
    expect(config.features.items).toEqual(["analytics", "notifications"]);
  });

  it("merges multiple sources with later overrides", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        port: z.number(),
        username: z.string(),
        password: z.string(),
      }),
      features: z.array(z.string()),
    });

    const { config } = loadConfig({
      schema,
      defaults: {
        database: { host: "default", port: 1000, username: "default", password: "default" },
        features: ["defaults"],
      },
      sources: [
        path.join(fixturesDir, "config.json"),
        path.join(fixturesDir, "config.yaml"),
        { database: { password: "overridden" } },
      ],
      env: false,
    });

    expect(config.database.password).toBe("overridden");
    expect(config.database.host).toBe("localhost");
    expect(config.features).toEqual(["analytics", "notifications"]);
  });

  it("replaces placeholders using environment files", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        port: z.number(),
        username: z.string(),
        password: z.string(),
      }),
      services: z.object({
        url: z.string(),
      }),
    });

    const { config } = loadConfig({
      schema,
      sources: path.join(fixturesDir, "config.env.yaml"),
      env: {
        path: path.join(envDir, ".env"),
        defaultEnv: "dev",
      },
    });

    expect(config.database.host).toBe("from-env-prod-local");
    expect(config.database.username).toBe("from-env-user");
    expect(config.database.password).toBe("from-env-prod-password");
    expect(config.services.url).toBe("https://prod-local-api.internal/v1");
  });

  it("loads native TypeScript configuration", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        port: z.number(),
      }),
      featureFlags: z.array(z.string()),
    });

    const { config } = loadConfig({
      schema,
      sources: path.join(fixturesDir, "config.env.ts"),
      env: {
        path: path.join(envDir, ".env"),
        defaultEnv: "dev",
      },
    });

    expect(config.database.host).toBe("from-env-prod-local");
    expect(config.database.port).toBe(7777);
    expect(config.featureFlags).toEqual(["one", "two", "local"]);
  });

  it("throws validation error when schema does not match", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
      }),
    });

    expect(() =>
      loadConfig({
        schema,
        sources: { feature: "flag" } as unknown as Record<string, unknown>,
        env: false,
      })
    ).toThrow(ConfigValidationError);
  });

  it("throws file not found error when missing required source", () => {
    const schema = z.object({ ok: z.optional(z.boolean()) });

    expect(() =>
      loadConfig({
        schema,
        sources: { path: path.join(fixturesDir, "missing.json") },
        env: false,
      })
    ).toThrow(ConfigFileNotFoundError);
  });

  it("ignores optional sources", () => {
    const schema = z.object({ key: z.string() });
    process.env.KEY = "value";

    const { config } = loadConfig({
      schema,
      defaults: { key: "fallback" },
      sources: [
        { path: path.join(fixturesDir, "missing.json"), optional: true },
        { key: "%env(KEY)%" },
      ],
    });

    expect(config.key).toBe("value");
  });
});
