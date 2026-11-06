"use client";

import { useEffect, useState } from "react";

/**
 * 実機（iPhone ホーム画面アプリ）の表示領域の実験ページ（Stage 6L・診断専用）。
 * 画面の下端に、基準の違う色付きの帯を置き、どれが見えるかで「描画できる範囲」を特定する。AppShell は使わない。
 * 帯: 赤=bottom:0 / 青=100vh基準 / 緑=100lvh基準 / 黄=100dvh基準 / 紫=bottom:-59px（Safe Area上の分だけ下へ）
 */
const BARS: { k: string; color: string; style: React.CSSProperties }[] = [
  { k: "赤 bottom:0", color: "#e11d48", style: { bottom: 0, height: 28 } },
  { k: "青 100vh基準", color: "#2563eb", style: { top: "calc(100vh - 56px)", height: 28 } },
  { k: "緑 100lvh基準", color: "#16a34a", style: { top: "calc(100lvh - 84px)", height: 28 } },
  { k: "黄 100dvh基準", color: "#ca8a04", style: { top: "calc(100dvh - 112px)", height: 28 } },
  { k: "紫 bottom:-59px", color: "#9333ea", style: { bottom: -59, height: 28 } },
];

function measure() {
  const probe = (h: string) => {
    const el = document.createElement("div");
    Object.assign(el.style, { position: "fixed", visibility: "hidden", top: "0", left: "0", width: "0", height: h });
    document.body.appendChild(el);
    const v = Math.round(el.getBoundingClientRect().height);
    el.remove();
    return v;
  };
  const vv = window.visualViewport;
  const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "-";
  return [
    `inner=${window.innerWidth}x${window.innerHeight} screen=${window.screen.height} outerH=${window.outerHeight} vv=${vv ? Math.round(vv.height) : "-"}`,
    `vh/dvh/svh/lvh=${probe("100vh")}/${probe("100dvh")}/${probe("100svh")}/${probe("100lvh")} standalone=${window.matchMedia("(display-mode: standalone)").matches}`,
    `docClientH=${document.documentElement.clientHeight} scrollingH=${document.documentElement.scrollHeight}`,
    `meta viewport: ${meta}`,
  ].join("\n");
}

export default function ViewportLab() {
  const [info, setInfo] = useState("");
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 実機の寸法の読み取り
    setInfo(measure());
  }, []);
  const note = (s: string) => setLog((l) => [...l, s]);

  const resetMeta = () => {
    // viewport メタを書き換えて再計算させる（iOS が古い表示領域を保持していないかの切り分け）
    const m = document.querySelector('meta[name="viewport"]');
    const c = m?.getAttribute("content") ?? "";
    m?.setAttribute("content", c.replace(/,?\s*viewport-fit=cover/, "") || c);
    requestAnimationFrame(() => {
      m?.setAttribute("content", c);
      setTimeout(() => {
        setInfo(measure());
        note("viewportメタを再設定");
      }, 300);
    });
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "#f3f4f6", color: "#111", fontSize: 12 }}>
      <div style={{ padding: "calc(env(safe-area-inset-top) + 8px) 12px 0" }}>
        <b>表示領域の実験</b>
        <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{info}</pre>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" style={{ border: "1px solid #888", padding: "8px 10px", borderRadius: 6 }} onClick={() => setInfo(measure())}>
            再測定
          </button>
          <button type="button" style={{ border: "1px solid #888", padding: "8px 10px", borderRadius: 6 }} onClick={resetMeta}>
            viewport再設定
          </button>
          <button type="button" style={{ border: "1px solid #888", padding: "8px 10px", borderRadius: 6 }} onClick={() => { window.scrollTo(0, 1); window.dispatchEvent(new Event("resize")); setTimeout(() => setInfo(measure()), 300); note("scroll+resize"); }}>
            resize発火
          </button>
        </div>
        <pre style={{ fontSize: 11 }}>{log.join("\n")}</pre>
        <p style={{ marginTop: 8 }}>画面の下端付近に見える色の帯を数えて、色の名前をお知らせください（見えない帯もあります）。</p>
      </div>
      {BARS.map((b) => (
        <div key={b.k} style={{ position: "fixed", left: 0, right: 0, background: b.color, color: "#fff", fontSize: 11, paddingLeft: 8, lineHeight: "28px", ...b.style }}>
          {b.k}
        </div>
      ))}
    </div>
  );
}
