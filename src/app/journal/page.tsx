"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  deleteJournal,
  formatJournalText,
  loadJournals,
  updateJournalNote,
  type TripJournal,
} from "@/lib/journal";
import { copyText } from "@/lib/share";

/**
 * 旅行记录页（宪法 C 闭环）。
 *
 * 三段式：已归档的旅程 → 点开看每天去了哪 → 复制分享 / 一键再来一遍。
 * 数据全在浏览器本地，不需要账号；「同款玩法」链接用的是 share.ts 的配方编码。
 */
export default function JournalPage() {
  const [journals, setJournals] = useState<TripJournal[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    setJournals(loadJournals());
  }, []);

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2200);
  }

  async function shareOne(journal: TripJournal) {
    const url = `${window.location.origin}/?${journal.recipe}`;
    const text = formatJournalText(journal, url);
    const ok = await copyText(text);
    flash(ok ? "已复制，可以直接粘进微信" : "复制失败，请手动选择文本");
  }

  function removeOne(journal: TripJournal) {
    setJournals(deleteJournal(journal.id));
    flash("已删除这条记录");
  }

  function saveNote(journal: TripJournal, note: string) {
    setJournals(updateJournalNote(journal.id, note));
    setEditingNote(null);
    flash("感受已保存");
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-4 pb-24 pt-10 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-meta text-ink-faint">漫城 · 旅行记录</p>
          <h1 className="mt-1 font-serif text-[26px] leading-tight text-ink">
            走过的路，可以再走一遍
          </h1>
          <p className="mt-2 max-w-lg text-body text-ink-soft">
            每一程都存成一个可复用的玩法：分享给别人，别人点开就能排出同款；
            自己下次也能照着改。
          </p>
        </div>
        <Link
          href="/"
          className="rounded-full bg-jade px-4 py-2 text-body font-medium text-paper shadow-soft transition hover:brightness-105"
        >
          去排一程
        </Link>
      </header>

      {journals === null ? (
        <p className="mt-10 text-meta text-ink-faint">正在读取本地记录…</p>
      ) : journals.length === 0 ? (
        <section className="mt-10 rounded-2xl border border-line/70 bg-card px-5 py-10 text-center shadow-soft">
          <p className="font-serif text-[18px] text-ink">还没有记录</p>
          <p className="mx-auto mt-2 max-w-sm text-body text-ink-soft">
            排完一程后，在行程面板点「记下这趟」，这里就会出现它。
            不写感想也能存，记录是自动归档的。
          </p>
          <Link
            href="/"
            className="mt-5 inline-block rounded-full border border-jade/40 bg-jade-soft px-4 py-2 text-body text-jade"
          >
            去排第一程
          </Link>
        </section>
      ) : (
        <ul className="mt-8 space-y-4">
          {journals.map((journal) => {
            const open = openId === journal.id;
            const sights = journal.daySnapshots.flatMap((d) =>
              d.stops.filter((s) => s.kind === "sight").map((s) => s.name),
            );
            return (
              <li
                key={journal.id}
                className="overflow-hidden rounded-2xl border border-line/70 bg-card shadow-soft"
              >
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : journal.id)}
                  className="flex w-full items-start justify-between gap-4 px-5 py-4 text-left"
                >
                  <div className="min-w-0">
                    <p className="truncate font-serif text-[18px] text-ink">
                      {journal.title}
                    </p>
                    <p className="mt-1 text-meta text-ink-faint">
                      {journal.startDate}
                      {journal.endDate !== journal.startDate
                        ? ` – ${journal.endDate}`
                        : ""}{" "}
                      · {journal.days} 天 · {journal.travelers} 人 ·{" "}
                      {sights.length} 个景点
                    </p>
                    <p className="mt-1 line-clamp-1 text-meta text-ink-soft">
                      {sights.slice(0, 6).join(" / ") || "自由活动"}
                    </p>
                  </div>
                  <span className="shrink-0 text-meta text-ink-faint">
                    {open ? "收起" : "展开"}
                  </span>
                </button>

                {open ? (
                  <div className="border-t border-line/60 px-5 py-4">
                    <ol className="space-y-3">
                      {journal.daySnapshots.map((day) => (
                        <li key={day.index}>
                          <p className="text-body font-medium text-ink">
                            Day {day.index}
                            {day.theme ? ` · ${day.theme}` : ""}
                            <span className="ml-2 text-meta text-ink-faint">
                              {day.area}
                            </span>
                          </p>
                          {day.stops.length ? (
                            <ul className="mt-1 space-y-0.5">
                              {day.stops.map((stop, i) => (
                                <li
                                  key={`${stop.name}-${i}`}
                                  className="text-meta text-ink-soft"
                                >
                                  <span className="tabular-nums text-ink-faint">
                                    {stop.time}
                                  </span>
                                  <span className="ml-2">{stop.name}</span>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-meta text-ink-faint">
                              自由活动
                            </p>
                          )}
                          <p className="mt-1 text-micro text-ink-faint">
                            约 {day.distanceKm} 公里 · {day.sightCount} 个景点
                          </p>
                        </li>
                      ))}
                    </ol>

                    <p className="mt-4 rounded-xl bg-paper px-3 py-2 text-meta text-ink-soft">
                      花费：{journal.travelers} 人 ¥
                      {Math.round(journal.budget.totalMin).toLocaleString("zh-CN")}–
                      {Math.round(journal.budget.totalMax).toLocaleString("zh-CN")}
                      （人均 ¥
                      {Math.round(journal.budget.perPersonMin).toLocaleString("zh-CN")}–
                      {Math.round(journal.budget.perPersonMax).toLocaleString("zh-CN")}）
                    </p>

                    {editingNote === journal.id ? (
                      <div className="mt-3">
                        <textarea
                          defaultValue={journal.note ?? ""}
                          rows={2}
                          maxLength={200}
                          placeholder="一句话记下这趟的感觉（可选）"
                          className="w-full rounded-xl border border-line bg-paper px-3 py-2 text-body text-ink outline-none focus:border-jade"
                          onBlur={(e) => saveNote(journal, e.target.value)}
                        />
                        <p className="mt-1 text-micro text-ink-faint">
                          点空白处保存
                        </p>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setEditingNote(journal.id)}
                        className="mt-3 text-meta text-jade underline-offset-2 hover:underline"
                      >
                        {journal.note ? `感受：${journal.note}` : "写一句感受（可选）"}
                      </button>
                    )}

                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => shareOne(journal)}
                        className="rounded-full bg-jade px-3.5 py-1.5 text-meta font-medium text-paper"
                      >
                        复制分享（含同款链接）
                      </button>
                      <Link
                        href={`/?${journal.recipe}`}
                        className="rounded-full border border-jade/40 bg-jade-soft px-3.5 py-1.5 text-meta text-jade"
                      >
                        再走一遍
                      </Link>
                      <button
                        type="button"
                        onClick={() => removeOne(journal)}
                        className="rounded-full border border-line px-3.5 py-1.5 text-meta text-ink-faint"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-meta text-paper shadow-lift">
          {toast}
        </div>
      ) : null}
    </main>
  );
}
