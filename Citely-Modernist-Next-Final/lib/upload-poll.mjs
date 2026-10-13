export function abortableDelay(ms, signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
/** One request at a time, bounded retries, cancellable request AND backoff. */
export async function pollUpload(initial, getJob, {signal,onStatus=()=>{},onError=()=>{},timeout=900000,delay=abortableDelay,interval=2000}={}) {
  let job=initial,failures=0;
  const deadline=Date.now()+timeout;
  while(true){
    signal?.throwIfAborted();
    onStatus(job);
    if(job.status==='succeeded'&&job.result)return job.result;
    if(job.status==='failed')throw Error(job.error||'Document processing failed.');
    if(!['queued','running'].includes(job.status))throw Error('Unexpected upload status. Retry checking this upload.');
    if(Date.now()>=deadline)throw Error('Status checking paused. Retry to check this upload; processing may still be running.');
    await delay(Math.min(interval*2**failures,15000),signal);
    try{job=await getJob(job.job_id,signal);signal?.throwIfAborted();failures=0;onError('');}
    catch(error){
      if(signal?.aborted)throw error;
      if(error.status&&error.status<500&&![408,429].includes(error.status))throw error;
      if(++failures>=4)throw Error('Status checking failed. Retry to check the same upload.');
      onError('Connection interrupted. Retrying status check…');
    }
  }
}
