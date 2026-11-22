/** 第2段階の準備部品の検査。**架空データのみ**（実際の抽選原文・本番DBには触れない）。 */
import { describe, expect, it } from "vitest";
import { detectLeaks, detectLeaksStrict, prepareForExternal, selectStratified, sendable, type StoredRow } from "./eval/phase2";

const row = (id: string, stratum: string, text: string | null, fetchedAt = "2099-01-01T00:00:00Z"): StoredRow => ({ id, stratum, text, fetchedAt });
const CLEAN = "サンプルゲーム 北店 抽選販売。応募期間 2099-04-01〜2099-04-08。当選発表 2099-04-12。";

describe("漏洩検出（旧・厳格な規則。比較用に残している）", () => {
  it("メール・電話・郵便番号・住所らしき文字列・氏名ラベル・長い数字・カード番号・トークンつきURL・キー・SNSハンドルを検出する", () => {
    const samples: Record<string, string> = {
      email: "連絡先 dummy.user@example.invalid まで",
      phone: "電話 03-0000-0000",
      postal_address: "〒000-0000 ダミー県",
      address_like: "東京都ダミー区ダミー町1-2-3 に配送",
      person_name_label: "お名前: ダミー太郎",
      long_number: "応募番号 123456789012",
      card_number: "カード 0000 0000 0000 0000",
      url_token: "https://example.invalid/apply?token=abcd1234efgh5678",
      api_key: "api_key=dummysecretvalue",
      sns_handle: "投稿者 @dummy_user01",
    };
    for (const [kind, text] of Object.entries(samples)) expect(detectLeaksStrict(text).map((f) => f.kind), kind).toContain(kind);
    expect(detectLeaksStrict(CLEAN)).toEqual([]);
  });
  it("検出結果は短い抜粋だけ（原文全体を返さない）", () => {
    const f = detectLeaks("お名前: ダミー太郎さんの応募番号 123456789012");
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.sample.length <= 7)).toBe(true);
  });
});

// 実秘密に当たる形のテストデータは、実行時に組み立てる（テストのソースに本物の秘密を埋め込まない）
const part = (...xs: string[]) => xs.join("");
describe("漏洩検出（Stage 10K: 項目名では除外せず、認証・秘密の実値と、入力された私的な値だけを止める）", () => {
  const PUBLIC_PAGES = [
    "応募フォーム お名前（必須） メールアドレス（必須） 電話番号 ご住所 〒 都道府県 を入力してください",
    "お名前: 必須 メールアドレス: 必須 電話番号: 任意 住所: 入力してください",
    "店舗情報 サンプル店 東京都サンプル区サンプル町1-2-3 TEL 03-0000-0000 公式 @sample_shop",
    "応募番号は応募完了メールに記載されます。注文番号をご用意ください。会員番号入力欄",
    "お問い合わせ: shop@example.invalid 営業時間 10:00-20:00 抽選結果は 2099-04-12 に発表",
    "個人情報の取り扱いについて: ご入力いただいた氏名・住所・電話番号・メールアドレスは抽選結果の連絡に利用します",
    CLEAN,
  ];
  it("公開応募ページの定型の項目名・空欄・店舗の公開情報では除外しない（旧規則では除外されていた）", () => {
    for (const t of PUBLIC_PAGES) expect(detectLeaks(t), t.slice(0, 12)).toEqual([]);
    expect(PUBLIC_PAGES.filter((t) => detectLeaksStrict(t).length > 0).length).toBeGreaterThanOrEqual(3); // 旧規則の誤検出（改善前。7件中3件以上）
  });
  it("認証・秘密の実値は止める（APIキー・Bearer・JWT・セッション/Cookie・パスワードの値・認証つきURL・トークンつきURL・有効なカード番号）", () => {
    const secrets: Record<string, string> = {
      api_key: `キー ${part("sk-", "ant-", "x".repeat(24))}`,
      bearer_token: `${part("Bear", "er ")}${"a1".repeat(12)}`,
      jwt: part("ey", "J", "abcdefgh12", ".", "abcdefgh12", ".", "abcdefgh12"),
      session_secret: `${part("session", "id=")}${"ab12".repeat(5)}`,
      credential_value: `${part("pass", "word")}: ${"Zz9".repeat(3)}`,
      basic_auth_url: `https://${part("us", "er")}:${part("pa", "ss12")}@host.example.invalid/x`,
      url_token: `https://host.example.invalid/a?${part("tok", "en")}=${"Ab1".repeat(5)}`,
      card_number: "決済 0000 0000 0000 0000",
    };
    for (const [k, t] of Object.entries(secrets)) expect(detectLeaks(t).length, k).toBeGreaterThan(0);
    expect(detectLeaks("番号 1234 5678 9012 3456")).toEqual([]); // Luhnを満たさない数字の並びは、カード番号として扱わない
  });
  it("実際に入力された私的な値（項目名＋実際の値）は止める。値が無い・「必須」等の記載は止めない", () => {
    for (const t of ["メールアドレス: a.b@example.invalid", "電話番号: 03-0000-0000", "お名前: ダミー太郎", "ご住所: 東京都ダミー区ダミー町1-2-3", "注文番号: 123456789"]) expect(detectLeaks(t).map((f) => f.kind), t).toContain("filled_personal_value");
    for (const t of ["お名前: 必須", "氏名: 例）山田", "メールアドレス:", "電話番号 任意", "お届け先: 加納町（店舗受取）", "お受け取り場所: 神戸市中央区の店舗"]) expect(detectLeaks(t), t).toEqual([]); // 受取場所の欄は私的な値ではない（実測で過検出だった）
  });
  it("検出の抜粋は短く、原文全体を返さない", () => {
    const f = detectLeaks("お名前: ダミー太郎さんの注文番号: 123456789");
    expect(f.length).toBeGreaterThan(0);
    expect(f.every((x) => x.sample.length <= 7)).toBe(true);
  });
});

describe("選定・伏せ字・送信可否の流れ", () => {
  const rows = [
    ...["store_select", "per_store", "per_product", "multi", "chain_name", "deadline_change"].flatMap((s) => [1, 2, 3, 4, 5, 6].map((n) => row(`${s}-${n}`, s, `${CLEAN} (${s}${n})`, `2099-01-0${n}T00:00:00Z`))),
    row("u-1", "unfetchable", null),
    row("u-2", "unfetchable", null),
    row("u-3", "unfetchable", null),
    row("u-4", "unfetchable", null),
  ];
  it("層ごとに均等に近く選び、上限30件・原文なしは最大3件。決定的で、新しい原文を優先", () => {
    const a = selectStratified(rows);
    expect(a.length).toBe(30);
    expect(a.filter((r) => r.text == null).length).toBeLessThanOrEqual(3);
    const per = a.reduce<Record<string, number>>((m, r) => ((m[r.stratum] = (m[r.stratum] ?? 0) + 1), m), {});
    const withText = Object.entries(per).filter(([k]) => k !== "unfetchable").map(([, v]) => v);
    expect(Math.max(...withText) - Math.min(...withText)).toBeLessThanOrEqual(1);
    expect(selectStratified(rows).map((r) => r.id)).toEqual(a.map((r) => r.id));
    expect(a.find((r) => r.stratum === "store_select")!.id).toBe("store_select-6"); // 新しいものが先
    expect(selectStratified(rows, 5).length).toBe(5);
  });
  it("伏せ字後も漏洩が残る原文は除外。人の全件確認の記録がない原文は送信不可。確認済みでクリーンな原文だけ送れる。元の識別子は出力に含まれない", () => {
    const rs = [
      row("a", "x", `${CLEAN} 担当 dummy@example.invalid 電話 03-0000-0000`), // 伏せ字で消える
      row("b", "x", `${CLEAN} お名前: ダミー太郎`), // 伏せ字では消えない
      row("c", "x", `${CLEAN} 応募番号 123456789012`),
      row("d", "x", CLEAN),
      row("e", "x", null),
    ];
    const p = prepareForExternal(rs, new Set(["a", "d"]));
    expect(p.map((x) => x.decision)).toEqual(["ready", "excluded_leak", "excluded_leak", "ready", "excluded_no_text"]);
    expect(p[0].text).not.toContain("dummy@example.invalid");
    expect(p[0].text).not.toContain("03-0000-0000");
    expect(sendable(p).length).toBe(2);
    const unreviewed = prepareForExternal([row("d", "x", CLEAN)], new Set());
    expect(unreviewed[0].decision).toBe("needs_human_review");
    expect(sendable(unreviewed)).toEqual([]);
    expect(JSON.stringify(p)).not.toContain('"id"');
  });
});
