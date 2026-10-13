// Portable preview only. Production integration must use authenticated server storage.
'use strict';
window.CitelyDemoStorage = (() => {
 const prefix = 'citely-portable-v1:';
 const load = key => JSON.parse(localStorage.getItem(prefix + key) || 'null');
 return {
  async read(key) { return load(key) || {value:null, revision:0}; },
  async write(key, value, revision) {
   const save = () => {
    const previous = load(key);
    if ((previous?.revision || 0) !== revision) throw Error('A newer version was saved in another tab. Export your edits, then reload.');
    const record = {value, revision:revision+1, updated:new Date().toISOString()};
    localStorage.setItem(prefix + key, JSON.stringify(record));
    return {revision:record.revision, updated:record.updated};
   };
   if (navigator.locks) return navigator.locks.request(prefix + key, save);
   return save();
  }
 };
})();
