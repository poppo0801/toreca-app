"use client";

import { useEffect } from "react";
import { installInputReveal } from "@/lib/input-reveal";

/** アプリ全体の入力欄の自動スクロール（Stage 8U-1。処理の本体は lib/input-reveal.ts）。何も描画しない */
export function InputReveal() {
  useEffect(() => installInputReveal(), []);
  return null;
}
