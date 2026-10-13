import AdminApp from "@/components/Admin";
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata({route:'/admin/',title:'Admin | Citely',privatePage:true});
export default function Page() {
  return <AdminApp />;
}
