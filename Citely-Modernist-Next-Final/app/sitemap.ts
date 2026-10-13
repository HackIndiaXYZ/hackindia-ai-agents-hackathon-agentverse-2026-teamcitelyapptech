import type { MetadataRoute } from 'next';
import { NOINDEX } from '../deploy.config.mjs';
import { absolute, PUBLIC_ROUTES } from '@/lib/seo';
export const dynamic = 'force-static';
export default function sitemap(): MetadataRoute.Sitemap {
  return NOINDEX ? [] : PUBLIC_ROUTES.map(route => ({url:absolute(route)}));
}
