import test from 'node:test';
import assert from 'node:assert/strict';
import {pollUpload,abortableDelay} from '../lib/upload-poll.mjs';
import {browserCitation,locatable} from '../lib/ranges.mjs';

test('polling retries transient errors without overlapping or duplicating ingest',async()=>{
 let calls=0,active=0;const waits=[],errors=[],statuses=[];
 const result=await pollUpload({job_id:'one',status:'queued'},async()=>{
  assert.equal(++active,1);calls++;active--;
  if(calls<3)throw {status:503};
  return {job_id:'one',status:'succeeded',result:{document_id:'done'}};
 },{delay:async ms=>{waits.push(ms)},onError:e=>errors.push(e),onStatus:j=>statuses.push(j.status)});
 assert.equal(result.document_id,'done');assert.equal(calls,3);assert.deepEqual(waits,[2000,4000,8000]);assert.equal(errors.at(-1),'');
});
test('bounded failures leave a resumable job, no invented terminal state',async()=>{
 let calls=0;
 await assert.rejects(pollUpload({job_id:'one',status:'running'},async()=>{calls++;throw {status:503}},{delay:async()=>{}}),/Retry to check the same upload/);
 assert.equal(calls,4);
});
test('workspace cancellation interrupts backoff before another request',async()=>{
 const controller=new AbortController();let calls=0;
 const pending=pollUpload({job_id:'one',status:'queued'},async()=>{calls++},{signal:controller.signal,interval:5000});
 controller.abort();await assert.rejects(pending);assert.equal(calls,0);
 await assert.rejects(abortableDelay(1000,controller.signal));
});
test('terminal failure is surfaced and never polled again',async()=>{
 await assert.rejects(pollUpload({job_id:'one',status:'failed',error:'Parser failed'},()=>{throw Error('must not call')}),/Parser failed/);
});
test('codepoint legacy citations convert to UTF-16 after emoji',()=>{
 const page={text:'😀 a passage.',extraction_version:'1'};
 const old={page_char_start:4,page_char_end:11,quote:'passage',extraction_version:'1',offset_unit:'codepoint'};
 const normalized=browserCitation(page,old);
 assert.equal(page.text.slice(normalized.page_char_start,normalized.page_char_end),'passage');
 assert.equal(normalized.page_char_start,5);assert.equal(locatable(page,old),true);
});
test('stale quote with numerically valid bounds is not painted',()=>{
 assert.equal(locatable({text:'new passage',extraction_version:'1'},{page_char_start:0,page_char_end:3,quote:'old',extraction_version:'1'}),false);
});
