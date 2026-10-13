import { DemoRequest } from '@/components/DemoRequest';
import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata({route:'/try-demo/',title:'Try demo | Citely',privatePage:true});
export default function Page() { return <DemoRequest />; }
