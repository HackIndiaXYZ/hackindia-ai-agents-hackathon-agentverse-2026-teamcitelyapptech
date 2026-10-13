import { pageMetadata } from '@/lib/seo';
export const metadata = pageMetadata({route:'/home/',title:'Your documents | Citely',privatePage:true});
export default function Layout({children}:{children:React.ReactNode}) {return children;}
