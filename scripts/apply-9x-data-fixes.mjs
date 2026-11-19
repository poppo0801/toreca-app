// Stage 9X 承認済みのデータ修正（利用者の承認: 2026-11-19）。既定は dry-run（何も書き込まない）。
//   npm run prod -- scripts/apply-9x-data-fixes.mjs --yes-production              # 内容の確認（dry-run）
//   npm run prod -- scripts/apply-9x-data-fixes.mjs --execute --yes-production     # 実行（変更前の内容を backups/9x-data/ に保存）
//   npm run prod -- scripts/apply-9x-data-fixes.mjs --restore <保存ファイル> --yes-production   # 元に戻す
// 内容:
//  1. 公式情報で確認済みの3店舗の都道府県（空のときだけ）: BOOKOFF 新宿駅西口店=東京都 / カードラボ 川崎店・マルイ海老名店=神奈川県
//  2. 複数店舗が1つの名前になっている店舗のうち、情報源（応募フォーム・LivePocket）で「応募時に店舗を選ぶ」ことを確認できたもの（ティアワン・トレカラウンジ）を、
//     店舗選択式の抽選（選べる店舗つき）に直し、複合名の店舗マスターは、他から参照されていなければアーカイブ（削除しない）。
//     WonderGOO の1件は情報源（X）を取得できず構成を確認できないため、変更しない。
//  3. 所在地が未確認の6店舗は更新しない（保留）。
// 応募・当選・購入の履歴は変更しない（対象の抽選に応募・購入の記録がある場合は、その抽選を変更せず中止する）。
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { assertProductionTarget } from "./lib/target.mjs";

assertProductionTarget("apply-9x-data-fixes.mjs");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const args = process.argv.slice(2);
const execute = args.includes("--execute");
const restoreIdx = args.indexOf("--restore");
const PLACEHOLDER = "応募時に店舗選択";

const PREF_FIXES = [
  { storeId: "1019a9be-ab02-4aaf-aa2d-846d1f08ccff", expectName: "新宿駅西口店", prefecture: "東京都", evidence: "BOOKOFF公式の店舗一覧（東京都新宿区西新宿1-10-2）" },
  { storeId: "7068b2e1-b3fe-4adf-b8f8-3c9e4988ef26", expectName: "川崎店", prefecture: "神奈川県", evidence: "カードラボ公式の店舗ページ（神奈川県川崎市川崎区）" },
  { storeId: "88f2e673-fa05-4cef-8dc2-25edcb2da744", expectName: "マルイ海老名店", prefecture: "神奈川県", evidence: "カードラボ公式の店舗ページ（神奈川県海老名市中央1-6-1）" },
];
const SPLITS = [
  {
    lotteryId: "9fc3f334-e0e1-4c17-bd9b-89c9914df108", storeId: "db0e99f6-f28d-4fc6-b6fb-af8d271b02d1", expectName: "渋谷店、浜松店",
    choices: [{ name: "渋谷店", prefecture: "東京都" }, { name: "浜松店", prefecture: "静岡県" }],
    evidence: "応募フォーム（Googleフォーム）に必須の選択項目「購入希望店舗: 渋谷店／浜松店」があり、1つのフォームで店舗を選んで応募する。応募・当選連絡・購入は選んだ店舗ごと（所在地は告知に明記）",
  },
  {
    lotteryId: "6f046e88-aef2-4cf4-899e-c0e10ba51a29", storeId: "df458ae5-e234-4cae-b4b4-aba2b53df11e", expectName: "トレカラウンジ秋葉原本店・トレカラウンジ別館買取センター",
    choices: [{ name: "トレカラウンジ秋葉原本店", prefecture: "東京都" }, { name: "トレカラウンジ別館買取センター", prefecture: "東京都" }],
    evidence: "LivePocketの告知に「対象店舗: 秋葉原本店・別館買取センター／どちらか1店舗のみ／引き換え店舗をお間違えないように」とあり、1つの抽選で店舗を選ぶ（会場は東京都）",
  },
];

if (restoreIdx >= 0) {
  const file = args[restoreIdx + 1];
  const b = JSON.parse(readFileSync(file, "utf8"));
  for (const s of b.stores ?? []) await db.from("stores").update({ prefecture: s.prefecture, archived_at: s.archived_at }).eq("id", s.id);
  for (const l of b.lotteries ?? []) await db.from("lotteries").update({ store_mode: l.store_mode, store_id: l.store_id, selectable_stores: l.selectable_stores, lottery_form: l.lottery_form, lottery_form_source: l.lottery_form_source }).eq("id", l.id);
  for (const id of b.createdStoreIds ?? []) await db.from("stores").delete().eq("id", id);
  console.log("復元しました:", file);
  process.exit(0);
}

const ops = []; // 書き込み（実行時のみ。変更前の内容を保存してから順に実行する）
const out = { at: new Date().toISOString(), execute, actions: [], skipped: [], stores: [], lotteries: [], createdStoreIds: [] };
const note = (a) => { out.actions.push(a); console.log("•", a); };
const skip = (a) => { out.skipped.push(a); console.log("× 変更しない:", a); };

// ---- 1. 都道府県
for (const f of PREF_FIXES) {
  const { data: st } = await db.from("stores").select("id,name,prefecture,archived_at,sales_kind,chain_id").eq("id", f.storeId).maybeSingle();
  if (!st || st.name !== f.expectName) { skip(`店舗 ${f.expectName}: 想定の店舗が見つかりません`); continue; }
  if (st.prefecture && st.prefecture !== '""') { skip(`店舗 ${st.name}: 既に都道府県が設定済み（${st.prefecture}）`); continue; }
  if (st.sales_kind === "online_only") { skip(`店舗 ${st.name}: 通販専用のため対象外`); continue; }
  note(`店舗「${st.name}」の都道府県 ${JSON.stringify(st.prefecture)} → ${f.prefecture}（根拠: ${f.evidence}）`);
  out.stores.push({ id: st.id, prefecture: st.prefecture, archived_at: st.archived_at });
  ops.push(async () => { const r = await db.from("stores").update({ prefecture: f.prefecture }).eq("id", st.id).eq("prefecture", st.prefecture); if (r.error) throw new Error(r.error.message); });
}

// ---- 2. 店舗選択式への変更
for (const sp of SPLITS) {
  const { data: lots } = await db.from("lotteries").select("*").eq("id", sp.lotteryId);
  const l = (lots ?? [])[0];
  const { data: st } = await db.from("stores").select("id,name,chain_id,archived_at,prefecture,household_id").eq("id", sp.storeId).maybeSingle();
  if (!l || !st || st.name !== sp.expectName || l.store_id !== sp.storeId) { skip(`${sp.expectName}: 想定の抽選・店舗が見つかりません（変更しない）`); continue; }
  if (l.store_mode !== "fixed" || l.archived_at) { skip(`${sp.expectName}: 抽選が想定の状態ではありません（${l.store_mode}・アーカイブ=${!!l.archived_at}）`); continue; }
  const [apps, items] = await Promise.all([db.from("applications").select("id", { count: "exact", head: true }).eq("lottery_id", l.id), db.from("lottery_items").select("id,product_id").eq("lottery_id", l.id)]);
  if ((apps.count ?? 0) > 0) { skip(`${sp.expectName}: 応募の記録が${apps.count}件あるため変更しない`); continue; }
  // 同じ系列の仮の「応募時に店舗選択」店舗を探す（無ければ作る）
  const { data: ph } = await db.from("stores").select("id").eq("chain_id", st.chain_id).eq("name", PLACEHOLDER).is("archived_at", null).maybeSingle();
  let phId = ph?.id ?? null;
  note(`抽選 ${l.id.slice(0, 8)}（${sp.expectName}）を店舗選択式に変更: 選べる店舗=${sp.choices.map((c) => `${c.name}（${c.prefecture}）`).join("・")}／店舗マスターは${phId ? "既存の「応募時に店舗選択」" : "新規の「応募時に店舗選択」（仮）"}を使用（根拠: ${sp.evidence}）`);
  out.lotteries.push({ id: l.id, store_mode: l.store_mode, store_id: l.store_id, selectable_stores: l.selectable_stores, lottery_form: l.lottery_form, lottery_form_source: l.lottery_form_source });
  ops.push(async () => {
    if (!phId) {
      const ins = await db.from("stores").insert({ household_id: st.household_id, chain_id: st.chain_id, name: PLACEHOLDER, prefecture: "", is_provisional: true, sales_kind: "physical" }).select("id").single();
      if (ins.error) throw new Error(ins.error.message);
      phId = ins.data.id;
      out.createdStoreIds.push(phId);
    }
    const up = await db.from("lotteries").update({ store_mode: "select_on_apply", store_id: phId, selectable_stores: sp.choices, lottery_form: "store_select", lottery_form_source: "manual" }).eq("id", l.id).eq("store_mode", "fixed");
    if (up.error) throw new Error(up.error.message);
    // 複合名の店舗マスターは、他から参照されていなければアーカイブ（削除しない）
    const [other, rules, aliases] = await Promise.all([
      db.from("lotteries").select("id", { count: "exact", head: true }).eq("store_id", st.id),
      db.from("skip_rules").select("id", { count: "exact", head: true }).eq("store_id", st.id),
      db.from("store_aliases").select("id", { count: "exact", head: true }).eq("store_id", st.id),
    ]);
    if ((other.count ?? 0) + (rules.count ?? 0) + (aliases.count ?? 0) === 0) {
      const ar = await db.from("stores").update({ archived_at: new Date().toISOString() }).eq("id", st.id).is("archived_at", null);
      if (ar.error) throw new Error(ar.error.message);
      console.log(`  複合名の店舗「${st.name}」をアーカイブ（他の参照なし。削除はしない）`);
    } else console.log(`  複合名の店舗「${st.name}」は他から参照されているためアーカイブしない`);
  });
  out.stores.push({ id: st.id, prefecture: st.prefecture, archived_at: st.archived_at }); // 復元用（アーカイブ前の状態）
}
skip("WonderGOO「店舗・新星堂店舗・Ganryu店舗」: 情報源がX投稿で取得できず、店舗構成・応募方式を確認できないため変更しない");
skip("所在地が未確認の6店舗（竜のしっぽ×3・どみなり屋・おもちゃのバンビ本郷店・ふるいち トップブックス中野店）: 承認どおり保留");

if (execute) {
  mkdirSync("backups/9x-data", { recursive: true });
  const file = `backups/9x-data/before-${out.at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(out, null, 1)); // 変更の前に、変更前の内容を保存する
  console.log("変更前の内容を保存:", file);
  for (const op of ops) await op();
  writeFileSync(file, JSON.stringify(out, null, 1)); // 作成した店舗のIDを追記
  console.log("実行しました。");
} else console.log("（dry-run。実行するには --execute）");
