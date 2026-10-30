import { ShareIntakeView } from "@/components/share-intake-view";
import { parseSharedPost } from "@/lib/share-intake";

export const metadata = { title: "共有から登録 | トレマネ" };

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** iPhoneの共有（ショートカット）の入口。URLの検証だけをここで行い、解析は利用者が確認してから開始する */
export default async function SharePage({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const result = parseSharedPost({ url: one(sp.url), text: one(sp.text) });
  return <ShareIntakeView result={result} />;
}
