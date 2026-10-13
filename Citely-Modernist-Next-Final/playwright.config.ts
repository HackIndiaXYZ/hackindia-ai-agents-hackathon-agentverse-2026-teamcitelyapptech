import {defineConfig} from '@playwright/test';
const prefix=process.env.PREVIEW_BASE_PATH||'/dev';
// PREVIEW_PORT lets several checkouts run their browser tests at once.
const port=process.env.PREVIEW_PORT||'4175';
export default defineConfig({testDir:'./tests/browser',timeout:30000,workers:1,use:{baseURL:process.env.PREVIEW_URL||`http://127.0.0.1:${port}${prefix}/`,viewport:{width:1440,height:1000},reducedMotion:'reduce'},webServer:process.env.PREVIEW_URL?undefined:{command:'node scripts/serve-preview.mjs',url:`http://127.0.0.1:${port}${prefix}/`,reuseExistingServer:false}});
