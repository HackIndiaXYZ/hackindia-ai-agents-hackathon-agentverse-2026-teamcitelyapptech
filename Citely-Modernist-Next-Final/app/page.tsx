import Landing from "@/components/Landing";
import AdminApp from "@/components/Admin";
import { StructuredData } from '@/components/StructuredData';
import { FAQ_CONTENT } from '@/lib/faq';
import { pageMetadata, absolute, PRODUCT_DEFINITION, faqSchema } from '@/lib/seo';
// admin.citely.example is a separate build of this site whose home page is the admin console.
const ADMIN_SITE = process.env.NEXT_PUBLIC_ADMIN_SITE === 'true';
export const metadata = ADMIN_SITE ? pageMetadata({route:'/',title:'Admin | Citely',privatePage:true}) : pageMetadata({route:'/'});
export default function Page() {
  if (ADMIN_SITE) return <AdminApp />;
  const org = {'@type':'Organization','@id':absolute('/')+'#organization',name:'Citely',url:absolute('/'),logo:absolute('/branding/app-icon-512.png'),description:PRODUCT_DEFINITION};
  return <><StructuredData data={{'@context':'https://schema.org','@graph':[org,
    {'@type':'WebSite',name:'Citely',url:absolute('/'),publisher:{'@id':org['@id']}},
    {'@type':'WebApplication',name:'Citely',url:absolute('/'),applicationCategory:'BusinessApplication',operatingSystem:'Web',description:PRODUCT_DEFINITION}]}} />
    <StructuredData data={faqSchema(FAQ_CONTENT)} /><Landing /></>;
}
