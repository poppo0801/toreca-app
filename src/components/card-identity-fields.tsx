"use client";

import { useState } from "react";
import { ComboInput } from "@/components/combo-input";
import { numberChoices, resolveSet, setsForKnownNumber, type ExpansionMark } from "@/lib/zukan/expansion";
import { completeSetFromNumber, rarityCandidates, setOptions, type KnownCard } from "@/lib/zukan/zukan";

const FIELD = "mt-0.5 h-10 w-full rounded-md border bg-input px-2.5 text-sm";

export interface CardIdentity {
  setName: string;
  cardNumber: string;
  rarity: string;
}

const nk = (v: string) => v.normalize("NFKC").replace(/[\s　]+/g, "").toLowerCase();

/**
 * 収録セット・番号・レア（151図鑑・相場調査メモ共通）。**番号とレアリティの候補は独立**（番号を選んでもレアリティは変わらない）。
 *  - 番号: タップで候補一覧（番号単独。これまで入力した番号＋収録パックマスターのエキスパンションマーク）。先頭1文字から絞り込み、一覧に無い番号は自由入力。
 *    番号から収録セットを補完する: マスターで**一意に決まり、収録セットが空のときだけ自動入力**。複数の商品に対応するときは選択肢を出す。
 *    入力済みの収録セットと食い違うときは**上書きしない**（注意だけ表示）。自動入力した収録セットは、番号を直すと追従する（利用者が編集した値は変えない）。
 *  - レア: タップで候補一覧（最近使った順→一般的な表記）。先頭1文字から絞り込み。一覧に無い値は自由入力。
 *  - 番号・レアは未入力でも登録できる（後から「未入力の確認」でまとめて補完できる）。
 * 画面上の呼称は「番号」（開発中の呼称は使わない）。
 */
export function CardIdentityFields({ v, onChange, known, masters = [], ids }: { v: CardIdentity; onChange: (v: CardIdentity) => void; known: KnownCard[]; masters?: ExpansionMark[]; ids: { set: string; number: string; rarity: string; setList: string } }) {
  const [auto, setAuto] = useState(""); // 自動入力した収録セット
  const numOptions = numberChoices(masters, known, v.cardNumber).map((c) => ({
    key: c.value,
    value: c.value,
    label: (
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <b className="shrink-0 tabular-nums">{c.value}</b>
        {c.hint && <span className="min-w-0 truncate text-[11px] text-muted-foreground">{c.hint}</span>}
      </span>
    ),
  }));
  const rarOptions = rarityCandidates(known, v.rarity).map((r) => ({ key: r, value: r, label: <b>{r}</b> }));
  const setNames = [...new Set([...setOptions(known), ...masters.filter((m) => m.active).map((m) => m.setName)])];
  // 収録セットが空、または自動入力したままなら「未入力」として扱い、番号の変更に追従する
  const setIsAuto = !!auto && nk(v.setName) === nk(auto);
  const res = resolveSet(masters, v.cardNumber, setIsAuto ? "" : v.setName);
  // マークでない番号が複数の収録セットにあるとき（既知のカードから）も、選択肢を出す
  const knownSets = res.status === "none" && (!v.setName.trim() || setIsAuto) ? setsForKnownNumber(known, v.cardNumber) : [];
  const choices = res.status === "multiple" ? res.choices : knownSets.length > 1 ? knownSets : [];
  const changeNumber = (val: string) => {
    const r = resolveSet(masters, val, setIsAuto ? "" : v.setName);
    // マークでない番号（100/106 など）は、その番号を持つ既知のカードの収録セットが1種類のときだけ補完する
    const known1 = r.status === "none" && (!v.setName.trim() || setIsAuto) ? completeSetFromNumber(known, val) : null;
    if (r.status === "unique" || known1) {
      const name = r.status === "unique" ? r.setName : (known1 as string);
      setAuto(name);
      onChange({ ...v, cardNumber: val, setName: name });
    } else {
      // 自動入力した値が不要になった（マスターに無い・複数候補）ときは空に戻す。利用者が入力した値は変えない
      if (setIsAuto) setAuto("");
      onChange({ ...v, cardNumber: val, ...(setIsAuto ? { setName: "" } : {}) });
    }
  };
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="card-identity-fields">
      <label className="block text-sm">
        <span className="text-[13px] font-medium">収録セット（任意）</span>
        <input
          value={v.setName}
          onChange={(e) => {
            setAuto("");
            onChange({ ...v, setName: e.target.value });
          }}
          list={ids.setList}
          className={FIELD}
          maxLength={120}
          autoComplete="off"
          data-testid={ids.set}
        />
        <datalist id={ids.setList}>
          {setNames.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className="block text-sm">
          <span className="text-[13px] font-medium">番号</span>
          <ComboInput value={v.cardNumber} onChange={changeNumber} options={numOptions} className={FIELD} maxLength={20} testId={ids.number} />
        </div>
        <div className="block text-sm">
          <span className="text-[13px] font-medium">レア</span>
          <ComboInput value={v.rarity} onChange={(val) => onChange({ ...v, rarity: val })} options={rarOptions} className={FIELD} maxLength={10} testId={ids.rarity} />
        </div>
      </div>
      {choices.length > 1 && !choices.some((c) => nk(c) === nk(v.setName)) && (
        <div className="col-span-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="set-choices">
          <span className="text-muted-foreground">この番号の収録セットを選択:</span>
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              className="min-h-8 rounded-md border px-2 font-medium"
              onClick={() => {
                setAuto(c);
                onChange({ ...v, setName: c });
              }}
              data-testid="set-choice"
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {res.status === "conflict" && (
        <p className="col-span-2 text-[11px] text-warn" data-testid="set-conflict">
          マスターでは「{v.cardNumber.trim()}」は {res.choices.join("／")} です。入力済みの収録セットはそのままにしています。
        </p>
      )}
    </div>
  );
}
