// 使い方: npm run cleanup:testdata            ... 対象の確認のみ
//         npm run cleanup:testdata -- --execute ... 実際に削除
import { cleanupTestData } from "./lib/test-cleanup.mjs";

await cleanupTestData({ execute: process.argv.includes("--execute") });
