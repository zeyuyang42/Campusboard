import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Walk up until we find the workspace root (the directory holding both web/ and server/).
function findRoot(): string {
  let dir = here;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "web")) && existsSync(path.join(dir, "server"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return process.cwd();
}

export const ROOT_DIR = findRoot();
export const PORT = Number(process.env.PORT ?? 3001);
export const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT_DIR, "data");
export const DB_PATH = path.join(DATA_DIR, "library.db");
export const WEB_DIST = path.join(ROOT_DIR, "web", "dist");
export const RATE_LIMIT_MS = Number(process.env.RATE_LIMIT_MS ?? 1000);
export const PAGE_CACHE_MS = 10 * 60 * 1000;
export const STREAM_SAFETY_MS = 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 20_000;
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
