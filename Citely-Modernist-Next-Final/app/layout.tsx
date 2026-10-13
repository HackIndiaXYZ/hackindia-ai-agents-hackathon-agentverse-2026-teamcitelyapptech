import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { asset } from "@/lib/config";
import { pageMetadata, absolute } from '@/lib/seo';
import { adminApiOrigins } from '@/lib/admin';
export const metadata: Metadata = {
  ...pageMetadata({route:'/'}),
  metadataBase: new URL(absolute('/')),
  applicationName: 'Citely',
  manifest: asset('/manifest.webmanifest'),
  title: {default:'Citely — AI Document Chat With Source Citations',template:'%s | Citely'},
};
// The admin site talks to each environment's API from its first moment:
// connect to them (DNS, TCP, TLS) while the page's scripts are still loading.
const ADMIN_SITE = process.env.NEXT_PUBLIC_ADMIN_SITE === 'true';
const themeScript =
  "try{document.documentElement.dataset.theme=localStorage.getItem('citely-modernist-mode')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){document.documentElement.dataset.theme='light'}";
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <link rel="stylesheet" href={asset("/branding.css")} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        {/* Fonts from this site (public/fonts), not Google: no extra connection
            before text draws. The two Latin files are fetched straight away. */}
        <link rel="preload" href={asset("/fonts/archivo-latin.woff2")} as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href={asset("/fonts/dm-sans-latin.woff2")} as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="stylesheet" href={asset("/fonts/fonts.css")} />
        {ADMIN_SITE && adminApiOrigins().map(origin => <link key={origin} rel="preconnect" href={origin} crossOrigin="anonymous" />)}
      </head>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
