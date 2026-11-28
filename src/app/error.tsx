"use client";

/**
 * 客户端错误边界。
 *
 * 没有这个文件时，任何一个组件在渲染期抛错，用户看到的是 Next 的默认错误页
 * （白底黑字 + 英文 "Application error"）——行程数据其实还在 localStorage 里，
 * 但界面上没有任何提示，看起来像整个产品挂了。
 */
export default function ErrorBoundary({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col items-center justify-center px-6 text-center">
      <p className="text-meta tracking-[0.22em] text-accent">漫城</p>
      <h1 className="mt-3 font-serif text-[24px] leading-tight text-ink">
        这一步没走通
      </h1>
      <p className="mt-3 text-body leading-relaxed text-ink-soft">
        已经排好的行程还在这台设备上，重试一次通常就好了。
        反复失败的话，刷新页面重新排一程，记录不会丢。
      </p>
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-full bg-ink px-5 py-2.5 text-body font-medium text-paper shadow-soft transition hover:bg-ink/90"
        >
          重试
        </button>
        <a
          href="/"
          className="rounded-full border border-line px-5 py-2.5 text-body text-ink-soft transition hover:border-ink/30 hover:text-ink"
        >
          回到首页
        </a>
      </div>
    </main>
  );
}
