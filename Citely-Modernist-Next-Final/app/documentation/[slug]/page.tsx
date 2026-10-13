import { notFound } from 'next/navigation';
import { DocumentationPage } from '@/components/Documentation';
import { DOC_PAGES, docBySlug } from '@/lib/documentation';
import { pageMetadata } from '@/lib/seo';
export const dynamicParams=false;
export function generateStaticParams(){return DOC_PAGES.map(page=>({slug:page.slug}));}
export async function generateMetadata({params}:{params:Promise<{slug:string}>}){const {slug}=await params;const page=docBySlug(slug);return page?pageMetadata({route:`/documentation/${slug}/`,title:`${page.title} | Citely Documentation`,description:page.description}):{};}
export default async function Page({params}:{params:Promise<{slug:string}>}){const {slug}=await params;const page=docBySlug(slug);if(!page)notFound();return <DocumentationPage page={page}/>;}
