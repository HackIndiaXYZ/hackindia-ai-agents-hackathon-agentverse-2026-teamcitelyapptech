import { Suspense } from "react";
import { SignIn, AccountPage } from "@/components/Auth";
export default function Page() {
  return (
    <Suspense fallback={<div className="status-page">Loading…</div>}>
      <SignIn />
    </Suspense>
  );
}
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata({route:'/signin/',title:'Sign in | Citely',privatePage:true});
