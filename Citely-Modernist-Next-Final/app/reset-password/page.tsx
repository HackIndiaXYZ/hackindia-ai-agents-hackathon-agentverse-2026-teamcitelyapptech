import { Suspense } from "react";
import { SignIn, AccountPage } from "@/components/Auth";
export default function Page() {
  return (
    <Suspense fallback={<div className="status-page">Loading…</div>}>
      <AccountPage kind="reset" />
    </Suspense>
  );
}
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata({route:'/reset-password/',title:'Reset password | Citely',privatePage:true});
