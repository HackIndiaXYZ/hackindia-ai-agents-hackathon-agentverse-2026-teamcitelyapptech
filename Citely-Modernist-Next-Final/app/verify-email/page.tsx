import { Suspense } from "react";
import { SignIn, AccountPage } from "@/components/Auth";
export default function Page() {
  return (
    <Suspense fallback={<div className="status-page">Loading…</div>}>
      <AccountPage kind="verify" />
    </Suspense>
  );
}
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata({route:'/verify-email/',title:'Verify email | Citely',privatePage:true});
