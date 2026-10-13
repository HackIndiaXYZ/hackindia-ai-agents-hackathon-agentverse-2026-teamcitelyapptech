import { build } from 'esbuild';
import nextEnv from '@next/env';
nextEnv.loadEnvConfig(process.cwd(), process.argv.includes('--development'));
const { BASE_PATH, SITE_URL } = await import('../deploy.config.mjs');
// Every process.env name the bundled bridge reads must be listed: esbuild only
// substitutes these, and any other reference survives as `process` — which
// does not exist in the browser and kills the whole workspace at load.
const names = ['NEXT_PUBLIC_API_BASE_URL','NEXT_PUBLIC_SITE_URL','NEXT_PUBLIC_GITHUB_CLIENT_ID','NEXT_PUBLIC_GOOGLE_CLIENT_ID','NEXT_PUBLIC_WAKE_BUDGET_MS','NEXT_PUBLIC_VIEWER_DOCX','NEXT_PUBLIC_VIEWER_PDF','NEXT_PUBLIC_VIEWER_XLSX','NEXT_PUBLIC_VIEWER_PPTX'];
const define = Object.fromEntries(names.map(name => [`process.env.${name}`,JSON.stringify(process.env[name] || '')]));
define['process.env.NEXT_PUBLIC_BASE_PATH'] = JSON.stringify(BASE_PATH);
define['process.env.NEXT_PUBLIC_SITE_URL'] = JSON.stringify(SITE_URL);
define['process.env.NODE_ENV'] = JSON.stringify(process.argv.includes('--development') ? 'development' : 'production');
await build({entryPoints:['studio-api.ts'],outfile:'public/studio-api.js',bundle:true,format:'iife',platform:'browser',target:'es2020',define});
// Document viewers: separate ES modules loaded on demand by the bridge, so the
// workspace bundle above never carries a renderer it is not using.
await build({entryPoints:['viewers/docx.ts','viewers/xlsx.ts','viewers/pptx.ts','viewers/pdf.ts'],outdir:'public/viewers',bundle:true,splitting:true,format:'esm',platform:'browser',target:'es2020',minify:true,define});

// The PDF viewer's worker, fonts and character maps are loaded by URL, beside the viewer
// module. The worker is named .js (it is a module worker either way): every host serves
// .js as JavaScript, but some serve .mjs as an opaque download that browsers refuse to run.
const {copyFile, cp} = await import('node:fs/promises');
await copyFile('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'public/viewers/pdf.worker.min.js');
await cp('node_modules/pdfjs-dist/standard_fonts', 'public/viewers/pdfjs/standard_fonts', {recursive: true});   // PDFs that do not embed their fonts
await cp('node_modules/pdfjs-dist/cmaps', 'public/viewers/pdfjs/cmaps', {recursive: true});                     // Chinese, Japanese and Korean text

// The public demo shares the renderer, but never bundles the real API bridge.
await build({entryPoints:['studio-demo.ts'],outfile:'public/studio-demo.js',bundle:true,format:'iife',platform:'browser',target:'es2020'});
const {readFile,writeFile}=await import('node:fs/promises');
// Use the product CSS without its remote font request in the isolated demo.
await writeFile('public/demo-citely.css',(await readFile('public/citely.css','utf8')).replace(/^@import[^\n]*\n/,''));
