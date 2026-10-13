// Build each shape in a new isolated source tree. Existing out/.next folders are untouched.
import { mkdtemp, cp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const source=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const root=await mkdtemp(path.join(tmpdir(),'citely-seo-preview-'));
console.log(`PREVIEW_ROOT=${root}`);
const exclude=new Set(['node_modules','.next','out','.git','test-results','playwright-report','tsconfig.tsbuildinfo']);
for(const [name,base] of [['production',''],['dev','/dev'],['production-default',''],['dev-default','/dev']]) {
  const cwd=path.join(root,name);
  await cp(source,cwd,{recursive:true,filter:p=>!path.relative(source,p).split(path.sep).some(part=>exclude.has(part)||part.startsWith('.env'))});
  await symlink(path.join(source,'node_modules'),path.join(cwd,'node_modules'),'dir');
  const env={...process.env,BASE_PATH:base,NEXT_PUBLIC_BASE_PATH:base,SITE_URL:`https://citely.example${base}`,NEXT_PUBLIC_SITE_URL:`https://citely.example${base}`,NEXT_PUBLIC_NOINDEX:base?'true':'false',NEXT_PUBLIC_API_BASE_URL:'http://127.0.0.1:8000'};
  if(name.endsWith('-default')) {
    delete env.SITE_URL; delete env.NEXT_PUBLIC_SITE_URL; delete env.NEXT_PUBLIC_BASE_PATH; delete env.NEXT_PUBLIC_NOINDEX;
    if(!base)delete env.BASE_PATH;
  }
  const result=spawnSync('npm',['run','build'],{cwd,env,encoding:'utf8'});
  await writeFile(path.join(root,`${name}.log`),(result.stdout||'')+(result.stderr||''));
  if(result.status!==0) {console.error(result.stdout,result.stderr);process.exit(1);}
  console.log(`${name}: ${cwd}/out`);
}
