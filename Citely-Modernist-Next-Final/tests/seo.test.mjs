import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployment } from '../deploy.config.mjs';
import { absoluteFor, PUBLIC_ROUTES, faqSchema } from '../lib/seo-data.mjs';
import { readFileSync } from 'node:fs';
test('deployment defaults and normalized production/dev shapes',()=>{
  assert.deepEqual(deployment({}),{BASE_PATH:'',SITE_URL:'https://citely.example',NOINDEX:false});
  for(const BASE_PATH of ['/dev',' /dev/ ','/dev///']) {
    const d=deployment({BASE_PATH});
    assert.equal(d.SITE_URL,'https://citely.example/dev');assert.equal(d.NOINDEX,true);
    assert.equal(absoluteFor(d.SITE_URL,'/about/'),'https://citely.example/dev/about/');
    assert.equal(absoluteFor(d.SITE_URL,'/og-default.png'),'https://citely.example/dev/og-default.png');
  }
  assert.equal(deployment({BASE_PATH:'/',SITE_URL:'https://citely.example/'}).BASE_PATH,'');
  assert.equal(deployment({NEXT_PUBLIC_BASE_PATH:'/dev',SITE_URL:'http://localhost:8000/dev/'}).SITE_URL,'http://localhost:8000/dev');
  assert.equal(deployment({NEXT_PUBLIC_NOINDEX:'true'}).NOINDEX,true);
});
test('invalid and conflicting deployment settings fail explicitly',()=>{
  for(const env of [
    {SITE_URL:''},{SITE_URL:'citely.example'},{SITE_URL:'ftp://example.com'},{SITE_URL:'https://user:pass@example.com'},
    {SITE_URL:'https://example.com?q=x'},{SITE_URL:'https://example.com/#a'},
    {BASE_PATH:'dev'},{BASE_PATH:'//dev'},{BASE_PATH:'/a/../dev'},{BASE_PATH:'/dev?x'},
    {BASE_PATH:'/dev',NEXT_PUBLIC_BASE_PATH:''},{BASE_PATH:'',NEXT_PUBLIC_SITE_URL:'https://citely.example/dev'},
    {BASE_PATH:'/dev',SITE_URL:'https://citely.example'}, {SITE_URL:'https://a.com',NEXT_PUBLIC_SITE_URL:'https://b.com'},
    {BASE_PATH:'/dev',NEXT_PUBLIC_NOINDEX:'false'},{NEXT_PUBLIC_NOINDEX:'yes'}
  ]) assert.throws(()=>deployment(env),JSON.stringify(env));
});
test('sitemap allowlist excludes privacy and all private routes',()=>{
  const documentationRoutes=['/documentation/','/documentation/architecture/','/documentation/ingestion-pipeline/','/documentation/retrieval/','/documentation/answer-generation/','/documentation/source-viewers/','/documentation/citations-annotations/','/documentation/security-privacy/','/documentation/interactive-demo/'];
  assert.deepEqual(PUBLIC_ROUTES,['/','/how-it-works/','/features/document-chat/','/features/source-citations/','/about/',...documentationRoutes]);
  for(const route of PUBLIC_ROUTES.filter(route=>!route.startsWith('/documentation/'))) assert.ok(readFileSync(new URL(`../app${route}page.tsx`,import.meta.url),'utf8'));
  assert.match(readFileSync(new URL('../app/documentation/[slug]/page.tsx',import.meta.url),'utf8'),/generateStaticParams/);
  assert.ok(!PUBLIC_ROUTES.some(route=>['/privacy/','/signin/','/home/','/workbench/'].includes(route)));
});
test('public demo entry requires an explicit synthetic-data notice',()=>{
  const demo=readFileSync(new URL('../components/ProductDemo.tsx',import.meta.url),'utf8');
  assert.match(demo,/synthetic documents/);
  assert.match(demo,/does not upload your files/);
  assert.match(demo,/Continue to full demo/);
  assert.doesNotMatch(demo,/<iframe/);
});
test('FAQ schema has the same questions and answers as the shared visible data',()=>{
  const src=readFileSync(new URL('../lib/faq.ts',import.meta.url),'utf8');
  const faq=Function(src.replace('export const FAQ_CONTENT =','return'))();
  assert.deepEqual(faqSchema(faq).mainEntity.map(q=>({q:q.name,a:q.acceptedAnswer.text})),faq);
  assert.match(readFileSync(new URL('../components/Marketing.tsx',import.meta.url),'utf8'),/import \{ FAQ_CONTENT \} from '@\/lib\/faq'/);
});
