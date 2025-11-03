export default () => ({
  database: {
    host: env("DB_HOST"),
    port: Number(env("DB_PORT")),
  },
  featureFlags: env("FEATURE_FLAGS", { default: "" })
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
});
