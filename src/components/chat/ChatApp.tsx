"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BUDGET_TIERS,
  PACES,
  QUICK_CITIES,
  STYLE_LABELS,
  TRANSPORT_OPTIONS,
} from "@/lib/constants";
import {
  applyResolvedPatch,
  buildTripInput,
  cardForStep,
  makeDraft,
  wizardStep,
} from "@/lib/chat/draft";
import type {
  ChatApiResponse,
  ChatCard,
  ChatCardKind,
  ChatDraft,
  ChatMessage,
  ResolvedPatch,
} from "@/lib/chat/types";
import { EXPERIENCE_OPTIONS } from "@/lib/plan/experience-options";
import type { PlanResponse, PlanResult, Place } from "@/lib/types";
import type { WalkApi } from "../MapView";
import { Icon } from "../Icon";
import PlanPanel from "../PlanPanel";
import { cn } from "../ui";
import ChatCardView from "./ChatCards";
import Walkthrough from "./Walkthrough";

const MapView = dynamic(() => import("../MapView"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full animate-pulse bg-paper-deep" />
  ),
});

type Mode = "ai" | "wizard";

let idSeq = 0;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function stripCards(message: ChatMessage): ChatMessage {
  if (!message.cards?.length) return message;
  return { ...message, cards: undefined };
}

function pickedHotel(lng: number, lat: number): Place {
  return {
    id: `picked-${lat.toFixed(5)}-${lng.toFixed(5)}`,
    name: "地图选点",
    category: "hotel",
    lat,
    lng,
    address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    source: "demo",
  };
}

function labelForPatch(patch: ResolvedPatch): string {
  const parts: string[] = [];
  if (patch.city) parts.push(patch.city.name);
  if (patch.hotel) parts.push(`住处：${patch.hotel.name}`);
  if (patch.date !== undefined || patch.days !== undefined) {
    parts.push(
      patch.date && patch.days
        ? `${patch.date} · ${patch.days} 天`
        : patch.date ?? `${patch.days} 天`,
    );
  }
  if (
    patch.adults !== undefined ||
    patch.children !== undefined ||
    patch.seniors !== undefined
  ) {
    parts.push(
      `${patch.adults ?? 0} 成人${patch.children ? ` · ${patch.children} 儿童` : ""}${
        patch.seniors ? ` · ${patch.seniors} 老人` : ""
      }`,
    );
  }
  if (patch.styles?.length) {
    parts.push(patch.styles.map((id) => STYLE_LABELS[id]).join("、"));
  }
  if (patch.experiences?.length) {
    parts.push(
      patch.experiences
        .map(
          (id) =>
            EXPERIENCE_OPTIONS.find((option) => option.id === id)?.label ?? id,
        )
        .join("、"),
    );
  }
  if (patch.avoidSteep) parts.push("避开爬山");
  if (patch.pace) parts.push(`节奏：${PACES[patch.pace].label}`);
  if (patch.transport) {
    parts.push(
      TRANSPORT_OPTIONS.find((option) => option.id === patch.transport)?.label ??
        patch.transport,
    );
  }
  if (patch.budgetTier) {
    parts.push(BUDGET_TIERS[patch.budgetTier].label);
  }
  if (patch.hotelUndecided) parts.push("住处还没定");
  if (patch.selectedPlaces?.length) {
    parts.push(patch.selectedPlaces.map((place) => place.name).join("、"));
  }
  return parts.filter(Boolean).join(" · ") || "好";
}

function cardIsSettled(kind: ChatCardKind, draft: ChatDraft): boolean {
  switch (kind) {
    case "city":
      return draft.confirmed.city;
    case "date":
      return draft.confirmed.date;
    case "party":
      return draft.confirmed.party;
    case "style":
      return draft.confirmed.style;
    case "pace":
      return draft.confirmed.pace;
    case "transport":
      return draft.confirmed.transport;
    case "hotel":
      return draft.confirmed.hotel;
    default:
      return false;
  }
}

function stepPrompt(draft: ChatDraft): { text: string; cards: ChatCard[] } {
  const step = wizardStep(draft);
  const card = cardForStep(step, nextId("card"));
  if (step === "city") {
    return {
      text: "先定城市。点一个常去的，或者直接输入城市名。",
      cards: [card],
    };
  }
  if (step === "date") {
    return {
      text: `好，去${draft.city.name}。哪天出发、玩几天？`,
      cards: [card],
    };
  }
  if (step === "party") {
    return { text: "时间记下了。几个人一起？", cards: [card] };
  }
  if (step === "style") {
    return { text: "同行人数记下了。这趟想怎么玩？", cards: [card] };
  }
  if (step === "pace") {
    return { text: "玩法记下了。每天想走多少？", cards: [card] };
  }
  if (step === "transport") {
    return {
      text: "节奏记下了。更愿意怎么出行？",
      cards: [card],
    };
  }
  if (step === "hotel") {
    return {
      text: "出行方式记下了。酒店定了就搜名字；还没定也没关系，我会按景点分布推荐落脚片区。",
      cards: [card],
    };
  }
  return { text: "信息齐了，确认后我就开始安排。", cards: [card] };
}

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "我是漫城的行程搭档。先定城市，再定时间、人数、玩法、节奏和住处，最后我把路线排到地图上。也可以直接告诉我：泉州，三天，两个人，想住老城。",
    cards: [cardForStep("city", "welcome-city")],
  },
];

export default function ChatApp({ initialDate }: { initialDate: string }) {
  const [draft, setDraft] = useState<ChatDraft>(() => makeDraft(initialDate));
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("wizard");
  const [aiReason, setAiReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planError, setPlanError] = useState<{
    message: string;
    hint?: string;
  } | null>(null);
  const [activeDay, setActiveDay] = useState<number | "all">("all");
  const [focus, setFocus] = useState<{ placeId: string; nonce: number } | null>(
    null,
  );
  const [picking, setPicking] = useState(false);
  const [handbookOpen, setHandbookOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(true);
  const [walkApi, setWalkApi] = useState<WalkApi | null>(null);
  const [walkOpen, setWalkOpen] = useState(false);
  const [walkDay, setWalkDay] = useState(1);

  const draftRef = useRef(draft);
  const messagesRef = useRef<ChatMessage[]>(messages);
  const chatAbortRef = useRef<AbortController | null>(null);
  const chatSeqRef = useRef(0);
  const planAbortRef = useRef<AbortController | null>(null);
  const planSeqRef = useRef(0);
  const seedRef = useRef(42);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/chat", { signal: controller.signal })
      .then(async (response) => {
        const data = (await response.json()) as {
          configured?: boolean;
          reason?: string;
        };
        if (data.configured) {
          setMode("ai");
        } else {
          setAiReason(data.reason ?? "模型未配置");
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  useEffect(
    () => () => {
      chatAbortRef.current?.abort();
      planAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!handbookOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHandbookOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handbookOpen]);

  function setMessagesBoth(next: ChatMessage[]) {
    messagesRef.current = next;
    setMessages(next);
  }

  function appendUser(text: string): ChatMessage {
    const message: ChatMessage = { id: nextId("u"), role: "user", text };
    setMessagesBoth([...messagesRef.current.map(stripCards), message]);
    return message;
  }

  function appendAssistant(text: string, cards?: ChatCard[]): void {
    const message: ChatMessage = {
      id: nextId("a"),
      role: "assistant",
      text,
      cards,
    };
    setMessagesBoth([...messagesRef.current.map(stripCards), message]);
  }

  function commitDraft(next: ChatDraft, previous: ChatDraft) {
    if (next.city.name !== previous.city.name) {
      setPlan(null);
      setHandbookOpen(false);
      setWalkOpen(false);
      setActiveDay("all");
      setFocus(null);
    }
    draftRef.current = next;
    setDraft(next);
  }

  function continueWizard(next: ChatDraft) {
    const prompt = stepPrompt(next);
    appendAssistant(prompt.text, prompt.cards);
  }

  async function askAi(next: ChatDraft, history: ChatMessage[]) {
    const controller = new AbortController();
    chatAbortRef.current?.abort();
    chatAbortRef.current = controller;
    const seq = ++chatSeqRef.current;
    setBusy(true);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          draft: next,
          messages: history.slice(-16).map((message) => ({
            role: message.role,
            text: message.text,
          })),
        }),
        signal: controller.signal,
      });
      const data = (await response.json()) as ChatApiResponse;
      if (seq !== chatSeqRef.current) return;
      if (!response.ok || !data.ai || !data.reply) {
        setMode("wizard");
        const reason = data.reason ?? "模型没有接通";
        setAiReason(reason);
        const prompt = stepPrompt(next);
        appendAssistant(
          `模型暂时没接通（${reason}），先切到向导模式，不影响安排。\n把可用的模型 Key 填进 .env.local 后重启服务，就能切回对话。`,
          prompt.cards,
        );
        return;
      }

      let resolved = next;
      if (data.reply.patch) {
        const previous = resolved;
        resolved = applyResolvedPatch(resolved, data.reply.patch);
        commitDraft(resolved, previous);
      }
      // 模型偶尔会重复追问已经确认的维度；卡片以草稿状态为准，
      // 并补上真正还缺的那一步，避免对话原地打转。
      const cards = (data.reply.cards ?? []).filter(
        (card) => card.kind === "confirm" || !cardIsSettled(card.kind, resolved),
      );
      appendAssistant(data.reply.say, cards.length ? cards : undefined);
      if (data.reply.action === "plan") {
        void runPlan(resolved);
      } else if (!cards.length) {
        const step = wizardStep(resolved);
        if (step === "confirm") {
          appendAssistant(
            "信息齐了。有必去或不想去的地方吗？没有就直接开始安排。",
            [cardForStep("confirm", nextId("card"))],
          );
        } else {
          const prompt = stepPrompt(resolved);
          appendAssistant(prompt.text, prompt.cards);
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (seq !== chatSeqRef.current) return;
      setMode("wizard");
      const prompt = stepPrompt(next);
      appendAssistant(
        "模型网络没有接通，先切到向导模式，不影响安排。",
        prompt.cards,
      );
    } finally {
      if (seq === chatSeqRef.current) setBusy(false);
    }
  }

  function applyPatchFromCard(patch: ResolvedPatch) {
    const previous = draftRef.current;
    const next = applyResolvedPatch(previous, patch);
    commitDraft(next, previous);
    const label = labelForPatch(patch);
    appendUser(label);
    if (mode === "ai") {
      void askAi(next, messagesRef.current);
    } else {
      continueWizard(next);
    }
  }

  async function runPlan(source: ChatDraft, options: { seed?: number } = {}) {
    // 模型偶尔会在城市/日期/人数没确认时直接 action:"plan"，
    // 这里兜底回到向导追问，避免拿默认值排出一条假行程。
    const missing: string[] = [];
    if (!source.confirmed.city) missing.push("城市");
    if (!source.confirmed.date) missing.push("出发日期");
    if (
      !source.confirmed.party ||
      source.adults + source.children + source.seniors < 1
    ) {
      missing.push("同行人数");
    }
    if (missing.length) {
      const prompt = stepPrompt(source);
      appendAssistant(`${missing.join("、")}还没确认，补齐后我再安排。`, prompt.cards);
      return;
    }
    planAbortRef.current?.abort();
    const controller = new AbortController();
    planAbortRef.current = controller;
    const seq = ++planSeqRef.current;
    setPlanning(true);
    setPlanError(null);
    setWalkOpen(false);
    try {
      const response = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildTripInput(source, options.seed ?? seedRef.current)),
        signal: controller.signal,
      });
      const data = (await response.json()) as PlanResponse;
      if (seq !== planSeqRef.current) return;
      if (!response.ok || !data.plan) {
        const message = data.error ?? "生成失败，请稍后再试。";
        setPlanError({ message, hint: data.hint });
        appendAssistant(
          `安排没有成功：${message}${data.hint ? `（${data.hint}）` : ""}`,
          [cardForStep("confirm", nextId("card"))],
        );
        return;
      }
      const nextPlan = data.plan;
      setPlan(nextPlan);
      setActiveDay("all");
      setFocus(null);
      appendAssistant(
        `路线排好了：${nextPlan.meta.title} · ${nextPlan.meta.subtitle}。地图已按天着色，打开「行程手册」可以看图文攻略和预算。`,
      );
      if (typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches) {
        setHandbookOpen(true);
      } else {
        setSheetOpen(false);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (seq !== planSeqRef.current) return;
      setPlanError({ message: "网络好像断了，没能拿到行程。" });
      appendAssistant(
        "网络好像断了，没能拿到行程。检查服务是否还在运行后再试一次。",
        [cardForStep("confirm", nextId("card"))],
      );
    } finally {
      if (seq === planSeqRef.current) setPlanning(false);
    }
  }

  function startPlan() {
    if (planning) return;
    appendUser("开始安排");
    void runPlan(draftRef.current);
  }

  function shuffle() {
    if (planning) return;
    seedRef.current += 1;
    appendUser("换一版");
    void runPlan(draftRef.current, { seed: seedRef.current });
  }

  function openWalk() {
    if (!plan) return;
    const preferred =
      activeDay !== "all" &&
      plan.days.some((day) => day.index === activeDay && day.stops.length)
        ? activeDay
        : plan.days.find((day) => day.stops.length)?.index;
    if (!preferred) return;
    setWalkDay(preferred);
    setActiveDay(preferred);
    setWalkOpen(true);
    setHandbookOpen(false);
    setSheetOpen(false);
    appendAssistant(
      `开始 Day ${preferred} 的导览。跟着阿漫走，到每一站我会讲怎么玩；地图上也能直接点站点。`,
    );
  }

  function closeWalk() {
    setWalkOpen(false);
    walkApi?.setWalker(null);
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 1023px)").matches
    ) {
      setSheetOpen(true);
    }
  }

  function submitText(raw: string) {
    const text = raw.trim();
    if (!text || busy || planning) return;
    setInput("");
    appendUser(text);
    if (mode === "ai") {
      void askAi(draftRef.current, messagesRef.current);
      return;
    }
    if (!draftRef.current.confirmed.city) {
      const city = QUICK_CITIES.find((option) => text.includes(option.name));
      if (city) {
        const previous = draftRef.current;
        const next = applyResolvedPatch(previous, { city });
        commitDraft(next, previous);
        continueWizard(next);
        return;
      }
    }
    appendAssistant(
      "我先用卡片把关键信息收齐，这样不会漏。选一下下面的选项就行。",
      [cardForStep(wizardStep(draftRef.current), nextId("card"))],
    );
  }

  function sendText() {
    submitText(input);
  }

  async function handlePick(lng: number, lat: number) {
    setPicking(false);
    let hotel = pickedHotel(lng, lat);
    try {
      const response = await fetch(
        `/api/reverse?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`,
      );
      const data = (await response.json()) as { place?: Place | null };
      if (data.place) hotel = { ...data.place, category: "hotel" };
    } catch {
      // 识别不了地名就用坐标，不影响安排。
    }
    const previous = draftRef.current;
    const next = applyResolvedPatch(previous, { hotel });
    commitDraft(next, previous);
    appendUser(`住处：${hotel.name}`);
    if (mode === "ai") {
      void askAi(next, messagesRef.current);
    } else {
      continueWizard(next);
    }
  }

  function handleStopClick(day: number, placeId: string) {
    setActiveDay(day);
    setFocus({ placeId, nonce: Date.now() });
    setHandbookOpen(true);
  }

  const lastMessageIndex = messages.length - 1;
  const mainBase = plan?.lodging?.bases.find((base) => base.role === "main");
  const stayName =
    mainBase?.name ?? (draft.hotelUndecided ? "落脚片区" : draft.hotel.name);
  const mapHotel = useMemo<Place>(() => {
    if (mainBase) {
      return {
        id: mainBase.id,
        name: mainBase.name,
        category: "hotel",
        lat: mainBase.lat,
        lng: mainBase.lng,
        address: mainBase.reason,
        note: mainBase.reason,
        source: "demo",
      };
    }
    if (draft.hotelUndecided) {
      return {
        ...draft.hotel,
        id: `pending-${draft.city.name}`,
        name: "落脚待定",
        note: "住处还没定；生成行程后会按景点分布推荐落脚片区。",
      };
    }
    return draft.hotel;
  }, [mainBase, draft.hotel, draft.hotelUndecided, draft.city.name]);

  return (
    <main className="relative h-[100dvh] w-full overflow-hidden bg-paper">
      <div className="absolute inset-0 lg:left-[432px]">
        <MapView
          key={draft.city.name}
          hotel={mapHotel}
          plan={plan}
          activeDay={activeDay}
          focus={focus}
          mode="plan"
          catalog={null}
          catalogLoading={false}
          selectedIds={[]}
          picking={picking}
          loading={planning}
          onPick={handlePick}
          onExitPick={() => setPicking(false)}
          onStopClick={handleStopClick}
          onToggleCatalog={() => undefined}
          onWalkApi={setWalkApi}
        />
        {plan && !walkOpen ? (
          <button
            type="button"
            onClick={openWalk}
            className="absolute bottom-[100px] right-3 z-20 inline-flex items-center gap-1.5 rounded-full border border-line/70 bg-card/94 px-3.5 py-2 text-[11.5px] text-ink-soft shadow-lift backdrop-blur transition hover:border-ink/25 hover:text-ink lg:bottom-5 lg:right-5"
          >
            <Icon name="footprints" size={13} className="text-accent" />
            导览小人
          </button>
        ) : null}
      </div>

      <div className="pointer-events-none absolute left-4 top-4 z-20 lg:hidden">
        <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-line/70 bg-card/92 px-3.5 py-2 shadow-lift backdrop-blur">
          <span className="font-serif text-[15px] tracking-wide text-ink">漫城</span>
          <span className="text-[10.5px] text-ink-faint">对话定制</span>
          <a
            href="/"
            className="ml-1 rounded-full border border-line px-2.5 py-1 text-[10.5px] text-ink-soft transition hover:border-ink/25 hover:text-ink"
          >
            经典版
          </a>
        </div>
      </div>

      <section
        className={cn(
          "absolute inset-x-0 bottom-0 z-30 flex flex-col overflow-hidden rounded-t-[26px] border border-line/70 bg-card/94 shadow-lift backdrop-blur-md transition-[height] duration-300",
          sheetOpen ? "h-[62dvh]" : "h-[88px]",
          "lg:inset-y-4 lg:left-4 lg:right-auto lg:h-auto lg:w-[408px] lg:rounded-[26px]",
        )}
      >
        <div className="flex items-center gap-2 border-b border-line/60 px-4 py-3">
          <button
            type="button"
            onClick={() => setSheetOpen((open) => !open)}
            className="flex h-6 w-6 items-center justify-center rounded-full border border-line text-ink-faint lg:hidden"
            aria-label={sheetOpen ? "收起对话框" : "展开对话框"}
          >
            <Icon
              name="chevron-down"
              size={13}
              className={cn("transition-transform", sheetOpen && "rotate-180")}
            />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-serif text-[16px] tracking-wide text-ink">
                漫城
              </span>
              <span className="rounded-full bg-jade-soft px-1.5 py-0.5 text-[9.5px] text-jade">
                {mode === "ai" ? "对话模式" : "向导模式"}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[10.5px] text-ink-faint">
              {draft.confirmed.city
                ? `${draft.city.name} · ${draft.days} 天 · ${draft.adults + draft.children + draft.seniors} 人`
                : "先定城市，再定时间与玩法"}
            </p>
            {mode === "wizard" && aiReason ? (
              <p className="mt-0.5 truncate text-[9.5px] text-amber" title={aiReason}>
                {aiReason} · 先用向导收信息
              </p>
            ) : null}
          </div>
          {plan ? (
            <button
              type="button"
              onClick={() => setHandbookOpen(true)}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-card px-3 py-1.5 text-[11px] text-ink-soft transition hover:border-ink/25 hover:text-ink"
            >
              <Icon name="book-open" size={12} />
              行程手册
            </button>
          ) : null}
          <a
            href="/"
            className="hidden shrink-0 rounded-full border border-line px-2.5 py-1.5 text-[10.5px] text-ink-faint transition hover:border-ink/25 hover:text-ink lg:inline-flex"
          >
            经典版
          </a>
        </div>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3.5 py-3.5">
          {messages.map((message, index) => (
            <div
              key={message.id}
              className={cn(
                "flex",
                message.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[92%]",
                  message.role === "user"
                    ? "rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[12.5px] leading-relaxed text-paper"
                    : "w-full",
                )}
              >
                {message.role === "assistant" ? (
                  <div className="rounded-2xl rounded-bl-md border border-line/60 bg-paper/70 px-3.5 py-2.5">
                    <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-ink-soft">
                      {message.text}
                    </p>
                    {message.cards?.length ? (
                      <div>
                        {message.cards.map((card) => (
                          <ChatCardView
                            key={card.id}
                            card={card}
                            draft={draft}
                            disabled={busy || planning || index !== lastMessageIndex}
                            planning={planning}
                            onApply={applyPatchFromCard}
                            onPickMap={() => {
                              setPicking(true);
                              setSheetOpen(false);
                            }}
                            onPlan={startPlan}
                            onSay={mode === "ai" ? submitText : undefined}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  message.text
                )}
              </div>
            </div>
          ))}
          {busy ? (
            <div className="flex items-center gap-2 px-1 text-[11px] text-ink-faint">
              <span className="h-1.5 w-1.5 animate-soft-pulse rounded-full bg-jade" />
              正在想下一步…
            </div>
          ) : null}
          {planning ? (
            <div className="flex items-center gap-2 px-1 text-[11px] text-ink-faint">
              <span className="h-1.5 w-1.5 animate-soft-pulse rounded-full bg-amber" />
              正在安排，第一次会多等一会儿…
            </div>
          ) : null}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            sendText();
          }}
          className="border-t border-line/60 px-3 py-2.5"
        >
          <div className="flex items-end gap-2">
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              disabled={busy || planning}
              placeholder={
                mode === "ai"
                  ? "直接说：泉州三天，带娃，想住老城"
                  : "输入城市名，或点上面的卡片"
              }
              className="min-w-0 flex-1 rounded-full border border-line bg-card px-3.5 py-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-faint/70 focus:border-jade/50 disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={busy || planning || !input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-paper transition hover:bg-ink/90 disabled:opacity-35"
              aria-label="发送"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 19V5" />
                <path d="m5 12 7-7 7 7" />
              </svg>
            </button>
          </div>
        </form>
      </section>

      {walkOpen && plan ? (
        <Walkthrough
          plan={plan}
          dayIndex={walkDay}
          hotelName={stayName}
          api={walkApi}
          onDayChange={(day) => {
            setWalkDay(day);
            setActiveDay(day);
          }}
          onClose={closeWalk}
          onFocusStop={(placeId) => {
            setFocus({ placeId, nonce: Date.now() });
            setHandbookOpen(true);
          }}
          onFinish={() => {
            appendAssistant(
              `Day ${walkDay} 的导览走完了。想再走一遍，或者去手册里核对预算和贴士都行。`,
            );
          }}
        />
      ) : null}

      {handbookOpen && plan ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <button
            type="button"
            aria-label="关闭行程手册"
            onClick={() => setHandbookOpen(false)}
            className="absolute inset-0 bg-ink/30 backdrop-blur-sm"
          />
          <aside className="relative h-full w-full max-w-[540px] overflow-y-auto bg-paper/95 p-3 shadow-lift sm:p-4">
            <div className="mb-2 flex items-center justify-between px-1">
              <p className="font-serif text-[16px] tracking-wide text-ink">
                行程手册
              </p>
              <button
                type="button"
                onClick={() => setHandbookOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-line bg-card text-ink-faint transition hover:text-ink"
                aria-label="关闭"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
            <PlanPanel
              plan={plan}
              loading={planning}
              error={planError}
              activeDay={activeDay}
              focus={focus}
              hotelName={stayName}
              onActiveDay={setActiveDay}
              onFocusStop={(day, placeId) => {
                setActiveDay(day);
                setFocus({ placeId, nonce: Date.now() });
              }}
              onShuffle={shuffle}
              onGenerate={() => void runPlan(draftRef.current)}
            />
          </aside>
        </div>
      ) : null}
    </main>
  );
}