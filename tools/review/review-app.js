/* 正誤チェックツールの画面処理。外部データは textContent / setAttribute（検証済みURLのみ）だけで描画し、HTML文字列を組み立てない。 */
(function () {
  "use strict";
  var C = window.ReviewCore;
  var $ = function (id) { return document.getElementById(id); };
  var state = { set: null, evals: {}, filter: { onlyUnevaluated: false, verdict: "all", category: "all" }, index: 0, storageOk: true };

  function el(tag, props, children) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "text") e.textContent = props[k];
      else if (k === "class") e.className = props[k];
      else e.setAttribute(k, props[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  var storeKey = function (setId) { return "toremane-review:" + setId; };
  function save() {
    if (!state.set) return;
    try {
      localStorage.setItem(storeKey(state.set.setId), JSON.stringify({ evals: state.evals, savedAt: new Date().toISOString() }));
      $("saveState").textContent = "自動保存済み（この端末のブラウザ内）";
    } catch (e) {
      state.storageOk = false;
      $("saveState").textContent = "自動保存できません。こまめに「評価結果を書き出す」を使ってください";
    }
  }
  function loadSaved(setId) {
    try {
      var raw = localStorage.getItem(storeKey(setId));
      if (!raw) return {};
      var o = JSON.parse(raw);
      var out = {};
      Object.keys(o.evals || {}).forEach(function (k) { out[k] = C.normalizeEvaluation(o.evals[k], k); });
      return out;
    } catch (e) {
      return {};
    }
  }
  var toast = function (msg, bad) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (bad ? " bad" : "");
    setTimeout(function () { t.className = "toast"; }, bad ? 7000 : 3000);
  };

  /** 内容のある評価の件数（表示しただけの空の評価は数えない） */
  function countInput() {
    return Object.keys(state.evals).filter(function (k) {
      var e = state.evals[k];
      return e.verdict || e.comment || Object.keys(e.fields).some(function (f) { return e.fields[f].state !== "unset"; });
    }).length;
  }
  function currentCases() { return C.filterCases(state.set, state.evals, state.filter); }
  function currentCase() { var l = currentCases(); return l.length ? l[Math.min(state.index, l.length - 1)] : null; }
  function evalOf(c) { return (state.evals[c.caseId] = state.evals[c.caseId] || C.emptyEvaluation(c.caseId)); }

  function loadSet(obj) {
    var v = C.validateSet(obj);
    if (!v.ok) { toast("事例集を読み込めません: " + v.errors.slice(0, 3).join(" / "), true); return; }
    state.set = v.set;
    state.evals = loadSaved(v.set.setId);
    state.index = 0;
    state.filter = { onlyUnevaluated: false, verdict: "all", category: "all" };
    $("app").hidden = false;
    $("welcome").hidden = true;
    buildFilters();
    render();
    var n = countInput();
    if (n) toast("前回の入力を復元しました（" + n + "件）");
  }

  function buildFilters() {
    var cat = $("fCategory");
    cat.textContent = "";
    cat.appendChild(el("option", { value: "all", text: "すべての区分" }));
    var seen = {};
    state.set.cases.forEach(function (c) { if (c.category && !seen[c.category]) { seen[c.category] = 1; cat.appendChild(el("option", { value: c.category, text: c.categoryLabel || c.category })); } });
    var vs = $("fVerdict");
    vs.textContent = "";
    vs.appendChild(el("option", { value: "all", text: "すべての評価" }));
    vs.appendChild(el("option", { value: "none", text: "未評価" }));
    C.VERDICTS.forEach(function (v) { vs.appendChild(el("option", { value: v.key, text: v.label })); });
  }

  function kv(table, label, value) {
    var v = value === null || value === undefined || value === "" ? null : value;
    var td = el("td", v === null ? { class: "none", text: "（なし）" } : { text: Array.isArray(v) ? v.join(" / ") : String(v) });
    table.appendChild(el("tr", {}, [el("th", { text: label }), td]));
  }
  function link(url, text) {
    var u = C.safeHttpUrl(url);
    return u ? el("a", { href: u, target: "_blank", rel: "noopener noreferrer", text: text || u }) : el("span", { class: "none", text: url ? "（URLとして開けない値）" : "（なし）" });
  }

  function renderSource(c) {
    var box = $("source");
    box.textContent = "";
    var s = c.source || {};
    box.appendChild(el("h2", { text: "元の告知" }));
    var t = el("table", { class: "kv" });
    kv(t, "題", s.title);
    t.appendChild(el("tr", {}, [el("th", { text: "情報元URL" }), el("td", {}, [link(s.url)])]));
    kv(t, "種類", s.kind);
    kv(t, "取得日時", s.fetchedAt);
    kv(t, "収集日時", s.createdAt);
    box.appendChild(t);
    box.appendChild(el("h3", { text: "本文" }));
    if (s.bodyText) {
      box.appendChild(el("pre", { class: "body", text: s.bodyText }));
      if (s.bodyNote) box.appendChild(el("p", { class: "note", text: s.bodyNote }));
    } else box.appendChild(el("p", { class: "missing", text: "本文は取得できていません。" + (s.bodyNote || "情報元URLを開いて確認してください。") }));
    box.appendChild(el("h3", { text: "画像" }));
    var imgs = (s.images || []).map(function (i) { return C.safeHttpUrl(i && i.url); }).filter(Boolean);
    if (imgs.length) {
      imgs.slice(0, 6).forEach(function (u) {
        var wrap = el("div", { class: "imgwrap" });
        var im = el("img", { src: u, alt: "元の告知の画像", referrerpolicy: "no-referrer", loading: "lazy" });
        im.addEventListener("error", function () { wrap.textContent = ""; wrap.appendChild(el("span", { class: "missing", text: "画像を表示できませんでした（期限切れ・取得制限の可能性）。" })); wrap.appendChild(link(u, "画像URLを開く")); });
        wrap.appendChild(im);
        box.appendChild(wrap);
      });
    } else box.appendChild(el("p", { class: "missing", text: "画像は取得できていません。" + (s.imageNote || "") }));
  }

  function renderAi(c) {
    var box = $("ai");
    box.textContent = "";
    var a = c.ai || {};
    box.appendChild(el("h2", { text: "AIの判断" }));
    var d = a.decision || {};
    box.appendChild(el("div", { class: "badge b-" + String(d.status || "x").replace(/[^a-z_]/g, ""), text: d.label || d.status || "（判断なし）" }));
    if (d.triage) box.appendChild(el("p", { class: "note", text: "仕分け: " + d.triage + (d.triageReason ? "（" + d.triageReason + "）" : "") }));
    box.appendChild(el("h3", { text: "判断理由" }));
    if ((a.reasons || []).length) box.appendChild(el("ul", {}, a.reasons.map(function (r) { return el("li", { text: r }); })));
    else box.appendChild(el("p", { class: "none", text: "（理由の記録なし）" }));
    var x = a.extracted;
    box.appendChild(el("h3", { text: "AIが抽出した情報" }));
    if (x) {
      var t = el("table", { class: "kv" });
      kv(t, "系列", x.chain); kv(t, "店舗", x.store); kv(t, "商品", x.products);
      kv(t, "応募開始", x.applyStart); kv(t, "応募締切", x.applyDeadline); kv(t, "当選発表", x.resultDate);
      kv(t, "応募条件", x.conditions); kv(t, "抽選形態", x.lotteryForm); kv(t, "受取方法", x.receiveMethod); kv(t, "応募方法", x.applyMethod);
      box.appendChild(t);
    } else box.appendChild(el("p", { class: "missing", text: "抽出結果は保存されていません（解析前に除外された候補など）。" }));
    if ((a.evidence || []).length) {
      box.appendChild(el("h3", { text: "AIが根拠とした原文の抜粋" }));
      box.appendChild(el("ul", {}, a.evidence.map(function (e) { return el("li", { text: (e.field ? e.field + ": " : "") + e.quote }); })));
    }
    var notes = [].concat(a.notices || [], a.warnings || []);
    if (notes.length) {
      box.appendChild(el("h3", { text: "注意・警告" }));
      box.appendChild(el("ul", {}, notes.map(function (n) { return el("li", { text: n }); })));
    }
    if ((c.duplicateOf || []).length) {
      box.appendChild(el("h3", { text: "比較対象の登録済み抽選" }));
      c.duplicateOf.forEach(function (dup) {
        var l = dup.lottery || {};
        var t = el("table", { class: "kv dup" });
        kv(t, "判定", (dup.level ? dup.level + ": " : "") + (dup.reason || ""));
        kv(t, "系列", l.chain); kv(t, "店舗", l.store); kv(t, "商品", l.products);
        kv(t, "応募開始", l.applyStart); kv(t, "応募締切", l.applyDeadline); kv(t, "登録元", l.sourceKind);
        t.appendChild(el("tr", {}, [el("th", { text: "情報源" }), el("td", {}, (l.urls || []).map(function (u) { return el("div", {}, [link(u)]); }))]));
        box.appendChild(t);
      });
    }
  }

  function renderEval(c) {
    var box = $("eval");
    box.textContent = "";
    var ev = evalOf(c);
    box.appendChild(el("h2", { text: "あなたの評価" }));
    var vrow = el("div", { class: "verdicts", role: "radiogroup", "aria-label": "評価" });
    C.VERDICTS.forEach(function (v) {
      var b = el("button", { type: "button", class: "vbtn v-" + v.key + (ev.verdict === v.key ? " on" : ""), title: v.hint, "aria-pressed": ev.verdict === v.key ? "true" : "false" }, [el("span", { text: v.label }), el("small", { text: v.hint })]);
      b.addEventListener("click", function () {
        ev.verdict = ev.verdict === v.key ? null : v.key;
        ev.evaluatedAt = ev.verdict ? new Date().toISOString() : null;
        touch(ev); save(); render(true);
      });
      vrow.appendChild(b);
    });
    box.appendChild(vrow);
    if (ev.verdict === "partial" || ev.verdict === "wrong") {
      box.appendChild(el("p", { class: "note", text: "誤りの項目は「誤り」にして正しい値を入力。情報が書かれていないだけの項目は「不明なだけ」を選びます。" }));
    }
    var grid = el("div", { class: "fields" });
    C.FIELDS.forEach(function (f) {
      var fs = ev.fields[f.key];
      var row = el("div", { class: "frow" });
      row.appendChild(el("label", { text: f.label, for: "fs-" + f.key }));
      var sel = el("select", { id: "fs-" + f.key });
      C.FIELD_STATES.forEach(function (s) { var o = el("option", { value: s.key, text: s.label }); if (fs.state === s.key) o.selected = true; sel.appendChild(o); });
      row.appendChild(sel);
      var valWrap = el("div", { class: "fval" });
      var val;
      if (f.key === "decision") {
        val = el("select", { id: "fv-" + f.key, "aria-label": "正しい処理判断" });
        val.appendChild(el("option", { value: "", text: "正しい判断を選択" }));
        C.DECISIONS.forEach(function (d) { var o = el("option", { value: d.key, text: d.label }); if (fs.value === d.key) o.selected = true; val.appendChild(o); });
      } else {
        val = el("input", { id: "fv-" + f.key, type: "text", placeholder: "正しい値", "aria-label": f.label + "の正しい値", maxlength: "4000" });
        val.value = fs.value;
      }
      val.addEventListener("input", function () { fs.value = val.value; touch(ev); save(); });
      val.addEventListener("change", function () { fs.value = val.value; touch(ev); save(); });
      valWrap.appendChild(val);
      valWrap.hidden = fs.state !== "wrong";
      sel.addEventListener("change", function () {
        fs.state = sel.value;
        if (fs.state !== "wrong") fs.value = "";
        valWrap.hidden = fs.state !== "wrong";
        touch(ev); save(); renderIssues(c);
      });
      row.appendChild(valWrap);
      grid.appendChild(row);
    });
    box.appendChild(grid);
    box.appendChild(el("label", { text: "コメント（自由記述）", for: "comment" }));
    var ta = el("textarea", { id: "comment", rows: "3", maxlength: "8000" });
    ta.value = ev.comment;
    ta.addEventListener("input", function () { ev.comment = ta.value; touch(ev); save(); renderIssues(c); });
    box.appendChild(ta);
    box.appendChild(el("div", { id: "issues", class: "issues" }));
    renderIssues(c);
  }
  function touch(ev) { ev.updatedAt = new Date().toISOString(); renderStats(); }
  function renderIssues(c) {
    var box = $("issues");
    if (!box) return;
    var issues = C.validateEvaluation(evalOf(c));
    box.textContent = "";
    if (evalOf(c).verdict && issues.length) issues.forEach(function (i) { box.appendChild(el("p", { class: "issue", text: "⚠ " + i })); });
    else if (evalOf(c).verdict) box.appendChild(el("p", { class: "okmsg", text: evalOf(c).verdict === "unknown" ? "「判断できない」は正解データには使いません。" : "入力は正解データとして使えます。" }));
  }
  function renderStats() {
    var s = C.summarize(state.set, state.evals);
    $("stats").textContent = "評価済み " + s.evaluated + " / " + s.total + "　残り " + s.remaining + "　（正しい " + s.byVerdict.correct + "・一部修正 " + s.byVerdict.partial + "・間違い " + s.byVerdict.wrong + "・判断不可 " + s.byVerdict.unknown + (s.incomplete ? "・要入力 " + s.incomplete : "") + "）";
  }

  function render(keepScroll) {
    if (!state.set) return;
    renderStats();
    var list = currentCases();
    var c = currentCase();
    if (state.index >= list.length) state.index = Math.max(0, list.length - 1);
    $("pos").textContent = list.length ? state.index + 1 + " / " + list.length + "件（絞り込み後）" : "該当なし";
    $("prev").disabled = state.index <= 0;
    $("next").disabled = state.index >= list.length - 1;
    var main = $("main");
    if (!c) { main.hidden = true; $("empty").hidden = false; return; }
    main.hidden = false; $("empty").hidden = true;
    $("caseTitle").textContent = (c.categoryLabel || c.category || "") + "　" + c.caseId + ((c.tags || []).length ? "　[" + c.tags.join("・") + "]" : "");
    renderSource(c); renderAi(c); renderEval(c);
    if (!keepScroll) window.scrollTo(0, 0);
  }

  function download(name, obj) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    var a = el("a", { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function readFile(file, cb) {
    var r = new FileReader();
    r.onload = function () { try { cb(JSON.parse(String(r.result))); } catch (e) { toast("JSONとして読み込めません", true); } };
    r.readAsText(file);
  }

  $("fileSet").addEventListener("change", function (e) { if (e.target.files[0]) readFile(e.target.files[0], loadSet); e.target.value = ""; });
  $("fileSet2").addEventListener("change", function (e) { if (e.target.files[0]) readFile(e.target.files[0], loadSet); e.target.value = ""; });
  $("fileAns").addEventListener("change", function (e) {
    var f = e.target.files[0];
    e.target.value = "";
    if (!f || !state.set) return;
    readFile(f, function (obj) {
      var p = C.parseExport(obj, state.set);
      if (!p.ok) return toast(p.warnings.join(" / "), true);
      var n = Object.keys(p.evals).length;
      if (countInput() > 0 && !window.confirm("現在の入力のうち、読み込むファイルに含まれる事例は上書きされます。続けますか？（" + n + "件）")) return;
      Object.keys(p.evals).forEach(function (k) { state.evals[k] = p.evals[k]; });
      save(); render(true);
      toast(n + "件を読み込みました" + (p.warnings.length ? "（警告 " + p.warnings.length + "件: " + p.warnings[0] + "）" : ""), p.warnings.length > 0);
    });
  });
  $("export").addEventListener("click", function () {
    if (!state.set) return;
    var out = C.buildExport(state.set, state.evals, new Date());
    var s = C.summarize(state.set, state.evals);
    download("review-answers-" + state.set.setId + "-" + out.exportedAt.replace(/[:.]/g, "-") + ".json", out);
    var gold = out.results.filter(function (r) { return r.human.usableAsGold; }).length;
    toast("書き出しました（評価 " + out.results.length + "件・正解データに使える " + gold + "件・未評価 " + s.remaining + "件）");
  });
  $("prev").addEventListener("click", function () { state.index = Math.max(0, state.index - 1); render(); });
  $("next").addEventListener("click", function () { state.index += 1; render(); });
  $("fUnev").addEventListener("change", function () { state.filter.onlyUnevaluated = $("fUnev").checked; state.index = 0; render(); });
  $("fVerdict").addEventListener("change", function () { state.filter.verdict = $("fVerdict").value; state.index = 0; render(); });
  $("fCategory").addEventListener("change", function () { state.filter.category = $("fCategory").value; state.index = 0; render(); });
  window.addEventListener("keydown", function (e) {
    if (!state.set || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || "")) return;
    if (e.key === "ArrowRight") $("next").click();
    if (e.key === "ArrowLeft") $("prev").click();
  });
  window.__reviewState = state; // 動作確認用（読み取り専用の参照）
})();
