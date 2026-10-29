import { Suspense } from "react";
import { BulkAiView } from "@/components/bulk-ai-view";

export const metadata = { title: "まとめてAI読み取り | トレマネ" };

export default function BulkPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">読み込み中…</p>}>
      <BulkAiView />
    </Suspense>
  );
}
