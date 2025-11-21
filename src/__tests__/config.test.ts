import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";

import {
  ConfigFileNotFoundError,
  ConfigParseError,
  ConfigValidationError,
  defineConfig,
} from "../config";

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

describe("defineConfig", () => {
  it("loads configuration from JSON", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        password: z.string(),
        port: z.number(),
        username: z.string(),
      }),
      features: z.array(z.string()),
    });

    const { config } = defineConfig({
      env: false,
      schema,
      sources: path.join(fixturesDir, "config.json"),
    });

    expect(config.database.host).toBe("localhost");
    expect(config.database.port).toBe(5432);
    expect(config.features).toEqual(["analytics", "notifications"]);
  });

  it("loads configuration from YAML", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        password: z.string(),
        port: z.number(),
        username: z.string(),
      }),
      features: z.array(z.string()),
    });

    const { config } = defineConfig({
      env: false,
      schema,
      sources: path.join(fixturesDir, "config.yaml"),
    });

    expect(config.database).toMatchObject({
      host: "localhost",
      password: "securepassword",
      port: 5432,
      username: "admin",
    });
    expect(config.features).toEqual(["analytics", "notifications"]);
  });

  it("loads configuration from INI", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        password: z.string(),
        port: z.coerce.number(),
        username: z.string(),
      }),
      features: z.object({
        items: z.array(z.string()),
      }),
    });

    const { config } = defineConfig({
      env: false,
      schema,
      sources: path.join(fixturesDir, "config.ini"),
    });

    expect(config.database.port).toBe(5432);
    expect(config.features.items).toEqual(["analytics", "notifications"]);
  });

  it("merges multiple sources with later overrides", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        password: z.string(),
        port: z.number(),
        username: z.string(),
      }),
      features: z.array(z.string()),
    });

    const { config } = defineConfig({
      defaults: {
        database: { host: "default", password: "default", port: 1000, username: "default" },
        features: ["defaults"],
      },
      env: false,
      schema,
      sources: [
        path.join(fixturesDir, "config.json"),
        path.join(fixturesDir, "config.yaml"),
        { database: { password: "overridden" } },
      ],
    });

    expect(config.database.password).toBe("overridden");
    expect(config.database.host).toBe("localhost");
    expect(config.features).toEqual(["analytics", "notifications"]);
  });

  it("replaces placeholders using environment files", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        password: z.string(),
        port: z.number(),
        username: z.string(),
      }),
      services: z.object({
        url: z.string(),
      }),
    });

    const { config } = defineConfig({
      env: {
        defaultEnv: "dev",
        environment: "prod",
        path: path.join(envDir, ".env"),
      },
      schema,
      sources: path.join(fixturesDir, "config.env.yaml"),
    });

    expect(config.database.host).toBe("from-env-prod-local");
    expect(config.database.username).toBe("from-env-user");
    expect(config.database.password).toBe("from-env-prod-password");
    expect(config.services.url).toBe("https://prod-local-api.internal/v1");
  });

  it("supports inline configuration objects after loading env files", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
        port: z.number(),
      }),
      featureFlags: z.string(),
    });

    const { config } = defineConfig({
      env: {
        defaultEnv: "dev",
        environment: "prod",
        path: path.join(envDir, ".env"),
      },
      schema,
      sources: {
        database: { host: "%env(DB_HOST)%", port: "%env(number:DB_PORT)%" },
        featureFlags: "%env(FEATURE_FLAGS)%",
      },
    });

    expect(config.database.host).toBe("from-env-prod-local");
    expect(config.database.port).toBe(7777);
    expect(config.featureFlags).toBe("one,two,local");
  });

  it("rejects TypeScript configuration files", () => {
    const schema = z.object({
      value: z.optional(z.string()),
    });

    expect(() =>
      defineConfig({
        env: false,
        schema,
        sources: path.join(fixturesDir, "config.ts"),
      }),
    ).toThrow(ConfigParseError);
  });

  it("throws validation error when schema does not match", () => {
    const schema = z.object({
      database: z.object({
        host: z.string(),
      }),
    });

    expect(() =>
      defineConfig({
        env: false,
        schema,
        sources: { feature: "flag" } as unknown as Record<string, unknown>,
      }),
    ).toThrow(ConfigValidationError);
  });

  it("throws file not found error when missing required source", () => {
    const schema = z.object({ ok: z.optional(z.boolean()) });

    expect(() =>
      defineConfig({
        env: false,
        schema,
        sources: { path: path.join(fixturesDir, "missing.json") },
      }),
    ).toThrow(ConfigFileNotFoundError);
  });

  it("ignores optional sources", () => {
    const schema = z.object({ key: z.string() });
    process.env.KEY = "value";

    const { config } = defineConfig({
      defaults: { key: "fallback" },
      schema,
      sources: [
        { optional: true, path: path.join(fixturesDir, "missing.json") },
        { key: "%env(KEY)%" },
      ],
    });

    expect(config.key).toBe("value");
  });
});

describe("typed %env(...)% placeholders", () => {
  it("supports number placeholders (native type when standalone, string when embedded)", () => {
    process.env.PORT = "8080";

    const schema = z.object({
      port: z.number(),
      url: z.string(),
    });

    const { config } = defineConfig({
      env: false,
      schema,
      sources: [{ port: "%env(number:PORT)%", url: "http://localhost:%env(number:PORT)%" }],
    });

    expect(config.port).toBe(8080);
    expect(typeof config.port).toBe("number");
    expect(config.url).toBe("http://localhost:8080");
  });

  it("supports boolean placeholders (native type)", () => {
    process.env.FEATURE_ONE = "true";
    process.env.FEATURE_TWO = "0"; // falsey

    const schema = z.object({
      featureOne: z.boolean(),
      featureTwo: z.boolean(),
    });

    const { config } = defineConfig({
      env: false,
      schema,
      sources: [
        { featureOne: "%env(boolean:FEATURE_ONE)%", featureTwo: "%env(boolean:FEATURE_TWO)%" },
      ],
    });

    expect(config.featureOne).toBe(true);
    expect(config.featureTwo).toBe(false);
  });

  it("accepts explicit string type and interpolates inside larger strings", () => {
    process.env.NAME = "service";

    const schema = z.object({
      location: z.string(),
      name: z.string(),
    });

    const { config } = defineConfig({
      env: false,
      schema,
      sources: [{ location: "/srv/%env(string:NAME)%/data", name: "%env(string:NAME)%" }],
    });

    expect(config.name).toBe("service");
    expect(config.location).toBe("/srv/service/data");
  });
});
