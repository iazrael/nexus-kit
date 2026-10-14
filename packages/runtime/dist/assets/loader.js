const abortReason = (signal) => signal.reason ?? new DOMException("已取消", "AbortError");
function validate(key, p) {
    if (key === "")
        throw new Error("加载任务的 key 不得为空");
    if (!Number.isInteger(p.tier) || p.tier < 0 || p.tier > 3)
        throw new RangeError(`加载档位须为 0..3：${String(p.tier)}`);
    if (p.order !== undefined && !Number.isFinite(p.order))
        throw new RangeError(`加载次序值须为有限数：${String(p.order)}`);
}
/** a 比 b 更急 */
const before = (a, b) => a.tier !== b.tier ? a.tier < b.tier : a.order !== b.order ? a.order < b.order : a.seq < b.seq;
export function createLoader(options = {}) {
    const concurrency = options.concurrency ?? 6;
    if (!Number.isInteger(concurrency) || concurrency < 1)
        throw new RangeError(`并发上限须为正整数：${String(concurrency)}`);
    const setTimer = options.setTimer ??
        ((fn, ms) => {
            const id = setTimeout(fn, ms);
            return () => clearTimeout(id);
        });
    const log = options.log;
    const tasks = new Map();
    let running = 0;
    let seq = 0;
    let gate = { open: true };
    const queued = () => [...tasks.values()].filter((t) => t.state === "queued");
    const eligible = (t) => gate.open || t.tier < 2;
    function start(task) {
        task.state = "running";
        running++;
        let pending;
        try {
            pending = task.run();
        }
        catch (error) {
            pending = Promise.reject(error);
        }
        void Promise.resolve(pending)
            .then(task.resolve, task.reject)
            .finally(() => {
            running--;
            if (tasks.get(task.key) === task)
                tasks.delete(task.key);
            pump();
        });
    }
    function pump() {
        while (running < concurrency) {
            let best = null;
            for (const t of tasks.values())
                if (t.state === "queued" && eligible(t) && (best === null || before(t, best)))
                    best = t;
            if (best === null)
                return;
            start(best);
        }
    }
    /** 一个调用方放弃：全部放弃且还在排队就出队 */
    function detach(task, reason) {
        task.callers--;
        if (task.callers > 0 || task.state !== "queued" || tasks.get(task.key) !== task)
            return;
        tasks.delete(task.key);
        task.reject(reason);
    }
    const unregister = options.perf
        ? [options.perf.registerGauge("assets.queued", () => queued().length), options.perf.registerGauge("assets.running", () => running)]
        : [];
    return {
        schedule(key, priority, run, opts = {}) {
            validate(key, priority);
            const { signal } = opts;
            if (signal?.aborted)
                return Promise.reject(abortReason(signal));
            const order = priority.order ?? 0;
            let task = tasks.get(key);
            if (task === undefined) {
                let resolve;
                let reject;
                const promise = new Promise((y, n) => ((resolve = y), (reject = n)));
                // 全部调用方都取消后共享结果被拒绝，此时已没人在等：挂空处理，不报未处理的拒绝
                promise.catch(() => undefined);
                task = { key, tier: priority.tier, order, seq: seq++, state: "queued", callers: 0, run, promise, resolve, reject };
                tasks.set(key, task);
            }
            else if (task.state === "queued" && (priority.tier < task.tier || (priority.tier === task.tier && order < task.order))) {
                task.tier = priority.tier;
                task.order = order;
            }
            task.callers++;
            const shared = task.promise;
            const own = task;
            const out = signal === undefined
                ? shared
                : new Promise((resolve, reject) => {
                    const onAbort = () => {
                        const reason = abortReason(signal);
                        reject(reason);
                        detach(own, reason);
                    };
                    signal.addEventListener("abort", onAbort, { once: true });
                    shared.then((v) => (signal.removeEventListener("abort", onAbort), resolve(v)), (e) => (signal.removeEventListener("abort", onAbort), reject(e)));
                });
            pump();
            return out;
        },
        /** 改排队中任务的优先级（可升可降）；在飞或不存在返回 false */
        reprioritize(key, priority) {
            validate(key, priority);
            const task = tasks.get(key);
            if (task === undefined || task.state !== "queued")
                return false;
            task.tier = priority.tier;
            task.order = priority.order ?? 0;
            pump();
            return true;
        },
        /** 关键闸门：critical 有结论或 capMs 到期前，档位 2、3 不发。新的 hold 取代旧闸门 */
        hold(critical, capMs) {
            if (!Number.isFinite(capMs) || capMs < 0)
                throw new RangeError(`闸门封顶时限须为非负有限数：${String(capMs)}`);
            const g = { open: false };
            gate = g;
            let cancelCap = () => undefined;
            const release = (by) => {
                if (g.open)
                    return;
                g.open = true;
                cancelCap(); // 有结论了就撤掉封顶定时器，不让它拖住进程退出
                if (gate !== g)
                    return; // 已被新闸门取代
                log?.info("关键闸门放行", { by, held: queued().filter((t) => t.tier >= 2).length });
                pump();
            };
            cancelCap = setTimer(() => release("cap"), capMs);
            critical.then(() => release("settled"), () => release("settled"));
        },
        has: (key) => tasks.has(key),
        /** 任务在哪：排队中 / 在飞 / 不存在 */
        state(key) {
            return tasks.get(key)?.state ?? null;
        },
        snapshot() {
            return {
                running: [...tasks.values()].filter((t) => t.state === "running").map((t) => t.key),
                queued: queued()
                    .sort((a, b) => (before(a, b) ? -1 : 1))
                    .map((t) => t.key),
                gateOpen: gate.open,
            };
        },
        /** 注销水位指标（排队与在飞的任务不受影响） */
        dispose() {
            for (const off of unregister.splice(0))
                off();
        },
    };
}
