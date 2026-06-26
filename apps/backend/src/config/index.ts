import { config as loadEnv } from "dotenv";
import { ConfigSchema, type Config } from "@audioshelf/shared";

export function loadConfig(): Config {
  loadEnv({ quiet: true });

  const raw = {
    PORT: process.env.PORT,
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    console.error("Configuration validation failed:");
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}
