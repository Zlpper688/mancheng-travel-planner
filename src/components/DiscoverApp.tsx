"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ChevronLeft,
  Compass,
  Heart,
  Image as ImageIcon,
  MapPin,
  Play,
  RefreshCw,
  Sparkles,
  Video,
  X,
} from "lucide-react";

type Destination = {
  id: string;
  name: string;
  city: string;
  type: "photo" | "video";
  category: string;
  caption: string;
  gradient: string;
  motif: string;
};

const DESTINATIONS: Destination[] = [
  {
    id: "gulangyu",
    name: "鼓浪屿",
    city: "厦门",
    type: "photo",
    category: "海岛漫游",
    caption: "在没有汽车的岛上，沿着老街慢慢走。",
    gradient: "linear-gradient(145deg, #f3c59a 0%, #d57f5d 42%, #385c60 100%)",
    motif: "海风与红砖",
  },
  {
    id: "west-lake",
    name: "西湖",
    city: "杭州",
    type: "video",
    category: "湖畔风光",
    caption: "清晨的湖面很安静，适合把脚步放慢。",
    gradient: "linear-gradient(145deg, #b9d8c8 0%, #719d91 44%, #304e4d 100%)",
    motif: "一湖山色",
  },
  {
    id: "forbidden-city",
    name: "故宫",
    city: "北京",
    type: "photo",
    category: "历史建筑",
    caption: "红墙金瓦之间，收藏着一座城的旧时光。",
    gradient: "linear-gradient(145deg, #e8b66d 0%, #b74a32 48%, #542d31 100%)",
    motif: "红墙与飞檐",
  },
  {
    id: "zhangjiajie",
    name: "张家界国家森林公园",
    city: "张家界",
    type: "video",
    category: "山岳自然",
    caption: "云雾绕过峰林，像走进一幅水墨画。",
    gradient: "linear-gradient(145deg, #d6d7bd 0%, #759082 45%, #263e40 100%)",
    motif: "云海峰林",
  },
  {
    id: "xihuangshan",
    name: "黄山",
    city: "黄山",
    type: "photo",
    category: "山岳自然",
    caption: "等一场云海，也等太阳慢慢越过山脊。",
    gradient: "linear-gradient(145deg, #f4d59c 0%, #bc9a73 45%, #43565a 100%)",
    motif: "日出云海",
  },
  {
    id: "dujiangyan",
    name: "都江堰",
    city: "成都",
    type: "video",
    category: "人文古迹",
    caption: "两千多年前的水利智慧，至今仍在奔流。",
    gradient: "linear-gradient(145deg, #b7d8cb 0%, #4f9a8d 45%, #214853 100%)",
    motif: "古堰流水",
  },
  {
    id: "hongcun",
    name: "宏村",
    city: "黄山",
    type: "photo",
    category: "古村街巷",
    caption: "白墙黛瓦映在南湖里，像一页翻开的旧画册。",
    gradient: "linear-gradient(145deg, #e5d5b9 0%, #9da99a 46%, #4a6260 100%)",
    motif: "水墨徽州",
  },
  {
    id: "lijiang",
    name: "丽江古城",
    city: "丽江",
    type: "video",
    category: "古城漫步",
    caption: "沿着水渠穿过小巷，抬头就是远处的雪山。",
    gradient: "linear-gradient(145deg, #e9c69c 0%, #ad7656 48%, #394e52 100%)",
    motif: "雪山下的街巷",
  },
  {
    id: "qilian",
    name: "青海湖",
    city: "青海",
    type: "photo",
    category: "湖泊草原",
    caption: "湖水和天空连成一线，风里有很远的自由。",
    gradient: "linear-gradient(145deg, #b9d8dc 0%, #4d9eae 46%, #254e64 100%)",
    motif: "湖天一色",
  },
  {
    id: "wuzhen",
    name: "乌镇",
    city: "嘉兴",
    type: "video",
    category: "水乡古镇",
    caption: "摇橹声经过石桥，水巷亮起温柔的灯火。",
    gradient: "linear-gradient(145deg, #d9c6a8 0%, #67877e 44%, #263c43 100%)",
    motif: "水巷灯影",
  },
  {
    id: "sanya",
    name: "蜈支洲岛",
    city: "三亚",
    type: "photo",
    category: "海岛海岸",
    caption: "把一天交给海水、阳光和一段没有安排的时间。",
    gradient: "linear-gradient(145deg, #f2d394 0%, #4fb6ae 48%, #236279 100%)",
    motif: "蓝色海岸",
  },
  {
    id: "longji",
    name: "龙脊梯田",
    city: "桂林",
    type: "video",
    category: "田园风光",
    caption: "层层梯田顺着山势铺开，季节在田埂间流动。",
    gradient: "linear-gradient(145deg, #dbbb84 0%, #8a9b70 46%, #3b574e 100%)",
    motif: "山间田野",
  },
  {
    id: "potala",
    name: "布达拉宫",
    city: "拉萨",
    type: "photo",
    category: "历史建筑",
    caption: "在高原的阳光下，感受一座宫殿的庄严与宁静。",
    gradient: "linear-gradient(145deg, #e7c395 0%, #bd7554 46%, #503b45 100%)",
    motif: "高原日光",
  },
  {
    id: "pudacuo",
    name: "普达措国家公园",
    city: "香格里拉",
    type: "video",
    category: "森林湖泊",
    caption: "沿着木栈道走进森林，让湖水和松林替你留白。",
    gradient: "linear-gradient(145deg, #c8d6b5 0%, #718e79 44%, #2d4b4c 100%)",
    motif: "林间湖泊",
  },
];

type PoolKind = "like" | "dislike";

function shuffledDestinations(excludeId?: string): Destination[] {
  const shuffled = [...DESTINATIONS];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  if (excludeId && shuffled[0]?.id === excludeId) {
    [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  }
  return shuffled;
}

export default function DiscoverApp() {
  const [deck, setDeck] = useState<Destination[]>(DESTINATIONS);
  const [history, setHistory] = useState<Destination[]>([]);
  const [liked, setLiked] = useState<Destination[]>([]);
  const [disliked, setDisliked] = useState<Destination[]>([]);
  const [stamp, setStamp] = useState<{
    direction: PoolKind;
    phase: "desk" | "extending" | "pressed" | "exit";
  } | null>(null);
  const [poolOpen, setPoolOpen] = useState<PoolKind | null>(null);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [entryDirection, setEntryDirection] = useState<"up" | "down" | "fade">(
    "fade",
  );
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const choosingRef = useRef(false);
  const choiceTimersRef = useRef<number[]>([]);
  const stampAudioRef = useRef<HTMLAudioElement>(null);

  const current = deck[0];

  useEffect(() => {
    setDeck(shuffledDestinations());
  }, []);

  const refreshDeck = useCallback(() => {
    setRefreshing(true);
    setEntryDirection("fade");
    setDeck((items) => shuffledDestinations(items[0]?.id));
    window.setTimeout(() => setRefreshing(false), 350);
  }, []);

  const moveNext = useCallback(
    (direction: "up" | "fade" = "fade") => {
      if (!current) return;
      setEntryDirection(direction);
      setHistory((items) => [...items, current]);
      setDeck((items) =>
        items.length > 1 ? items.slice(1) : shuffledDestinations(current.id),
      );
      setDrag({ x: 0, y: 0 });
    },
    [current],
  );

  const moveBackOrRefresh = useCallback(() => {
    if (!history.length) {
      refreshDeck();
      setEntryDirection("down");
      return;
    }
    const previous = history[history.length - 1];
    setEntryDirection("down");
    setHistory((items) => items.slice(0, -1));
    setDeck((items) => [previous, ...items]);
    setDrag({ x: 0, y: 0 });
  }, [history, refreshDeck]);

  const playStampSound = useCallback(() => {
    const audio = stampAudioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    void audio.play().catch((error: unknown) => {
      console.warn("[discover] Could not play stamp sound", error);
    });
  }, []);

  const choose = useCallback(
    (direction: PoolKind) => {
      if (!current || choosingRef.current) return;
      choosingRef.current = true;
      if (direction === "like") {
        setLiked((items) =>
          items.some((item) => item.id === current.id)
            ? items
            : [...items, current],
        );
        setDisliked((items) => items.filter((item) => item.id !== current.id));
      } else {
        setDisliked((items) =>
          items.some((item) => item.id === current.id)
            ? items
            : [...items, current],
        );
        setLiked((items) => items.filter((item) => item.id !== current.id));
      }
      setStamp({ direction, phase: "desk" });
      choiceTimersRef.current = [
        window.setTimeout(
          () => setStamp({ direction, phase: "extending" }),
          20,
        ),
        window.setTimeout(
          () => {
            setStamp({ direction, phase: "pressed" });
            playStampSound();
          },
          320,
        ),
        window.setTimeout(
          () => setStamp({ direction, phase: "exit" }),
          820,
        ),
        window.setTimeout(() => {
          moveNext("up");
          setStamp(null);
          choosingRef.current = false;
          choiceTimersRef.current = [];
        }, 1100),
      ];
    },
    [current, moveNext, playStampSound],
  );

  function onPointerDown(event: PointerEvent<HTMLElement>) {
    if (choosingRef.current) return;
    pointerStart.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLElement>) {
    if (!pointerStart.current) return;
    setDrag({
      x: event.clientX - pointerStart.current.x,
      y: event.clientY - pointerStart.current.y,
    });
  }

  function onPointerUp(event: PointerEvent<HTMLElement>) {
    if (!pointerStart.current) return;
    const x = event.clientX - pointerStart.current.x;
    const y = event.clientY - pointerStart.current.y;
    pointerStart.current = null;
    setDrag({ x: 0, y: 0 });
    if (y > 90 && Math.abs(y) > Math.abs(x)) {
      moveBackOrRefresh();
    } else if (y < -90 && Math.abs(y) > Math.abs(x)) {
      moveNext("up");
    } else if (Math.abs(x) > 90 && Math.abs(x) > Math.abs(y)) {
      choose(x > 0 ? "like" : "dislike");
    }
  }

  function onPointerCancel() {
    pointerStart.current = null;
    setDrag({ x: 0, y: 0 });
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (poolOpen) {
        if (event.key === "Escape") setPoolOpen(null);
        return;
      }
      if (choosingRef.current) return;
      if (event.key === "ArrowUp") moveNext("up");
      if (event.key === "ArrowDown") moveBackOrRefresh();
      if (event.key === "ArrowLeft") choose("dislike");
      if (event.key === "ArrowRight") choose("like");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [choose, moveBackOrRefresh, moveNext, poolOpen]);

  useEffect(
    () => () => {
      choiceTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    },
    [],
  );

  const openedPool = poolOpen === "like" ? liked : disliked;

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#111713] text-white">
      <audio
        ref={stampAudioRef}
        aria-hidden="true"
        className="hidden"
        preload="auto"
        src="/audio/stamp.wav"
      />
      {current ? (
        <article
          key={current.id}
          aria-label={`${current.city} ${current.name}`}
          className={`absolute inset-0 touch-none select-none overflow-hidden transition-transform duration-200 ease-out ${
            stamp?.phase === "exit"
              ? "discover-stamped-exit"
              : entryDirection === "up"
                ? "discover-enter-up"
                : entryDirection === "down"
                  ? "discover-enter-down"
                  : ""
          }`}
          style={{
            transform: `translate3d(${drag.x}px, ${drag.y}px, 0) rotate(${drag.x * 0.025}deg)`,
            background: current.gradient,
            transition: pointerStart.current ? "none" : undefined,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
        >
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -right-16 top-[18%] h-[44vh] w-[44vh] rounded-full border border-white/15 bg-white/10 blur-[1px]" />
            <div className="absolute -left-[20%] top-[30%] h-[55vh] w-[55vh] rounded-full border border-white/15 bg-black/5" />
            <div className="absolute -bottom-[14%] left-1/2 h-[48vh] w-[130vw] -translate-x-1/2 rotate-[-8deg] rounded-[50%] border-t border-white/20 bg-black/10 blur-[1px]" />
            <div className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/5 to-black/75" />
            <div className="absolute inset-y-0 right-0 w-28 bg-gradient-to-l from-black/25 to-transparent" />
          </div>

          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-4 pb-4 pt-[calc(env(safe-area-inset-top)+14px)] sm:px-7">
            <Link
              href="/"
              onPointerDown={(event) => event.stopPropagation()}
              className="flex h-10 items-center gap-1.5 rounded-full bg-black/20 px-3 text-xs text-white/95 backdrop-blur-md transition hover:bg-black/35"
            >
              <ChevronLeft size={17} />
              <span>漫城</span>
            </Link>
            <div className="absolute left-1/2 flex -translate-x-1/2 flex-col items-center">
              <span className="font-serif text-[17px] tracking-[0.14em]">为你推荐</span>
              <span className="mt-1 h-0.5 w-5 rounded-full bg-white/90" />
            </div>
            <button
              type="button"
              aria-label="刷新景点"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={refreshDeck}
              className="flex h-10 items-center gap-2 rounded-full bg-black/20 px-3.5 text-xs text-white/95 backdrop-blur-md transition hover:bg-black/35"
            >
              <RefreshCw size={15} className={refreshing ? "animate-spin" : ""} />
              <span>换一批</span>
            </button>
          </div>

          <div className="absolute left-4 top-[calc(env(safe-area-inset-top)+76px)] z-10 flex flex-wrap items-center gap-2 sm:left-7">
            <span className="rounded-full border border-white/20 bg-black/20 px-3 py-1.5 text-[11px] tracking-wide text-white/95 backdrop-blur-md">
              {current.category}
            </span>
            <span className="flex items-center gap-1.5 rounded-full border border-white/20 bg-black/20 px-3 py-1.5 text-[10px] text-white/85 backdrop-blur-md">
              {current.type === "video" ? <Video size={12} /> : <ImageIcon size={12} />}
              {current.type === "video" ? "视频占位" : "图片占位"}
            </span>
          </div>

          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-white">
            <div className="mb-4 grid h-[76px] w-[76px] place-items-center rounded-full border border-white/30 bg-white/10 backdrop-blur-sm sm:h-[88px] sm:w-[88px]">
              {current.type === "video" ? (
                <Play size={28} fill="currentColor" className="ml-1" />
              ) : (
                <ImageIcon size={29} strokeWidth={1.35} />
              )}
            </div>
            <span className="text-[11px] tracking-[0.28em] text-white/80">
              {current.motif}
            </span>
            <span className="mt-2 text-[9px] tracking-[0.18em] text-white/55">
              MEDIA PLACEHOLDER
            </span>
          </div>

          <aside className="absolute bottom-[calc(env(safe-area-inset-bottom)+190px)] right-3 z-20 flex flex-col items-center gap-4 sm:right-6 sm:gap-5">
            <button
              type="button"
              aria-label="加入 Like"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => choose("like")}
              disabled={stamp !== null}
              className="flex w-[54px] flex-col items-center gap-1 text-white drop-shadow-lg"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/20 backdrop-blur-md transition hover:scale-105 hover:bg-black/35">
                <Heart size={23} strokeWidth={2} />
              </span>
              <span className="text-[10px] font-medium">Like</span>
              <span className="text-[10px] text-white/75">{liked.length}</span>
            </button>
            <button
              type="button"
              aria-label="加入 Dislike"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => choose("dislike")}
              disabled={stamp !== null}
              className="flex w-[54px] flex-col items-center gap-1 text-white drop-shadow-lg"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/20 backdrop-blur-md transition hover:scale-105 hover:bg-black/35">
                <X size={24} strokeWidth={2} />
              </span>
              <span className="text-[10px] font-medium">Dislike</span>
              <span className="text-[10px] text-white/75">{disliked.length}</span>
            </button>
            <button
              type="button"
              aria-label="查看 Like 收藏"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setPoolOpen("like")}
              className="flex w-[54px] flex-col items-center gap-1 text-white drop-shadow-lg"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/20 backdrop-blur-md transition hover:scale-105 hover:bg-black/35">
                <Heart size={19} />
              </span>
              <span className="text-[10px]">收藏夹</span>
            </button>
            <button
              type="button"
              aria-label="查看 Dislike 清单"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setPoolOpen("dislike")}
              className="flex w-[54px] flex-col items-center gap-1 text-white drop-shadow-lg"
            >
              <span className="grid h-11 w-11 place-items-center rounded-full border border-white/20 bg-black/20 backdrop-blur-md transition hover:scale-105 hover:bg-black/35">
                <Compass size={19} />
              </span>
              <span className="text-[10px]">跳过清单</span>
            </button>
          </aside>

          <div className="absolute bottom-0 left-0 right-[76px] z-10 px-5 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-28 text-white sm:left-4 sm:right-24 sm:px-6 sm:pb-8">
            <p className="mb-2 flex items-center gap-1.5 text-xs text-white/85">
              <MapPin size={14} />
              {current.city}
              <span className="mx-0.5 text-white/50">·</span>
              <Sparkles size={12} />
              <span>{current.category}</span>
            </p>
            <h1 className="max-w-[min(78vw,620px)] font-serif text-[30px] leading-tight tracking-wide drop-shadow sm:text-[38px]">
              {current.name}
            </h1>
            <p className="mt-2 max-w-[min(76vw,580px)] text-[13px] leading-6 text-white/90 drop-shadow sm:text-sm">
              {current.caption}
            </p>
            <p className="mt-3 text-[10px] text-white/60">
              占位素材 · 上滑看下一条，下滑回看历史
            </p>
            <div className="mt-4 flex items-center gap-2 text-[10px] text-white/75">
              <span className="flex items-center gap-1">
                <ArrowLeft size={12} /> 跳过
              </span>
              <span className="text-white/40">·</span>
              <span className="flex items-center gap-1">
                <ArrowUp size={12} /> 下一条
              </span>
              <span className="text-white/40">·</span>
              <span className="flex items-center gap-1">
                <ArrowDown size={12} /> {history.length ? "回看" : "回看/刷新"}
              </span>
              <span className="text-white/40">·</span>
              <span className="flex items-center gap-1">
                喜欢 <ArrowRight size={12} />
              </span>
            </div>
          </div>

          {drag.x > 45 ? (
            <div className="pointer-events-none absolute left-6 top-1/2 z-20 -translate-y-1/2 rotate-[-10deg] rounded-lg border-2 border-white px-4 py-2 text-xl font-black uppercase tracking-widest text-white">
              Like
            </div>
          ) : null}
          {drag.x < -45 ? (
            <div className="pointer-events-none absolute right-6 top-1/2 z-20 -translate-y-1/2 rotate-[10deg] rounded-lg border-2 border-white px-4 py-2 text-xl font-black uppercase tracking-widest text-white">
              Nope
            </div>
          ) : null}
          {drag.y > 55 ? (
            <div className="pointer-events-none absolute left-1/2 top-24 z-20 -translate-x-1/2 rounded-full bg-black/25 px-4 py-2 text-sm font-semibold text-white backdrop-blur">
              {history.length ? "上一条" : "换一批"}
            </div>
          ) : null}
          {drag.y < -55 ? (
            <div className="pointer-events-none absolute left-1/2 top-24 z-20 -translate-x-1/2 rounded-full bg-black/25 px-4 py-2 text-sm font-semibold text-white backdrop-blur">
              下一条
            </div>
          ) : null}
          {stamp ? (
            <div className="pointer-events-auto absolute inset-0 z-30 overflow-hidden">
              <div className="absolute inset-0 bg-black/10" />
              <div
                className={`discover-stamp-desk ${
                  stamp.direction === "like"
                    ? "discover-stamp-from-right"
                    : "discover-stamp-from-left"
                } ${stamp.phase !== "desk" ? "discover-stamp-desk-open" : ""} ${
                  stamp.phase === "pressed" || stamp.phase === "exit"
                    ? "discover-stamp-desk-drop"
                    : ""
                }`}
                aria-hidden="true"
              >
                <div
                  className={`flex h-full w-full items-center p-3 ${
                    stamp.direction === "like" ? "justify-start" : "justify-end"
                  }`}
                >
                  <div className="flex h-full w-full items-center justify-center rounded-xl border-[5px] border-[#48372b] bg-gradient-to-br from-[#ba8050] via-[#8f5b39] to-[#553a2b] p-2 shadow-[inset_0_2px_8px_rgba(255,230,190,0.28),0_18px_38px_rgba(0,0,0,0.4)]">
                    <div className="flex h-full w-full flex-col items-center justify-center rounded-lg border border-[#d6b088]/50 bg-gradient-to-br from-[#6e342e] to-[#3f211f] text-[#f3d9bb] shadow-[inset_0_0_20px_rgba(0,0,0,0.55)]">
                      <span className="whitespace-nowrap text-[8px] tracking-[0.12em] text-[#e2bd98]/75">
                        MANCHENG · {stamp.direction === "like" ? "APPROVED" : "REJECTED"}
                      </span>
                      <span className="mt-2 h-1 w-12 rounded-full bg-[#a96c4b]/70" />
                    </div>
                  </div>
                </div>
              </div>
              {stamp.phase === "pressed" || stamp.phase === "exit" ? (
                <div
                  className={`discover-stamp-impression ${
                    stamp.direction === "like"
                      ? "discover-stamp-impression-right discover-stamp-mark-like"
                      : "discover-stamp-impression-left discover-stamp-mark-dislike"
                  }`}
                  aria-hidden="true"
                >
                  {stamp.direction === "like" ? "LIKE" : "DISLIKE"}
                </div>
              ) : null}
            </div>
          ) : null}
        </article>
      ) : (
        <div className="absolute inset-0 grid place-items-center bg-[#111713] text-sm text-white/70">
          正在准备下一批灵感…
        </div>
      )}

      {poolOpen ? (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/55 p-0 backdrop-blur-[3px] sm:items-center sm:p-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPoolOpen(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="pool-title"
            className="max-h-[78dvh] w-full max-w-md overflow-hidden rounded-t-[24px] bg-[#fffdf8] text-[#243129] shadow-2xl sm:rounded-[24px]"
          >
            <header className="flex items-center justify-between border-b border-[#243129]/10 px-5 py-4">
              <div>
                <p className="text-[10px] tracking-[0.18em] text-[#899084]">
                  {poolOpen === "like" ? "SAVED INSPIRATION" : "SKIPPED PLACES"}
                </p>
                <h2 id="pool-title" className="mt-1 font-serif text-lg">
                  {poolOpen === "like" ? "Like 收藏" : "Dislike 跳过"}
                </h2>
              </div>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setPoolOpen(null)}
                className="grid h-9 w-9 place-items-center rounded-full bg-[#f1efe8] text-[#697368] hover:bg-[#e8e4d9]"
              >
                <X size={17} />
              </button>
            </header>
            <div className="scroll-thin max-h-[60dvh] overflow-y-auto p-4">
              {openedPool.length ? (
                <ul className="space-y-2">
                  {openedPool.map((place) => (
                    <li
                      key={place.id}
                      className="flex items-center gap-3 rounded-xl border border-[#243129]/8 bg-white p-3"
                    >
                      <span
                        className="grid h-12 w-12 shrink-0 place-items-center rounded-lg text-white"
                        style={{ background: place.gradient }}
                      >
                        {place.type === "video" ? <Video size={17} /> : <ImageIcon size={17} />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{place.name}</span>
                        <span className="mt-1 block text-[11px] text-[#7b847a]">
                          {place.city} · {place.category}
                        </span>
                      </span>
                      {poolOpen === "like" ? (
                        <Check size={17} className="shrink-0 text-[#416b54]" />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-4 py-12 text-center">
                  <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-[#f1efe8] text-[#8b9388]">
                    {poolOpen === "like" ? <Heart size={20} /> : <X size={20} />}
                  </span>
                  <p className="mt-3 text-sm text-[#566257]">
                    {poolOpen === "like" ? "还没有收藏的景点" : "还没有跳过的景点"}
                  </p>
                  <p className="mt-1 text-xs text-[#92988f]">继续滑动，慢慢收集你的旅行灵感。</p>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
