import { Suspense } from "react";
import { ReviewStatus } from "@/components/Auth";
import { pageMetadata } from '@/lib/seo';
export default function Page() {
  return (
    <Suspense fallback={<div className="status-page">Loading…</div>}>
      <ReviewStatus />
    </Suspense>
  );
}
export const metadata = pageMetadata({route:'/review/',title:'Account review | Citely',privatePage:true});
