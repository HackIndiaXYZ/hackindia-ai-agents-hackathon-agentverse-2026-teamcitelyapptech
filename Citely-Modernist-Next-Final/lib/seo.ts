import type { Metadata } from 'next';
import { SITE_URL, NOINDEX } from '../deploy.config.mjs';
import { absoluteFor, PRODUCT_NAME, HOME_TITLE, HOME_DESCRIPTION } from './seo-data.mjs';
export * from './seo-data.mjs';
export const absolute = (route: string) => absoluteFor(SITE_URL, route);
export const canonical = absolute;
export function pageMetadata({route, title = HOME_TITLE, description = HOME_DESCRIPTION, privatePage = false}: {route:string; title?:string; description?:string; privatePage?:boolean}): Metadata {
  const url = canonical(route), index = !NOINDEX && !privatePage;
  const image = {url:absolute('/og-default.png'),width:1200,height:630,alt:'Citely — Grounded answers, cited.'};
  return {title:{absolute:title},description,alternates:{canonical:url},robots:{index,follow:index},
    openGraph:{type:'website',siteName:PRODUCT_NAME,title,description,url,images:[image]},
    twitter:{card:'summary_large_image',title,description,images:[image]}};
}
