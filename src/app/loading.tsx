/**
 * 首屏骨架。
 *
 * 首页是纯客户端工作台（地图 + 设置 + 时段流），服务端只负责发壳；
 * 这个 loading 覆盖的是「壳已经在传、JS 还没执行」的那一小段时间。
 * 不做逐块模仿，只给一个形状一致的三栏占位，避免白屏闪一下。
 */
export default function Loading() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1440px] gap-3 px-3 py-3">
      <div className="hidden w-[280px] shrink-0 animate-pulse rounded-[26px] border border-line/70 bg-paper-deep lg:block" />
      <div className="min-w-0 flex-1 animate-pulse rounded-[26px] border border-line/70 bg-paper-deep" />
      <div className="hidden w-[380px] shrink-0 animate-pulse rounded-[26px] border border-line/70 bg-paper-deep xl:block" />
      <span className="sr-only">正在打开漫城工作台</span>
    </div>
  );
}
