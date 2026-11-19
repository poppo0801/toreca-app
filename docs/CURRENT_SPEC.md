# トレマネ 現行仕様・方針の入口

更新日: 2026-11-19。**この文書は参照索引と採用済み方針の要約であり、初期PRDを置換しない。** 不明点は推測で補わない。

## 文書の読み方
1. 開発目的とAIの役割: `docs/PRODUCT_VISION.md`（Stage 8D時点の実装状況・ロードマップは歴史的記述）
2. 機能要件: `requirements.md`（2026-10-26初期版。最新の採用決定や実装状況を網羅しない）
3. 仕様管理・矛盾処理: `docs/SPEC_GOVERNANCE.md`、`docs/SPEC_ALIGNMENT.md`
4. UI原則: `docs/UI_UX_GUIDELINES.md`、旧画面案 `ui-spec.md`
5. 実装構成: `docs/ARCHITECTURE.md` と実コード、DBの事実は `supabase/migrations/`
6. 決定理由: `docs/DEVELOPMENT_LOG.md`、実装結果: `docs/stage*.md`、本番移行: `docs/RELEASE_FLOW.md`
7. 今後の作業: `docs/ACTIVE_ROADMAP.md`。旧 `implementation-plan.md` は初期計画として残す。

## 最上位の採用済み方針
- 家族・複数プロフィールの抽選・応募・当選・購入管理を維持しつつ、**AIが自律的に調査対象・手段・追加調査・照合・判断・登録を主導する**ことを追求する。AIを固定ルールの補助役に限定しない。
- 検索や調査計画はAIに裁量を与える。既存ロジックは計算、通知、認可、整合性、費用上限、履歴保護等の補助・安全機構とする。既存実装を維持すること自体は目的ではない。
- 評価は単体テストの合格だけでなく、**実際の正しい発見・登録・補完・応募構造判定・重複抑制・費用**で行う。
- 人が確定した情報、応募・当選・購入履歴、機密情報を保護し、変更の監査と復元を確保する。
- 系列・商品名の同一性と、抽選応募機会の同一性は別問題。名称の名寄せを抽選カードの無条件統合に結び付けない。
- 仕様は提案／正式採用／実装済み／本番反映済み／検証済みを混同しない。

## 主要機能の参照先（要件と実装の差分に注意）
| 領域 | 基本要件 | 変更・実装の記録 |
|---|---|---|
| プロフィール・応募アカウント | `requirements.md` §2 | `docs/DEVELOPMENT_LOG.md` |
| 系列・店舗・商品・抽選 | 同 §3〜4 | `docs/DEVELOPMENT_LOG.md`、Stage 7〜9系記録 |
| カード・画面・通知 | 同 §5〜6 | `docs/UI_UX_GUIDELINES.md`、Stage UI系記録 |
| 応募・当選・購入 | 同 §7 | Stage 7〜9系記録、実コード |
| 収集・AI・名寄せ・応募方式 | `docs/PRODUCT_VISION.md` | Stage 8D〜9系記録、`docs/SPEC_ALIGNMENT.md` |
| 運用・DB・復元 | 同 §11、`docs/RELEASE_FLOW.md` | `docs/ARCHITECTURE.md`、マイグレーション、実デプロイ |

## 未解決事項の扱い
旧資料と最新の正式決定が矛盾する場合は `docs/SPEC_ALIGNMENT.md` に記録する。コードの現在の動作を、ユーザーが採用した仕様の代わりにしない。判断を要する仕様変更はユーザーへ確認する。
