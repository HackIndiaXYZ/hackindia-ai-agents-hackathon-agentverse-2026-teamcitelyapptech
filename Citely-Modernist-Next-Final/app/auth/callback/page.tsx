import { Suspense } from "react";
import { AccountPage } from "@/components/Auth";
import AdminApp from "@/components/Admin";
// On admin.citely.example the Google redirect lands here; the console finishes it.
const ADMIN_SITE = process.env.NEXT_PUBLIC_ADMIN_SITE === 'true';
export default function Page() {
  if (ADMIN_SITE) return <AdminApp />;
  return (
    <Suspense fallback={<div className="status-page">Loading…</div>}>
      <AccountPage kind="callback" />
    </Suspense>
  );
}
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata({route:'/auth/callback/',title:'Sign-in callback | Citely',privatePage:true});
