import { Suspense } from "react";
import { LotteryBoard } from "@/components/lottery-board";

export default function LotteriesPage() {
  return (
    <Suspense fallback={null}>
      <LotteryBoard />
    </Suspense>
  );
}
