/**
 * 抽選形態の判別（Stage 8F-6・純関数。DB・ネットワークに触れない）。
 *
 * 抽選は、応募受付の「構造」で次のどれかに分ける。
 *   A. store_select      店舗選択式: 1つの抽選企画に対し、応募時に複数店舗から1店舗を選ぶ。カードは1件。グループ化の対象外。
 *   B. store_independent 店舗別独立抽選: 店舗ごとに独立した応募受付・応募記録を持つ。店舗ごとに別カード。同条件ならグループ化の対象。
 *   C. other             通販・単独店舗など、上のどちらでもないもの（既存の方式を維持）。
 *   unknown              構造を確認できない。無理に決めず、既存の登録を尊重し、確認候補として扱う。
 *
 * 重要: 「複数店舗への応募が禁止／1店舗のみ応募できる」は応募の“制限”であり、店舗選択式の証拠ではない（`restrictionOnly`）。
 * 店舗別に独立した受付でも、同じ制限は付く。決め手は、応募時の店舗選択欄・選べる店舗の一覧・店舗ごとの受付/応募先などの“構造”の記載。
 * 判別の優先順位: 利用者の手動の分類（source=manual）> 構造の根拠 > 登録済みの方式。AIや再解析が、手動の分類を根拠なく上書きしない。
 */
export type LotteryForm = "store_select" | "store_independent" | "other" | "unknown";
export type FormSource = "manual" | "rule" | "ai";

/** 利用者が確定した（または収集・AIが記録した）分類。無ければ null */
export interface FormDecl {
  form: Exclude<LotteryForm, "unknown">;
  source: FormSource;
}

export interface FormInput {
  storeMode: "fixed" | "select_on_apply" | "none";
  /** 通販・オンライン専用（店舗を持たない）か */
  online?: boolean;
  receiveMethod?: string;
  /** 登録されている「応募時に選べる店舗」の数 */
  selectableStoreCount?: number;
  requirementTags?: string[];
  /** 抽選の応募条件の文面・取得した情報源の文章など（外部由来＝データとして扱う） */
  texts: string[];
  sourceUrls?: string[];
  /** 同じ系列・同じ商品・重なる期間の別の抽選（比べる相手）。店舗ごとに別の情報源があるかを見る */
  siblings?: { sourceUrls: string[]; storeKey: string | null }[];
  storeKey?: string | null;
  decl?: FormDecl | null;
}

export interface FormSignal {
  code: string;
  label: string;
}

export interface FormJudgement {
  form: LotteryForm;
  /** high=構造の根拠が複数／手動、medium=根拠が1つ、low=確認できない */
  confidence: "high" | "medium" | "low";
  basisKind: "manual" | "structure" | "registered" | "none";
  selectSignals: FormSignal[];
  independentSignals: FormSignal[];
  /** 「1店舗のみ応募」「複数店舗への応募は無効」などの制限の記載がある（構造の証拠ではない） */
  restrictionOnly: boolean;
  /** 構造の根拠が食い違っている（店舗選択式とも店舗別とも読める記載が両方ある） */
  conflict: boolean;
  /** 利用者の手動の分類と、構造の根拠が食い違う（手動を優先し、食い違いは記録だけする） */
  manualDisagrees: boolean;
  basis: string[];
}

const norm = (s: string): string => s.normalize("NFKC").replace(/\s+/g, "");

/** 応募時に店舗を選ぶ構造の記載（選択欄・選べる店舗）。制限（「1店舗のみ」）だけの記載は含めない */
const SELECT_FIELD: RegExp[] = [
  /(受取|受け取り|お受取り|引取|引き取り|お渡し|応募|購入|希望)(する)?店舗(を|が|は)?.{0,4}(選択|選べ|選ん|お選び|ご選択|指定)/,
  /店舗(を|が)?(お)?(選択|選び|選べ|選んで)/,
  /店舗(の中)?から(お)?(選択|選び|選べ|選んで)/,
  /(応募|エントリー)(フォーム|画面|時|の際).{0,12}(店舗|受取店).{0,6}(選択|選べ|選ん|お選び)/,
];
/** 店舗ごとに独立した受付・応募の構造の記載 */
const PER_STORE: RegExp[] = [
  /(各|それぞれの)店舗(で|にて|の)(受付|応募|抽選|実施)/,
  /店舗ごと(の|に)(受付|抽選|応募|申込|実施)/,
  /各店(で|にて|の)(受付|応募|抽選)/,
  /(店頭|店舗)(にて|で)(の)?(応募|受付|申込)/,
  /当店(の|で)(み)?(抽選|応募)/,
  /店舗(を)?またい(で|だ)(の)?(重複)?応募(可|できます|OK)/,
];
/** 応募の制限の記載（構造の証拠ではない） */
const RESTRICTION: RegExp[] = [
  /[1一]店舗(のみ|まで|限り)/,
  /店舗の?(中|うち)から.{0,8}[1一]店舗/,
  /複数店舗.{0,10}(応募|エントリー).{0,8}(不可|禁止|無効|できません)/,
  /(複数店舗|店舗(を)?また).{0,6}(重複|同時).{0,6}(応募|エントリー)/,
  /店舗.{0,6}(重複|複数)(して)?応募.{0,6}(無効|不可|禁止)/,
];

const hit = (res: RegExp[], t: string): boolean => res.some((re) => re.test(t));

export function judgeForm(input: FormInput): FormJudgement {
  const text = norm(input.texts.filter(Boolean).join("\n"));
  const tags = input.requirementTags ?? [];
  const sel: FormSignal[] = [];
  const ind: FormSignal[] = [];
  if (hit(SELECT_FIELD, text)) sel.push({ code: "select_field", label: "応募時に店舗を選ぶ旨の記載（店舗選択欄）" });
  if ((input.selectableStoreCount ?? 0) >= 2) sel.push({ code: "selectable_list", label: `選べる店舗の一覧が${input.selectableStoreCount}店舗分ある` });
  if (input.storeMode === "select_on_apply") sel.push({ code: "registered_select", label: "店舗選択式として登録されている" });
  if (hit(PER_STORE, text)) ind.push({ code: "per_store_text", label: "店舗ごとに受付・応募する旨の記載" });
  if (tags.includes("in_store_apply")) ind.push({ code: "in_store_apply", label: "店頭での応募・受付" });
  // 比べる相手の抽選が、それぞれ別の情報源（店舗ごとのページ）を持つ。共有の情報源URLが1つでもあれば、店舗ごとの別ページとは言えない
  const mine = new Set(input.sourceUrls ?? []);
  const sibs = input.siblings ?? [];
  if (mine.size > 0 && sibs.length > 0 && sibs.every((s) => s.sourceUrls.length > 0 && s.sourceUrls.every((u) => !mine.has(u)) && s.storeKey !== input.storeKey)) {
    // 別のURLは、店舗別の独立した受付の「裏づけ」にとどめる（同じ応募フォームを別の投稿が紹介していることもあるため、単独では構造の根拠にしない）
    if (ind.length > 0) ind.push({ code: "per_store_url", label: "店舗ごとに別の情報源（応募ページ）がある" });
  }
  const restriction = hit(RESTRICTION, text) || tags.includes("one_store_only");

  const base = { selectSignals: sel, independentSignals: ind, restrictionOnly: restriction, conflict: false, manualDisagrees: false };
  const structure = ((): { form: LotteryForm; conf: FormJudgement["confidence"]; conflict: boolean } => {
    const selStrong = sel.length > 0;
    const indStrong = ind.length > 0;
    if (selStrong && indStrong) {
      // 構造として明示された記載（選択欄の文面）と、店舗ごとの受付の記載が両方ある → 確定しない
      return { form: "unknown", conf: "low", conflict: true };
    }
    if (selStrong) return { form: "store_select", conf: sel.length >= 2 ? "high" : "medium", conflict: false };
    if (indStrong) return { form: "store_independent", conf: ind.length >= 2 ? "high" : "medium", conflict: false };
    return { form: "unknown", conf: "low", conflict: false };
  })();

  // 利用者の手動の分類が最優先
  if (input.decl && input.decl.source === "manual") {
    const disagrees = structure.form !== "unknown" && structure.form !== input.decl.form;
    return {
      ...base,
      form: input.decl.form,
      confidence: "high",
      basisKind: "manual",
      manualDisagrees: disagrees,
      basis: [`利用者が手動で${formLabel(input.decl.form)}に設定している${disagrees ? `（記載からは${formLabel(structure.form)}にも読めるが、手動の設定を優先する）` : ""}`],
    };
  }
  // 通販・店舗を持たない抽選（構造の根拠が無いときだけ）
  if (structure.form === "unknown" && !structure.conflict && (input.storeMode === "none" || input.online)) {
    return { ...base, form: "other", confidence: "medium", basisKind: "registered", basis: ["通販・オンライン専用など、店舗を持たない抽選として登録されている"] };
  }
  if (structure.form !== "unknown") {
    const sigs = structure.form === "store_select" ? sel : ind;
    return { ...base, form: structure.form, confidence: structure.conf, basisKind: sigs.every((s) => s.code === "registered_select") ? "registered" : "structure", basis: sigs.map((s) => s.label) };
  }
  if (structure.conflict) return { ...base, conflict: true, form: "unknown", confidence: "low", basisKind: "none", basis: ["店舗を選ぶ記載と、店舗ごとに受付する記載の両方がある（確認が必要）"] };
  // 構造を確認できない: 登録（店舗固定）を尊重し、断定しない
  return {
    ...base,
    form: "unknown",
    confidence: "low",
    basisKind: "none",
    basis: restriction ? ["「1店舗のみ応募」などの制限の記載はあるが、応募時の店舗選択欄・店舗ごとの受付は確認できない（制限だけでは店舗選択式と断定しない）"] : ["応募受付の構造（店舗選択欄・店舗ごとの受付）を確認できない"],
  };
}

export function formLabel(f: LotteryForm): string {
  return f === "store_select" ? "店舗選択式" : f === "store_independent" ? "店舗別独立抽選" : f === "other" ? "その他の抽選" : "未確認";
}

/** グループ化の対象になりうる形態か（店舗別独立抽選、または構造を確認できず既存の店舗固定の登録を尊重する場合）。店舗選択式・その他は対象外 */
export function groupableForm(f: LotteryForm): boolean {
  return f === "store_independent" || f === "unknown";
}

/** 保存する分類（手動の設定）。画面で店舗の指定方式を変えたとき、利用者の設定として記録する */
export function formFromStoreMode(mode: "fixed" | "select_on_apply" | "none", online = false): FormDecl["form"] {
  if (mode === "select_on_apply") return "store_select";
  if (mode === "none" || online) return "other";
  return "store_independent";
}

/**
 * 保存時に記録する分類の列。null=触れない（既存の記録を保つ）。
 *  - 利用者の保存: 店舗の指定方式を変えたとき、または店舗選択式で新規登録したときだけ「手動」として記録する（初期値のままの「店舗固定」は利用者の判断ではない）
 *  - 収集・AIの保存: 手動の分類がある抽選には一切書かない（根拠なく上書きしない）。方式が変わったときだけ「rule」として記録する
 */
export function nextFormColumns(o: {
  isNew: boolean;
  byUser: boolean;
  prevMode?: string | null;
  prevSource?: FormSource | null;
  nextMode: "fixed" | "select_on_apply" | "none";
}): { lottery_form: FormDecl["form"]; lottery_form_source: FormSource } | null {
  if (!o.byUser && o.prevSource === "manual") return null;
  const changed = o.isNew ? o.nextMode === "select_on_apply" : (o.prevMode ?? "fixed") !== o.nextMode;
  if (!changed) return null;
  return { lottery_form: formFromStoreMode(o.nextMode), lottery_form_source: o.byUser ? "manual" : "rule" };
}
