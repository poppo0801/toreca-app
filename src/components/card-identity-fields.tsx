"use client";

import { ComboInput } from "@/components/combo-input";
import { completeSetFromNumber, numberCandidates, rarityCandidates, setOptions, type KnownCard } from "@/lib/zukan/zukan";

const FIELD = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";

export interface CardIdentity {
  setName: string;
  cardNumber: string;
  rarity: string;
}

/**
 * 収録セット・番号・レア（151図鑑・相場調査メモ共通）。
 *  - 番号: タップで候補一覧（番号・収録セット・レアリティ。最近使った順）。先頭1文字から絞り込み。候補を選ぶと収録セットとレアリティを補完する。
 *    同じ番号が複数のセットにあるときは、候補が別々に並ぶので正しいものを選ぶ。一覧に無い番号は自由入力。番号だけでセットを推測して入れるのは、
 *    その番号を持つ既知のセットが1種類のときだけ（誤った補完をしない）。
 *  - レア: タップで候補一覧（最近使った順→一般的な表記）。先頭1文字から絞り込み。一覧に無い値は自由入力。
 *  - 候補は実際に登録されたデータ（known）だけが根拠。
 * 画面上の呼称は「番号」（開発中の呼称は使わない）。
 */
export function CardIdentityFields({ v, onChange, known, ids }: { v: CardIdentity; onChange: (v: CardIdentity) => void; known: KnownCard[]; ids: { set: string; number: string; rarity: string; setList: string } }) {
  const numOptions = numberCandidates(known, v.cardNumber).map((c) => ({
    key: `${c.cardNumber}|${c.setName}|${c.rarity}`,
    value: c.cardNumber,
    label: (
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <b className="shrink-0 tabular-nums">{c.cardNumber}</b>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{[c.setName, c.rarity].filter(Boolean).join(" ・ ")}</span>
      </span>
    ),
    pick: c,
  }));
  const rarOptions = rarityCandidates(known, v.rarity).map((r) => ({ key: r, value: r, label: <b>{r}</b> }));
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="card-identity-fields">
      <label className="block text-sm">
        <span className="text-[13px] font-medium">収録セット（任意）</span>
        <input value={v.setName} onChange={(e) => onChange({ ...v, setName: e.target.value })} list={ids.setList} className={FIELD} maxLength={120} autoComplete="off" data-testid={ids.set} />
        <datalist id={ids.setList}>
          {setOptions(known).map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className="block text-sm">
          <span className="text-[13px] font-medium">番号</span>
          <ComboInput
            value={v.cardNumber}
            onChange={(val) => {
              const guess = !v.setName.trim() ? completeSetFromNumber(known, val) : null;
              onChange({ ...v, cardNumber: val, ...(guess ? { setName: guess } : {}) });
            }}
            options={numOptions}
            onPick={(o) => {
              const c = numOptions.find((x) => x.key === o.key)?.pick;
              if (c) onChange({ cardNumber: c.cardNumber, setName: c.setName || v.setName, rarity: c.rarity || v.rarity });
            }}
            className={FIELD}
            maxLength={20}
            testId={ids.number}
          />
        </div>
        <div className="block text-sm">
          <span className="text-[13px] font-medium">レア</span>
          <ComboInput value={v.rarity} onChange={(val) => onChange({ ...v, rarity: val })} options={rarOptions} className={FIELD} maxLength={10} testId={ids.rarity} />
        </div>
      </div>
    </div>
  );
}
