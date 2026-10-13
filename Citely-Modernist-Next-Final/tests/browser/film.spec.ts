import {test,expect} from '@playwright/test';

test.use({reducedMotion:'no-preference'});
for (const width of [1440,390]) test(`film waits for Play, has sound and loops at ${width}px`,async({page})=>{
  await page.setViewportSize({width,height:900});
  await page.goto('');
  const video=page.locator('#film video');
  await video.scrollIntoViewIfNeeded();
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v:HTMLVideoElement)=>v.duration)).toBeCloseTo(82,0);
  await page.waitForTimeout(500);
  expect(await video.evaluate((v:HTMLVideoElement)=>({paused:v.paused,time:v.currentTime,muted:v.muted,volume:v.volume,autoplay:v.autoplay,loop:v.loop,controls:v.controls,inline:v.playsInline}))).toEqual({paused:true,time:0,muted:false,volume:1,autoplay:false,loop:true,controls:true,inline:true});
  // Space on the native player is a real user gesture, so sound is allowed.
  await video.focus();
  await page.keyboard.press("Space");
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(0.1);
  expect(await video.evaluate((v:HTMLVideoElement)=>v.muted)).toBe(false);
  await page.getByRole('button',{name:'Mute demo video'}).click();
  expect(await video.evaluate((v:HTMLVideoElement)=>v.muted)).toBe(true);
  await page.getByRole('button',{name:'Unmute demo video'}).click();
  await video.evaluate((v:HTMLVideoElement)=>{v.currentTime=v.duration-0.4;});
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime),{timeout:10000}).toBeLessThan(3);
  expect(await video.evaluate((v:HTMLVideoElement)=>v.paused)).toBe(false);
  await video.evaluate((v:HTMLVideoElement)=>v.pause());
  await page.evaluate(()=>scrollTo(0,0));
  await video.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  expect(await video.evaluate((v:HTMLVideoElement)=>v.paused)).toBe(true);
});

test('AAC audio reaches the browser audio graph and muting remains user controlled',async({page})=>{
  await page.goto('');
  const video=page.locator('#film video'); await video.scrollIntoViewIfNeeded();
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(2);
  await page.evaluate(()=>{
    const v=document.querySelector('#film video') as HTMLVideoElement;
    const ctx=new AudioContext(); const source=ctx.createMediaElementSource(v); const analyser=ctx.createAnalyser();
    source.connect(analyser); analyser.connect(ctx.destination);
    (window as any).filmAudio={ctx,analyser};
    v.addEventListener('play',()=>void ctx.resume());
  });
  await video.focus(); await page.keyboard.press('Space');
  await expect.poll(()=>page.evaluate(()=>{
    const {analyser}=(window as any).filmAudio; const data=new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum,value)=>sum+value*value,0)/data.length);
  }),{timeout:10000}).toBeGreaterThan(0.005);
  await page.getByRole('button',{name:'Mute demo video'}).click();
  await video.evaluate((v:HTMLVideoElement)=>v.pause());
  await video.focus(); await page.keyboard.press('Space');
  expect(await video.evaluate((v:HTMLVideoElement)=>v.muted)).toBe(true);
  await page.getByRole('button',{name:'Unmute demo video'}).click();
  expect(await video.evaluate((v:HTMLVideoElement)=>({muted:v.muted,volume:v.volume}))).toEqual({muted:false,volume:1});
});
