import type { MetadataRoute } from 'next';
import { NOINDEX } from '../deploy.config.mjs';
import { absolute } from '@/lib/seo';
export const dynamic = 'force-static';
export default function robots(): MetadataRoute.Robots {
  return NOINDEX ? {rules:{userAgent:'*',disallow:'/'}} : {rules:{userAgent:'*',allow:'/'},sitemap:absolute('/sitemap.xml')};
}
