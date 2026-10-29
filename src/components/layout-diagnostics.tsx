"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { DIAG_KEY, emptyCounts, formatReport, parseDiagParam, type EventCounts, type Snap } from "@/lib/layout-diagnostics";

/** 診断モードか（URLの ?diag=1 で有効化・端末に保存、?diag=off で解除。通常の利用では常に false） */
export function useDiagEnabled(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      const p = parseDiagParam(window.location.search);
      if (p === "on") window.localStorage.setItem(DIAG_KEY, "1");
      if (p === "off") window.localStorage.removeItem(DIAG_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 端末内の保存値の読み取り
      setOn(window.localStorage.getItem(DIAG_KEY) === "1");
    } catch {
      /* 保存できない環境では診断を使わない */
    }
  }, []);
  return on;
}

export function setDiagEnabled(v: boolean) {
  try {
    if (v) window.localStorage.setItem(DIAG_KEY, "1");
    else window.localStorage.removeItem(DIAG_KEY);
  } catch {
    /* noop */
  }
}

const px = (v: string) => parseFloat(v) || 0;

/** 長さ(CSS)を実測する。使い終わったら取り除く */
function probe(style: Partial<CSSStyleDeclaration>): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, { position: "fixed", visibility: "hidden", pointerEvents: "none", left: "0", top: "0", width: "0", ...style });
  document.body.appendChild(el);
  return el;
}

function take(label: string): Snap {
  const vv = window.visualViewport;
  const unit = (u: string) => {
    const el = probe({ height: `100${u}` });
    const h = el.getBoundingClientRect().height;
    el.remove();
    return Math.round(h);
  };
  const sp = probe({ paddingTop: "env(safe-area-inset-top)", paddingRight: "env(safe-area-inset-right)", paddingBottom: "env(safe-area-inset-bottom)", paddingLeft: "env(safe-area-inset-left)" });
  const cs = getComputedStyle(sp);
  const safe = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  sp.remove();

  const nav = document.querySelector<HTMLElement>('[data-testid="bottom-nav"]');
  const grid = nav?.firstElementChild as HTMLElement | null;
  let navInfo: Snap["nav"] = null;
  const breakers: string[] = [];
  if (nav && getComputedStyle(nav).display !== "none") {
    const r = nav.getBoundingClientRect();
    const c = getComputedStyle(nav);
    navInfo = { top: r.top, bottom: r.bottom, height: r.height, padBottom: px(c.paddingBottom), cssBottom: c.bottom, cssHeight: c.height, cssPaddingBottom: c.paddingBottom, position: c.position };
    for (let el = nav.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const s = getComputedStyle(el);
      const hit = [s.transform !== "none" && "transform", s.filter !== "none" && "filter", s.perspective !== "none" && "perspective", s.willChange !== "auto" && /transform|filter|perspective/.test(s.willChange) && "will-change", /paint|layout|strict|content/.test(s.contain) && "contain", s.backdropFilter && s.backdropFilter !== "none" && "backdrop-filter"].filter(Boolean);
      if (hit.length) breakers.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}:${hit.join(",")}`);
    }
  }
  return {
    label,
    t: performance.now(),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    outerH: window.outerHeight,
    screenH: window.screen.height,
    vvH: vv ? vv.height : null,
    vvTop: vv ? vv.offsetTop : null,
    vvScale: vv ? vv.scale : null,
    docClientH: document.documentElement.clientHeight,
    bodyClientH: document.body.clientHeight,
    scrollY: window.scrollY,
    unitH: { vh: unit("vh"), dvh: unit("dvh"), svh: unit("svh"), lvh: unit("lvh") },
    safe,
    standalone: window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    nav: navInfo,
    gridBottom: grid ? grid.getBoundingClientRect().bottom : null,
    fixedBreakers: breakers,
  };
}

/**
 * 診断パネル（診断モードでだけ描画）。起動直後・最初のタッチの前後・復帰・向き変更などの時点で寸法を記録し、画面からコピーできる。
 * 無条件の繰り返し再描画はしない（記録はイベントと、起動後の数回の固定タイミングだけ）。
 */
export function LayoutDiagnostics() {
  const pathname = usePathname();
  const [snaps, setSnaps] = useState<Snap[]>([]);
  const [open, setOpen] = useState(true);
  const [copied, setCopied] = useState<null | boolean>(null);
  const counts = useRef<EventCounts>(emptyCounts());
  const [shown, setShown] = useState<EventCounts>(emptyCounts());
  const firstTouch = useRef(false);

  useEffect(() => {
    const add = (label: string) => {
      setSnaps((s) => [...s.slice(-39), take(label)]);
      setShown({ ...counts.current });
    };
    const timers: number[] = [];
    const later = (label: string, ms: number) => timers.push(window.setTimeout(() => add(label), ms));
    add("mount");
    later("+300ms", 300);
    later("+1s", 1000);
    later("+3s", 3000);
    const vv = window.visualViewport;
    const on = (k: keyof EventCounts, label: string) => () => {
      counts.current[k]++;
      add(label);
    };
    const handlers: [EventTarget, string, EventListener, AddEventListenerOptions?][] = [
      [window, "pageshow", on("pageshow", "pageshow")],
      [document, "visibilitychange", on("visibilitychange", `visibilitychange(${document.visibilityState})`)],
      [window, "resize", on("resize", "resize")],
      [window, "orientationchange", on("orientationchange", "orientationchange")],
      // 最初のタッチの前後を残す（タッチ直前→直後→数百ms後）
      [
        window,
        "touchstart",
        () => {
          counts.current.touchstart++;
          if (firstTouch.current) return;
          firstTouch.current = true;
          add("touchstart(1回目・直前)");
          requestAnimationFrame(() => add("touchstart+1frame"));
          later("touchstart+300ms", 300);
          later("touchstart+1s", 1000);
        },
        { capture: true, passive: true },
      ],
      [window, "scroll", () => {
        counts.current.scroll++;
        if (counts.current.scroll === 1) add("最初のscroll");
      }, { passive: true }],
    ];
    handlers.forEach(([t, n, h, o]) => t.addEventListener(n, h, o));
    const vr = () => (counts.current.vvResize++, counts.current.vvResize <= 3 && add("visualViewport.resize"));
    const vs = () => (counts.current.vvScroll++, counts.current.vvScroll === 1 && add("visualViewport.scroll(最初)"));
    vv?.addEventListener("resize", vr);
    vv?.addEventListener("scroll", vs);
    return () => {
      timers.forEach(window.clearTimeout);
      handlers.forEach(([t, n, h, o]) => t.removeEventListener(n, h, o));
      vv?.removeEventListener("resize", vr);
      vv?.removeEventListener("scroll", vs);
    };
  }, []);

  const ios = /OS (\d+[_\d]*) like Mac OS X/.exec(navigator.userAgent)?.[1]?.replace(/_/g, ".") ?? null;
  const report = formatReport(snaps, shown, { path: pathname, ios });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
    } catch {
      // クリップボードが使えない場合は、テキストを選択してコピーできるようにする
      const ta = document.getElementById("diag-text") as HTMLTextAreaElement | null;
      ta?.select();
      setCopied(false);
    }
  };

  return (
    <div data-testid="layout-diag" className="fixed right-1 top-[calc(var(--header-h)+0.25rem)] z-[60] max-w-[calc(100vw-0.5rem)] text-[11px]">
      <div className="flex justify-end gap-1">
        <button type="button" onClick={() => setOpen((v) => !v)} className="min-h-9 rounded-md border bg-card px-2 shadow-card">
          診断 {snaps.length}
        </button>
      </div>
      {open && (
        <div className="mt-1 w-[22rem] max-w-full space-y-1 rounded-md border bg-card p-2 shadow-card">
          <textarea id="diag-text" readOnly value={report} aria-label="診断結果" className="h-48 w-full resize-none rounded border bg-input p-1 font-mono text-[10px] leading-tight" />
          <div className="flex flex-wrap gap-1">
            <button type="button" onClick={copy} data-testid="diag-copy" className="min-h-9 rounded-md bg-primary px-3 text-primary-foreground">
              コピー
            </button>
            <button type="button" onClick={() => setSnaps([take("手動")])} className="min-h-9 rounded-md border px-3">
              今の値を記録
            </button>
            <button
              type="button"
              onClick={() => {
                counts.current = emptyCounts();
                firstTouch.current = false;
                setSnaps([take("クリア後")]);
              }}
              className="min-h-9 rounded-md border px-3"
            >
              消去
            </button>
            <button
              type="button"
              onClick={() => {
                setDiagEnabled(false);
                window.location.reload();
              }}
              className="min-h-9 rounded-md border px-3"
            >
              診断を終了
            </button>
          </div>
          {copied !== null && <p>{copied ? "コピーしました" : "コピーできませんでした。枠内を長押ししてコピーしてください"}</p>}
        </div>
      )}
    </div>
  );
}
