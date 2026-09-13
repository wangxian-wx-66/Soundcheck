// 并发闸门：活跃分析信号量（≤6）+ 排队位置通知 + 上游在飞上限（zhihu ≤4 / llm ≤4）
// 接口签名在 P0-A 定死：gate.acquire(onPosition) → Promise<release>；gate.withUpstream(name, fn)

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  return {
    async run(fn) {
      while (active >= limit) await new Promise((resolve) => queue.push(resolve));
      active++;
      try { return await fn(); }
      finally { active--; queue.shift()?.(); }
    },
    get active() { return active; },
    get queued() { return queue.length; },
  };
}

export function createGate({ activeLimit = 6, upstreamLimits = { zhihu: 4, llm: 4 } } = {}) {
  const upstream = {};
  for (const [name, limit] of Object.entries(upstreamLimits)) upstream[name] = createSemaphore(limit);

  let running = 0;
  const waiters = [];

  function release() {
    running--;
    const next = waiters.shift();
    if (next) {
      running++;
      let position = 1;
      for (const waiter of waiters) waiter.onPosition?.(position++);
      next.resolve(release);
    }
  }

  return {
    /** 申请一个活跃分析槽位；排队期间通过 onPosition(position) 通知队列位置 */
    acquire(onPosition) {
      if (running < activeLimit) {
        running++;
        return Promise.resolve(release);
      }
      const waiter = { onPosition, resolve: null };
      const promise = new Promise((resolve) => { waiter.resolve = resolve; });
      waiters.push(waiter);
      waiter.onPosition?.(waiters.length);
      return promise;
    },

    /** 上游在飞上限保护：zhihu_search / llm 各自独立信号量 */
    withUpstream(name, fn) {
      const sem = upstream[name];
      return sem ? sem.run(fn) : fn();
    },

    stats() {
      return {
        running,
        queued: waiters.length,
        upstream: Object.fromEntries(Object.entries(upstream).map(([name, sem]) => [name, { active: sem.active, queued: sem.queued }])),
      };
    },
  };
}
