/*
 * 正誤チェックツールの共通ロジック（ブラウザ・Node 両用。DOM に触れない）。
 * 入力データ（評価対象の事例集）と人間の評価は別の構造で扱い、AIの元の判定は書き換えない。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ReviewCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SET_FORMAT = "toremane-review-set";
  var ANSWER_FORMAT = "toremane-review-answers";
  var VERSION = 1;

  /** 4段階の評価 */
  var VERDICTS = [
    { key: "correct", label: "① 正しい", hint: "処理判断も抽出項目も正しい" },
    { key: "partial", label: "② 一部修正が必要", hint: "処理判断は適切。一部の抽出情報に誤りがある" },
    { key: "wrong", label: "③ 間違っている", hint: "登録・除外・確認待ち・重複などの判断自体が違う" },
    { key: "unknown", label: "④ 判断できない", hint: "元の情報だけでは正誤を判断できない" },
  ];
  /** 修正対象の項目 */
  var FIELDS = [
    { key: "decision", label: "処理判断（登録・除外・重複など）" },
    { key: "chain", label: "系列" },
    { key: "store", label: "店舗" },
    { key: "product", label: "商品" },
    { key: "applyPeriod", label: "応募期間" },
    { key: "resultDate", label: "当選発表日" },
    { key: "conditions", label: "応募条件" },
    { key: "lotteryForm", label: "抽選形態" },
    { key: "receiveMethod", label: "受取方法" },
    { key: "other", label: "その他" },
  ];
  /** 項目ごとの状態。unknown_only は「情報が不明なだけで誤りではない」（情報不足でも登録可能という方針のため、誤りと区別する） */
  var FIELD_STATES = [
    { key: "unset", label: "未確認" },
    { key: "ok", label: "正しい" },
    { key: "wrong", label: "誤り" },
    { key: "unknown_only", label: "不明なだけ（誤りではない）" },
  ];
  var DECISIONS = [
    { key: "register", label: "登録すべき" },
    { key: "exclude", label: "除外すべき" },
    { key: "pending", label: "確認待ちが妥当" },
    { key: "duplicate", label: "重複（既存の抽選と同じ）" },
    { key: "other", label: "その他" },
  ];

  var isObj = function (v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
  };
  var str = function (v, max) {
    return typeof v === "string" ? v.slice(0, max || 20000) : "";
  };

  /** 内容の同一性を調べる簡易ハッシュ（FNV-1a 32bit×2。改ざん検出ではなく、取り違え・編集の検知用） */
  function digest(value) {
    var s = typeof value === "string" ? value : stableStringify(value);
    var h1 = 0x811c9dc5;
    var h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    }
    return ("00000000" + h1.toString(16)).slice(-8) + ("00000000" + h2.toString(16)).slice(-8);
  }
  function stableStringify(v) {
    if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
    if (isObj(v))
      return (
        "{" +
        Object.keys(v)
          .sort()
          .map(function (k) {
            return JSON.stringify(k) + ":" + stableStringify(v[k]);
          })
          .join(",") +
        "}"
      );
    return JSON.stringify(v === undefined ? null : v);
  }

  /** 事例集の検証。評価の答え（human / verdict）が混ざっていれば拒否する（正解の漏洩・入力と正解の混在の防止） */
  function validateSet(obj) {
    var errors = [];
    if (!isObj(obj) || obj.format !== SET_FORMAT) return { ok: false, errors: ["事例集のファイルではありません（format が " + SET_FORMAT + " ではありません）"], set: null };
    if (obj.version !== VERSION) errors.push("対応していない版です（version=" + obj.version + "）");
    if (typeof obj.setId !== "string" || !obj.setId) errors.push("setId がありません");
    if (!Array.isArray(obj.cases)) errors.push("cases がありません");
    var seen = {};
    (obj.cases || []).forEach(function (c, i) {
      if (!isObj(c) || typeof c.caseId !== "string" || !c.caseId) return errors.push("cases[" + i + "] に caseId がありません");
      if (seen[c.caseId]) errors.push("caseId が重複しています: " + c.caseId);
      seen[c.caseId] = true;
      if (c.human !== undefined || c.verdict !== undefined || c.answer !== undefined) errors.push("cases[" + i + "] に人間の評価が含まれています（入力データと正解は分離してください）");
      if (!isObj(c.ai)) errors.push("cases[" + i + "] に ai（AIの判定）がありません");
    });
    return { ok: errors.length === 0, errors: errors, set: errors.length === 0 ? obj : null };
  }

  function emptyFields() {
    var f = {};
    FIELDS.forEach(function (x) {
      f[x.key] = { state: "unset", value: "" };
    });
    return f;
  }
  function emptyEvaluation(caseId) {
    return { caseId: caseId, verdict: null, fields: emptyFields(), comment: "", evaluatedAt: null, updatedAt: null };
  }
  /** 保存データの形を整える（欠損・不正な値を安全な既定値に。入力内容は失わない） */
  function normalizeEvaluation(ev, caseId) {
    var out = emptyEvaluation(caseId);
    if (!isObj(ev)) return out;
    if (VERDICTS.some(function (v) { return v.key === ev.verdict; })) out.verdict = ev.verdict;
    FIELDS.forEach(function (f) {
      var x = isObj(ev.fields) ? ev.fields[f.key] : null;
      if (isObj(x)) {
        if (FIELD_STATES.some(function (s) { return s.key === x.state; })) out.fields[f.key].state = x.state;
        out.fields[f.key].value = str(x.value, 4000);
      }
    });
    out.comment = str(ev.comment, 8000);
    out.evaluatedAt = typeof ev.evaluatedAt === "string" ? ev.evaluatedAt : null;
    out.updatedAt = typeof ev.updatedAt === "string" ? ev.updatedAt : null;
    return out;
  }

  /** 評価の整合性。問題があれば人間に知らせる（正解データとして使える条件） */
  function validateEvaluation(ev) {
    var issues = [];
    if (!ev || !ev.verdict) return ["評価が未選択です"];
    var wrongs = FIELDS.filter(function (f) { return ev.fields[f.key].state === "wrong"; });
    if (ev.verdict === "partial" && wrongs.length === 0) issues.push("「一部修正が必要」は、誤りの項目を1つ以上指定してください");
    if (ev.verdict === "wrong" && ev.fields.decision.state !== "wrong" && !ev.comment.trim()) issues.push("「間違っている」は、処理判断を「誤り」にして正しい判断を選ぶか、コメントを入力してください");
    if (ev.verdict === "wrong" && ev.fields.decision.state === "wrong" && !ev.fields.decision.value) issues.push("処理判断の正しい値（登録・除外など）を選んでください");
    if (ev.verdict === "correct" && wrongs.length > 0) issues.push("「正しい」なのに誤りの項目があります");
    if (ev.verdict === "unknown" && wrongs.length > 0) issues.push("「判断できない」なのに誤りの項目があります");
    return issues;
  }
  var usableAsGold = function (ev) {
    return !!ev && ["correct", "partial", "wrong"].indexOf(ev.verdict) >= 0 && validateEvaluation(ev).length === 0;
  };

  function evaluationId(setId, caseId) {
    return "ev-" + String(setId).slice(0, 24) + "-" + caseId;
  }
  var caseDigest = function (c) {
    return digest({ source: c.source || null, ai: c.ai, duplicateOf: c.duplicateOf || null, category: c.category || null });
  };

  /** 評価結果の書き出し。AIの元の判定は事例集のものをそのまま写し、人間の評価は human に別に入れる */
  function buildExport(set, evals, now) {
    var iso = (now || new Date()).toISOString();
    var results = [];
    set.cases.forEach(function (c) {
      var ev = normalizeEvaluation(evals[c.caseId], c.caseId);
      if (!ev.verdict && !ev.comment && !FIELDS.some(function (f) { return ev.fields[f.key].state !== "unset"; })) return; // 何も入力していない事例は書き出さない
      var issues = validateEvaluation(ev);
      var wrong = [];
      var ok = [];
      var unk = [];
      FIELDS.forEach(function (f) {
        var x = ev.fields[f.key];
        if (x.state === "wrong") wrong.push({ field: f.key, correctValue: x.value });
        else if (x.state === "ok") ok.push(f.key);
        else if (x.state === "unknown_only") unk.push(f.key);
      });
      results.push({
        evaluationId: evaluationId(set.setId, c.caseId),
        caseId: c.caseId,
        caseDigest: caseDigest(c),
        category: c.category || null,
        source: { url: (c.source && c.source.url) || null, title: (c.source && c.source.title) || null, fetchedAt: (c.source && c.source.fetchedAt) || null },
        aiOriginal: JSON.parse(JSON.stringify(c.ai)),
        human: {
          verdict: ev.verdict,
          usableAsGold: usableAsGold(ev),
          validationIssues: issues,
          corrections: wrong,
          confirmedCorrectFields: ok,
          unknownOnlyFields: unk,
          comment: ev.comment,
          evaluatedAt: ev.evaluatedAt,
        },
      });
    });
    return { format: ANSWER_FORMAT, version: VERSION, setId: set.setId, setDigest: digest(set.cases.map(caseDigest)), exportedAt: iso, total: set.cases.length, results: results };
  }

  /** 書き出したJSONの再読み込み。別の事例集のもの・事例の内容が変わっているものは警告し、取り込まない */
  function parseExport(obj, set) {
    var warnings = [];
    var evals = {};
    if (!isObj(obj) || obj.format !== ANSWER_FORMAT) return { ok: false, warnings: ["評価結果のファイルではありません"], evals: evals };
    if (obj.setId !== set.setId) return { ok: false, warnings: ["別の事例集の評価結果です（setId が一致しません）"], evals: evals };
    var byId = {};
    set.cases.forEach(function (c) { byId[c.caseId] = c; });
    (obj.results || []).forEach(function (r) {
      var c = byId[r && r.caseId];
      if (!c) return warnings.push("事例集にない事例を無視しました: " + (r && r.caseId));
      if (r.caseDigest !== caseDigest(c)) return warnings.push("事例の内容が評価時と変わっているため取り込みませんでした: " + r.caseId);
      var h = isObj(r.human) ? r.human : {};
      var ev = emptyEvaluation(c.caseId);
      ev.verdict = VERDICTS.some(function (v) { return v.key === h.verdict; }) ? h.verdict : null;
      (h.corrections || []).forEach(function (x) {
        if (ev.fields[x.field]) ev.fields[x.field] = { state: "wrong", value: str(x.correctValue, 4000) };
      });
      (h.confirmedCorrectFields || []).forEach(function (k) { if (ev.fields[k]) ev.fields[k].state = "ok"; });
      (h.unknownOnlyFields || []).forEach(function (k) { if (ev.fields[k]) ev.fields[k].state = "unknown_only"; });
      ev.comment = str(h.comment, 8000);
      ev.evaluatedAt = typeof h.evaluatedAt === "string" ? h.evaluatedAt : null;
      evals[c.caseId] = ev;
    });
    return { ok: true, warnings: warnings, evals: evals };
  }

  var isEvaluated = function (ev) { return !!(ev && ev.verdict); };
  function summarize(set, evals) {
    var s = { total: set.cases.length, evaluated: 0, remaining: 0, byVerdict: { correct: 0, partial: 0, wrong: 0, unknown: 0 }, incomplete: 0 };
    set.cases.forEach(function (c) {
      var ev = evals[c.caseId];
      if (isEvaluated(ev)) {
        s.evaluated++;
        s.byVerdict[ev.verdict]++;
        if (validateEvaluation(ev).length > 0) s.incomplete++;
      }
    });
    s.remaining = s.total - s.evaluated;
    return s;
  }
  /** 表示する事例の絞り込み。filter: {onlyUnevaluated, verdict('all'|…|'none'), category} */
  function filterCases(set, evals, filter) {
    var f = filter || {};
    return set.cases.filter(function (c) {
      var ev = evals[c.caseId];
      if (f.onlyUnevaluated && isEvaluated(ev)) return false;
      if (f.verdict && f.verdict !== "all") {
        if (f.verdict === "none") { if (isEvaluated(ev)) return false; }
        else if (!ev || ev.verdict !== f.verdict) return false;
      }
      if (f.category && f.category !== "all" && c.category !== f.category) return false;
      return true;
    });
  }
  /** 外部データの文字列を、リンクに使ってよい http(s) のURLだけにする */
  function safeHttpUrl(u) {
    if (typeof u !== "string") return null;
    try {
      var p = new URL(u.trim());
      return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
    } catch (e) {
      return null;
    }
  }

  return { SET_FORMAT: SET_FORMAT, ANSWER_FORMAT: ANSWER_FORMAT, VERSION: VERSION, VERDICTS: VERDICTS, FIELDS: FIELDS, FIELD_STATES: FIELD_STATES, DECISIONS: DECISIONS, digest: digest, validateSet: validateSet, emptyEvaluation: emptyEvaluation, normalizeEvaluation: normalizeEvaluation, validateEvaluation: validateEvaluation, usableAsGold: usableAsGold, buildExport: buildExport, parseExport: parseExport, summarize: summarize, filterCases: filterCases, isEvaluated: isEvaluated, safeHttpUrl: safeHttpUrl, evaluationId: evaluationId };
});
