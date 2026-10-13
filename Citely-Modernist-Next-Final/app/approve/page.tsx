import { Suspense } from "react";
import { ApprovePage } from "@/components/Approve";
import { pageMetadata } from "@/lib/seo";
export const metadata = pageMetadata({ route: "/approve/", title: "Approve access | Citely", privatePage: true });
export default function Page() {
  return (
    <Suspense fallback={<div className="status-page">Loading…</div>}>
      <ApprovePage />
    </Suspense>
  );
}
