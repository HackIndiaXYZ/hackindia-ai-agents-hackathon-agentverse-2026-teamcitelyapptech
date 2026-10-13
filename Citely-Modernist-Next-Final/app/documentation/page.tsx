import { DocumentationOverview } from '@/components/Documentation';
import { DOC_OVERVIEW } from '@/lib/documentation';
import { pageMetadata } from '@/lib/seo';
export const metadata=pageMetadata({route:'/documentation/',title:'Citely Documentation',description:DOC_OVERVIEW.description});
export default function Page(){return <DocumentationOverview/>;}
