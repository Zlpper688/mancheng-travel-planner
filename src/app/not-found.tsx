import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col items-center justify-center px-6 text-center">
      <p className="text-meta tracking-[0.22em] text-accent">404</p>
      <h1 className="mt-3 font-serif text-[24px] leading-tight text-ink">
        这条路不在漫城的图里
      </h1>
      <p className="mt-3 text-body leading-relaxed text-ink-soft">
        地址可能拼错了，或者这一页已经不在了。回到首页重新选一座城就行。
      </p>
      <Link
        href="/"
        className="mt-7 rounded-full bg-ink px-5 py-2.5 text-body font-medium text-paper shadow-soft transition hover:bg-ink/90"
      >
        回到首页
      </Link>
    </main>
  );
}
