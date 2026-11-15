import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../src/renderer/utils/task-queue';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
test('task queue serializes tasks and ignores duplicate submissions', async () => {
 const queue = new TaskQueue(), gate = deferred(), order: string[] = [];
 const first = queue.enqueue('a', async () => { order.push('a'); await gate.promise; });
 const duplicate = queue.enqueue('a', async () => { order.push('duplicate'); });
 const second = queue.enqueue('b', async () => { order.push('b'); });
 await Promise.resolve(); assert.deepEqual(order,['a']); assert.equal(queue.getSnapshot().b.state,'queued');
 gate.resolve(); await Promise.all([first,duplicate,second]);
 assert.deepEqual(order,['a','b']); assert.equal(queue.getSnapshot().a.state,'completed');
});
test('failed and cancelled tasks do not prevent later tasks from running', async () => {
 const queue = new TaskQueue(), gate = deferred(); let skipped = false, done = false;
 const first = queue.enqueue('a', async () => { await gate.promise; throw new Error('generation failed'); });
 const second = queue.enqueue('b', async () => { skipped = true; }); queue.cancel('b');
 const third = queue.enqueue('c', async () => { done = true; });
 gate.resolve(); await Promise.all([first,second,third]);
 assert.equal(queue.getSnapshot().a.state,'failed'); assert.equal(queue.getSnapshot().a.error,'generation failed');
 assert.equal(queue.getSnapshot().b.state,'cancelled'); assert.equal(skipped,false); assert.equal(done,true);
});
test('cancelling a running task keeps its ownership until cleanup finishes', async () => {
 const queue = new TaskQueue(), cleanup = deferred(), aborted = deferred(); let nextStarted = false;
 const first = queue.enqueue('a', async signal => { signal.addEventListener('abort',aborted.resolve,{once:true}); await aborted.promise; await cleanup.promise; });
 const second = queue.enqueue('b', async () => { nextStarted = true; });
 await Promise.resolve(); queue.cancel('a'); await aborted.promise; assert.equal(nextStarted,false);
 cleanup.resolve(); await Promise.all([first,second]); assert.equal(queue.getSnapshot().a.state,'cancelled'); assert.equal(nextStarted,true);
});
