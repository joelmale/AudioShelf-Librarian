import { config as loadEnv } from "dotenv";
import { ConfigSchema, type Config } from "@audioshelf/shared";

export function loadConfig(): Config {
  loadEnv({ quiet: true });

  const raw = {
    ABS_URL: process.env.ABS_URL,
    ABS_TOKEN: process.env.ABS_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    LIBRARY_DIR: process.env.LIBRARY_DIR,
    INBOX_DIR: process.env.INBOX_DIR,
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
