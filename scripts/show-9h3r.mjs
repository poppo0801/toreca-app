// 9H-3R の結果の要約表示（読み取りのみ）。node scripts/show-9h3r.mjs [missions|runs|<mission番号>]
import { existsSync, readdirSync, readFileSync } from "node:fs";
const OUT = "backups/eval-9h3r";
const a = process.argv[2] ?? "runs";
const ms = JSON.parse(readFileSync(`${OUT}/missions.json`, "utf8"));
if (a === "missions") {
  ms.missions.forEach((m, i) => console.log(i, m.id, m.trigger.kind, m.trigger.store ?? "", m.trigger.sourceUrl ?? ""));
} else if (a === "runs") {
  const led = JSON.parse(readFileSync(`${OUT}/ledger.json`, "utf8"));
  console.log("累計", led.spentJpy.toFixed(2), "円");
  for (const r of readdirSync(`${OUT}/runs`)) {
    const f = `${OUT}/runs/${r}/summary.json`;
    if (existsSync(f)) {
      const s = JSON.parse(readFileSync(f, "utf8"));
      console.log(r, s.spentJpy, s.stopped ?? "", JSON.stringify(s.missions.map((m) => [m.mission, m.costJpy, m.stop?.reason, m.usage && `${m.usage.searches}s/${m.usage.fetches}f/${m.usage.steps}st`, m.counts && `new${m.counts.aiNew}/known${m.counts.alreadyKnown}/ex${m.counts.exclude}`, Math.round((m.ms ?? 0) / 1000) + "s"])));
    }
  }
} else {
  for (const r of readdirSync(`${OUT}/runs`)) {
    const f = `${OUT}/runs/${r}/mission-${a}.json`;
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8"));
    const rec = j.record;
    console.log("MISSION", j.m.id, "cost", j.costJpy, "ms", j.ms, "error", j.error);
    console.log("ALLOC", JSON.stringify(rec.allocation.limits));
    console.log("FOCUS"); for (const x of rec.focus) console.log(" ", x.atStep, x.target, "|", x.reason);
    console.log("FOLLOWUPS"); for (const x of rec.followUps) console.log(" ", x.atStep, x.action, x.input.slice(0, 80), "|", x.because.slice(0, 80), "=>", x.outcome.slice(0, 80));
    console.log("SOURCES"); for (const x of rec.sources) console.log(" ", x.atStep, x.ok ? "OK" : "NG", x.provenance, x.url.slice(0, 90), x.failReason ?? "");
    console.log("LEADS"); for (const l of rec.leads) console.log(" ", l.atStep, l.lead.chain, l.lead.store ?? "-", l.lead.scope, l.lead.products.join("/").slice(0, 30), l.lead.applyDeadline ?? "", "=>", l.decision.status, l.decision.credit, l.decision.exclusion ?? "", "|", l.decision.reason.slice(0, 60), "|", l.decision.region.verdict, l.decision.attention.join(";").slice(0, 80));
    console.log("STOP", JSON.stringify(rec.stop), "UNCONFIRMED", JSON.stringify(rec.unconfirmed), "DECLINED", JSON.stringify(rec.declined));
    console.log("USAGE", JSON.stringify(rec.usage), "COUNTS", JSON.stringify(rec.counts));
  }
}
