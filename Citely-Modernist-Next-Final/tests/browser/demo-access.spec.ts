import {test, expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {mockApi} from './mock-api';

for (const width of [1440,390]) for (const theme of ['light','dark']) {
  test(`demo request preview ${width} ${theme}`, async({page,baseURL})=>{
    const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
    await page.setViewportSize({width,height:1000});
    await page.addInitScript(theme=>localStorage.setItem('citely-modernist-mode',theme),theme);
    await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(baseURL!).origin?route.continue():route.abort());
    await mockApi(page);
    await page.goto(baseURL!);
    await expect(page.locator('.marketing-header').getByRole('link',{name:'Log in'})).toHaveCount(0);
    // Anyone may create an account (it's reviewed), so the landing page offers Sign up.
    const signups = page.locator('a[href*="signin"]');
    expect(await signups.count()).toBeGreaterThan(0);
    for (const href of await signups.evaluateAll(as => as.map(a => a.getAttribute('href')))) expect(href).toMatch(/signin\/\?mode=signup$/);
    await mkdir('/tmp/citely-demo-preview',{recursive:true});
    await page.screenshot({path:`/tmp/citely-demo-preview/landing-${width}-${theme}.png`});
    await page.locator('.marketing-header').getByRole('link',{name:'Request demo'}).click();
    await expect(page.getByRole('heading',{name:'Try Citely.'})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:`/tmp/citely-demo-preview/request-${width}-${theme}.png`,fullPage:true});
    await page.getByLabel('Full name').fill('Preview Visitor');
    await page.getByLabel('Email address').fill('visitor@example.com');
    await page.getByLabel('Phone number').fill('+91 9876543210');
    await page.getByLabel('Why would you like').fill('Explore citations across research documents.');
    let sends=0;
    await page.route('**/demo-requests',async route=>{sends++; await route.fulfill({status:202,contentType:'application/json',body:'{"detail":"sent"}'});});
    const preview = await page.getByText('Preview only · This form will not send or save your details.').count() > 0;
    await page.getByRole('button',{name:'Request demo access'}).click();
    if (preview) {
      expect(sends).toBe(0);
      await expect(page.getByText('This is a preview. No personal details were saved or emailed.')).toBeVisible();
    } else { await expect(page.getByRole('heading',{name:'Thanks for the context.'})).toBeVisible(); expect(sends).toBe(1); }
    await page.screenshot({path:`/tmp/citely-demo-preview/confirmation-${width}-${theme}.png`,fullPage:true});
    await page.goto(new URL('signin/?mode=signin',baseURL!).href);
    await expect(page.getByRole('button',{name:/^Log in/})).toBeVisible();
    await expect(page.getByRole('tab',{name:'Sign up'})).toHaveCount(0);
    await page.screenshot({path:`/tmp/citely-demo-preview/signin-${width}-${theme}.png`,fullPage:true});
    await page.goto(new URL('signin/?mode=signup',baseURL!).href);
    await expect(page.getByRole('heading',{name:'Create your account.'})).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('invalid demo form stays editable',async({page})=>{
  await page.goto('try-demo/');
  await page.getByRole('button',{name:'Request demo access'}).click();
  await expect(page.getByLabel('Full name')).toBeFocused();
  await page.getByLabel('Full name').fill(' ');
  await page.getByLabel('Email address').fill('visitor@example.com');
  await page.getByLabel('Phone number').fill('1234567');
  await page.getByLabel('Why would you like').fill('Research');
  await page.getByRole('button',{name:'Request demo access'}).click();
  await expect(page.locator('.demo-request [role=alert]')).toHaveText('Please complete all four fields.');
  await page.getByLabel('Full name').fill('Visitor');
  await page.getByLabel('Phone number').fill('1234567abc');
  await page.getByRole('button',{name:'Request demo access'}).click();
  await expect(page.locator('.demo-request [role=alert]')).toContainText('Please enter a valid phone number');
});

test('live form retains details on failure and submits once on retry',async({page})=>{
  await mockApi(page);
  await page.goto('try-demo/');
  test.skip(await page.getByText('Preview only · This form will not send or save your details.').count() > 0, 'Live delivery path is tested using the non-preview build');
  await page.getByLabel('Full name').fill('Preview Visitor');
  await page.getByLabel('Email address').fill('visitor@example.com');
  await page.getByLabel('Phone number').fill('+91 9876543210');
  await page.getByLabel('Why would you like').fill('Research');
  let attempts=0;
  await page.route('**/demo-requests',async route=>{
    attempts++;
    expect(route.request().headers()['content-type']).toBe('application/json');
    expect(route.request().postDataJSON()).toEqual({name:'Preview Visitor',email:'visitor@example.com',phone:'+91 9876543210',comment:'Research'});
    await route.fulfill({status:attempts===1?503:202,contentType:'application/json',body:'{}'});
  });
  await page.getByRole('button',{name:'Request demo access'}).click();
  await expect(page.locator('.demo-request [role=alert]')).toContainText('We could not confirm your request');
  await expect(page.getByLabel('Email address')).toHaveValue('visitor@example.com');
  expect(attempts).toBe(1);
  await page.evaluate(()=>{const form=document.querySelector('.demo-request form') as HTMLFormElement; form.requestSubmit(); form.requestSubmit();});
  await expect(page.getByRole('heading',{name:'Thanks for the context.'})).toBeVisible();
  expect(attempts).toBe(2);
});

test('leaving a demo request during wake-up cancels before sending email',async({page})=>{
  await mockApi(page, {readySequence:[503,503,503,503,503,503,503]});
  await page.goto('try-demo/');
  test.skip(await page.getByText('Preview only · This form will not send or save your details.').count()>0, 'Real request path requires the non-preview build');
  let sends=0;
  await page.route('**/demo-requests',route=>{sends++; return route.fulfill({status:202,json:{}});});
  await page.getByLabel('Full name').fill('Visitor');
  await page.getByLabel('Email address').fill('visitor@example.com');
  await page.getByLabel('Phone number').fill('+91 9876543210');
  await page.getByLabel('Why would you like').fill('Research');
  await page.getByRole('button',{name:'Request demo access'}).click();
  await expect(page.getByRole('button',{name:'Connecting to Citely…'})).toBeVisible();
  await page.getByRole('link',{name:'Citely home',exact:true}).first().click();
  await expect(page.locator('.hero')).toBeVisible();
  expect(sends).toBe(0);
});
