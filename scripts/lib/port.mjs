// E2Eが使うポート(3100)に残った自プロジェクトのサーバーを停止する（Playwrightが子プロセスを残すことがあるため）。
import { execFileSync } from "node:child_process";

export function freePort(port = 3100) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
      const pids = new Set(
        out
          .split("\n")
          .filter((l) => l.includes(`:${port} `) && l.includes("LISTENING"))
          .map((l) => l.trim().split(/\s+/).pop()),
      );
      for (const pid of pids) execFileSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore" });
    } else {
      const out = execFileSync("sh", ["-c", `lsof -ti tcp:${port} -sTCP:LISTEN || true`], { encoding: "utf8" });
      out.split("\n").filter(Boolean).forEach((pid) => process.kill(Number(pid), "SIGTERM"));
    }
  } catch {
    /* 何も動いていなければ無視 */
  }
}
