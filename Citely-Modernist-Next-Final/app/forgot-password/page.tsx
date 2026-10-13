import { Suspense } from "react";
import { SignIn, AccountPage } from "@/components/Auth";
export default function Page() {
  return (
    <Suspense fallback={<div className="status-page">Loading…</div>}>
      <AccountPage kind="forgot" />
    </Suspense>
  );
}
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata({route:'/forgot-password/',title:'Forgot password | Citely',privatePage:true});
