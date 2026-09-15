// 按 key 串行化的异步锁。
//
// 为什么需要：stdio 主循环不会等待上一个 tools/call 处理完就派发下一条消息，
// 所以「run_workflow 正在改这条流」和「宿主同时 complete_step」可能并发落盘，
// 互相覆盖结果。用它把同一条流上的写操作排成队列，跨流仍可并行。
//
// 注意：cancel_run 刻意不加锁——它的语义就是打断正在持锁的长任务。
const tails = new Map();

export function withLock(key, fn) {
  const prev = tails.get(key) ?? Promise.resolve();
  const result = prev.then(() => fn());
  // tail 永不 reject，避免一次失败把整条队列卡死
  const tail = result.then(() => undefined, () => undefined);
  tails.set(key, tail);
  tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
  return result;
}

export function pendingLocks() { return tails.size; }
