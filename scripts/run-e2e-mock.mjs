// モック画面のE2E。終了後にサーバーを確実に停止する。
import { spawnSync } from "node:child_process";
import { ISOLATED_AGENT_ENV } from "./lib/e2e-env.mjs";
import { freePort } from "./lib/port.mjs";

freePort();
const r = spawnSync("npx", ["playwright", "test"], { stdio: "inherit", shell: true, env: { ...process.env, ...ISOLATED_AGENT_ENV, E2E_MODE: "mock" } });
freePort();
process.exit(r.status ?? 1);
