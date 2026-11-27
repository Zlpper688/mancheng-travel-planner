/**
 * 一行 JSON 的结构化日志。
 *
 * 为什么不用现成的 logger：这个项目跑在单进程里，排障靠 `docker logs` / 终端输出，
 * 引入 pino 只会多一层依赖。真正缺的不是"日志库"，而是**可检索的字段**——
 * 接口、耗时、城市、结果条数。有了这几个字段，答辩时"一次排线平均 6.8 秒、
 * 一次对话平均 900 毫秒"就是一句可复现的话，而不是感觉。
 *
 * `MC_LOG=0` 可以整体关掉（压测和 CI 里用）。
 */
type Level = "info" | "warn" | "error";

export function logEvent(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  if (process.env.MC_LOG === "0") return;
  const line = JSON.stringify({
    t: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** 计时器：`const done = timer(); ... done({ ok: true })`。 */
export function timer(): (extra?: Record<string, unknown>) => number {
  const startedAt = Date.now();
  return (extra = {}) => {
    const ms = Date.now() - startedAt;
    logEvent("info", "timing", { ms, ...extra });
    return ms;
  };
}
