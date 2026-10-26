// 本番ログイン不具合の切り分け用（テストユーザーで実行し、終了時に掃除する）。個人データ・秘密は出力しない。
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { adminClient, listTestUsers } from "./lib/test-cleanup.mjs";
import { cleanupTestData } from "./lib/test-cleanup.mjs";

const base = process.env.E2E_BASE_URL ?? "https://toreca-app.vercel.app";
const admin = adminClient();
const email = "rls-test-debug@example.invalid";
const password = randomUUID() + "Aa1!";

const existing = (await listTestUsers(admin)).find((u) => u.email === email);
if (existing) await admin.auth.admin.updateUserById(existing.id, { password });
else await admin.auth.admin.createUser({ email, password, email_confirm: true });

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("response", (r) => {
  const u = new URL(r.url());
  if (u.origin === base && (r.request().method() === "POST" || r.status() >= 300)) console.log("HTTP", r.request().method(), u.pathname, r.status());
});
page.on("console", (m) => m.type() === "error" && console.log("console.error:", m.text().slice(0, 200)));
await page.goto(`${base}/login`);
await page.getByLabel("メールアドレス").fill(email);
await page.getByLabel("パスワード").fill(password);
await page.getByRole("button", { name: "ログイン" }).click();
await page.waitForTimeout(6000);
console.log("URL after login:", page.url().replace(base, ""));
console.log("alert text:", (await page.getByRole("alert").allInnerTexts()).join(" | ") || "(none)");
const cookies = (await page.context().cookies()).map((c) => `${c.name.replace(/[A-Za-z0-9_-]{12,}/g, "…")} httpOnly=${c.httpOnly} secure=${c.secure} sameSite=${c.sameSite}`);
console.log("cookies:", cookies);
await browser.close();
await cleanupTestData({ execute: true });
