// モック画面のE2E。終了後にサーバーを確実に停止する。
import { spawnSync } from "node:child_process";
import { freePort } from "./lib/port.mjs";

freePort();
const r = spawnSync("npx", ["playwright", "test"], { stdio: "inherit", shell: true, env: { ...process.env, E2E_MODE: "mock" } });
freePort();
process.exit(r.status ?? 1);
