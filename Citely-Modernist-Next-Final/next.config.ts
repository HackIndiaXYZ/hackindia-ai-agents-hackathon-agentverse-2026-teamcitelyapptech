import type { NextConfig } from "next";
import { BASE_PATH, SITE_URL } from './deploy.config.mjs';
const config: NextConfig = { output: "export", outputFileTracingRoot: process.cwd(), trailingSlash: true, images: {unoptimized:true}, basePath: BASE_PATH, env: {NEXT_PUBLIC_BASE_PATH:BASE_PATH, NEXT_PUBLIC_SITE_URL:SITE_URL} };
export default config;
