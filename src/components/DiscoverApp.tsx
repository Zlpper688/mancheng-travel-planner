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
  const [liked, setLiked] = useState<Destination[]>([]);
  const [disliked, setDisliked] = useState<Destination[]>([]);
  const [poolOpen, setPoolOpen] = useState<PoolKind | null>(null);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  const current = deck[0];

  useEffect(() => {
    setDeck(shuffledDestinations());
  }, []);

  const refreshDeck = useCallback(() => {
    setRefreshing(true);
    setDeck((items) => shuffledDestinations(items[0]?.id));
    window.setTimeout(() => setRefreshing(false), 350);
  }, []);

  const decide = useCallback(
    (direction: PoolKind) => {
      if (!current) return;
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
      setDeck((items) =>
        items.length > 1 ? items.slice(1) : shuffledDestinations(current.id),
      );
      setDrag({ x: 0, y: 0 });
    },
    [current],
  );

  function onPointerDown(event: PointerEvent<HTMLElement>) {
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
      refreshDeck();
    } else if (Math.abs(x) > 90 && Math.abs(x) > Math.abs(y)) {
      decide(x > 0 ? "like" : "dislike");
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
      if (event.key === "ArrowLeft") decide("dislike");
      if (event.key === "ArrowRight") decide("like");
      if (event.key === "ArrowDown") refreshDeck();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [decide, poolOpen, refreshDeck]);

  const openedPool = poolOpen === "like" ? liked : disliked;

  return (
    <main className="min-h-dvh overflow-hidden bg-[#f7f4ec] text-[#243129]">
      <header className="relative z-10 flex h-[68px] items-center justify-between border-b border-[#243129]/10 px-4 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-2 text-sm font-medium text-[#526055] transition hover:text-[#243129]"
        >
          <ChevronLeft size={18} />
          <span className="hidden sm:inline">回到漫城</span>
          <span className="sm:hidden">返回</span>
        </Link>
        <Link href="/" className="absolute left-1/2 -translate-x-1/2">
          <span className="font-serif text-[19px] tracking-[0.12em]">漫城</span>
          <span className="ml-2 hidden text-[10px] tracking-[0.22em] text-[#798177] sm:inline">
            DISCOVER
          </span>
        </Link>
        <button
          type="button"
          onClick={refreshDeck}
          className="flex items-center gap-2 rounded-full border border-[#243129]/15 bg-white/70 px-3.5 py-2 text-xs font-medium text-[#526055] transition hover:bg-white"
        >
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
          <span>换一批</span>
        </button>
      </header>

      <div className="mx-auto grid min-h-[calc(100dvh-68px)] w-full max-w-[1180px] grid-cols-1 items-center gap-5 px-4 py-5 sm:px-8 lg:grid-cols-[1fr_390px_1fr] lg:gap-12 lg:py-7">
        <section className="hidden lg:block">
          <div className="max-w-[250px]">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#8b7654]">
              <Sparkles size={14} />
              随手发现下一站
            </p>
            <h1 className="mt-4 font-serif text-[34px] leading-[1.35] tracking-wide">
              先凭感觉，
              <br />
              再去看世界。
            </h1>
            <p className="mt-4 text-[14px] leading-7 text-[#6e776d]">
              像刷灵感短片一样认识一座城。喜欢的向右收下，不合眼缘的向左略过。
            </p>
          </div>
          <div className="mt-10 space-y-3 text-xs text-[#778075]">
            <p className="flex items-center gap-2">
              <ArrowLeft size={15} /> 左滑，放入 Dislike
            </p>
            <p className="flex items-center gap-2">
              <ArrowRight size={15} /> 右滑，放入 Like
            </p>
            <p className="flex items-center gap-2">
              <ArrowDown size={15} /> 下滑，刷新经典
            </p>
          </div>
        </section>

        <section className="mx-auto flex w-full max-w-[390px] flex-col items-center">
          <div className="mb-3 flex w-full items-center justify-between px-1 lg:hidden">
            <div>
              <p className="font-serif text-[21px]">下一站，随心发现</p>
              <p className="mt-0.5 text-[11px] text-[#7b847a]">
                滑动卡片，收集旅行灵感
              </p>
            </div>
            <Compass size={21} strokeWidth={1.5} className="text-[#8b7654]" />
          </div>

          {current ? (
            <article
              aria-label={`${current.city} ${current.name}`}
              className="relative h-[min(62dvh,590px)] min-h-[390px] w-full touch-none select-none overflow-hidden rounded-[26px] bg-[#73877b] shadow-[0_24px_70px_-34px_rgba(27,39,31,0.65)] transition-transform duration-200 ease-out sm:h-[min(69dvh,650px)] sm:min-h-[470px]"
              style={{
                transform: `translate3d(${drag.x}px, ${drag.y}px, 0) rotate(${drag.x * 0.035}deg)`,
                background: current.gradient,
                transition: pointerStart.current ? "none" : undefined,
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
            >
              <div className="absolute inset-0 overflow-hidden">
                <div className="absolute -right-10 top-14 h-52 w-52 rounded-full border border-white/15 bg-white/10 blur-[1px]" />
                <div className="absolute -left-10 top-32 h-64 w-64 rounded-full border border-white/15 bg-black/5" />
                <div className="absolute bottom-28 left-1/2 h-44 w-[120%] -translate-x-1/2 rotate-[-8deg] rounded-[50%] border-t border-white/20 bg-black/10 blur-[1px]" />
                <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/65" />
              </div>

              <div className="absolute left-5 right-5 top-5 flex items-center justify-between">
                <span className="rounded-full border border-white/25 bg-black/15 px-3 py-1.5 text-[11px] tracking-wide text-white backdrop-blur-md">
                  {current.category}
                </span>
                <span className="flex items-center gap-1.5 rounded-full border border-white/25 bg-black/15 px-3 py-1.5 text-[11px] text-white backdrop-blur-md">
                  {current.type === "video" ? <Video size={13} /> : <ImageIcon size={13} />}
                  {current.type === "video" ? "视频占位" : "图片占位"}
                </span>
              </div>

              <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                <div className="mb-4 grid h-20 w-20 place-items-center rounded-full border border-white/30 bg-white/10 backdrop-blur-sm">
                  {current.type === "video" ? (
                    <Play size={26} fill="currentColor" className="ml-1" />
                  ) : (
                    <ImageIcon size={27} strokeWidth={1.4} />
                  )}
                </div>
                <span className="text-[11px] tracking-[0.28em] text-white/75">
                  {current.motif}
                </span>
                <span className="mt-2 text-[10px] tracking-[0.15em] text-white/55">
                  MEDIA PLACEHOLDER
                </span>
              </div>

              <div className="absolute bottom-0 left-0 right-0 px-6 pb-7 pt-24 text-white">
                <p className="mb-2 flex items-center gap-1.5 text-xs text-white/80">
                  <MapPin size={14} />
                  {current.city}
                </p>
                <h2 className="font-serif text-[30px] leading-tight tracking-wide sm:text-[34px]">
                  {current.name}
                </h2>
                <p className="mt-2 max-w-[300px] text-[13px] leading-6 text-white/85">
                  {current.caption}
                </p>
                <div className="mt-5 flex items-center gap-1.5 text-[10px] text-white/65">
                  <span className="h-1 w-1 rounded-full bg-white/80" />
                  图片与视频为视觉占位，后续可接入真实素材
                </div>
              </div>

              {drag.x > 45 ? (
                <div className="absolute left-5 top-20 rotate-[-10deg] rounded-lg border-2 border-white px-4 py-2 text-xl font-black uppercase tracking-widest text-white">
                  Like
                </div>
              ) : null}
              {drag.x < -45 ? (
                <div className="absolute right-5 top-20 rotate-[10deg] rounded-lg border-2 border-white px-4 py-2 text-xl font-black uppercase tracking-widest text-white">
                  Nope
                </div>
              ) : null}
              {drag.y > 55 ? (
                <div className="absolute left-1/2 top-20 -translate-x-1/2 rounded-full bg-white/20 px-4 py-2 text-sm font-semibold text-white backdrop-blur">
                  换一批
                </div>
              ) : null}
            </article>
          ) : (
            <div className="grid h-[min(62dvh,590px)] min-h-[390px] w-full place-items-center rounded-[26px] bg-[#e8e4d9] text-sm text-[#697368]">
              正在准备下一批灵感…
            </div>
          )}

          <div className="mt-4 flex w-full items-center justify-center gap-5">
            <button
              type="button"
              onClick={() => decide("dislike")}
              aria-label="加入 Dislike"
              className="grid h-[54px] w-[54px] place-items-center rounded-full border border-[#d9c9b9] bg-white text-[#ab6c57] shadow-sm transition hover:-translate-y-0.5 hover:bg-[#f8eae3]"
            >
              <X size={25} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              onClick={refreshDeck}
              aria-label="刷新景点"
              className="grid h-[42px] w-[42px] place-items-center rounded-full border border-[#d9d8ca] bg-[#eeede4] text-[#778075] transition hover:rotate-[-20deg] hover:bg-white"
            >
              <RefreshCw size={17} />
            </button>
            <button
              type="button"
              onClick={() => decide("like")}
              aria-label="加入 Like"
              className="grid h-[54px] w-[54px] place-items-center rounded-full bg-[#416b54] text-white shadow-[0_8px_24px_-12px_rgba(40,76,53,0.8)] transition hover:-translate-y-0.5 hover:bg-[#345a46]"
            >
              <Heart size={23} strokeWidth={1.8} />
            </button>
          </div>
          <p className="mt-3 flex items-center gap-2 text-[10px] text-[#8a9187]">
            <span className="flex items-center gap-1">
              <ArrowLeft size={12} /> 不喜欢
            </span>
            <span className="text-[#c3c4b8]">·</span>
            <span>下滑刷新</span>
            <span className="text-[#c3c4b8]">·</span>
            <span className="flex items-center gap-1">
              喜欢 <ArrowRight size={12} />
            </span>
          </p>
        </section>

        <aside className="mx-auto grid w-full max-w-[390px] grid-cols-2 gap-3 lg:block lg:max-w-[230px]">
          <button
            type="button"
            onClick={() => setPoolOpen("like")}
            className="flex items-center gap-3 rounded-2xl border border-[#416b54]/15 bg-white/70 p-3.5 text-left transition hover:bg-white lg:w-full lg:p-4"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#e5eee7] text-[#416b54]">
              <Heart size={19} />
            </span>
            <span>
              <span className="block text-xs font-semibold text-[#354b3d]">Like 收藏</span>
              <span className="mt-1 block text-[11px] text-[#81887d]">{liked.length} 个灵感</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setPoolOpen("dislike")}
            className="flex items-center gap-3 rounded-2xl border border-[#ab6c57]/15 bg-white/70 p-3.5 text-left transition hover:bg-white lg:mt-3 lg:w-full lg:p-4"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f4e8e2] text-[#ab6c57]">
              <X size={20} />
            </span>
            <span>
              <span className="block text-xs font-semibold text-[#5b4038]">Dislike 跳过</span>
              <span className="mt-1 block text-[11px] text-[#81887d]">{disliked.length} 个景点</span>
            </span>
          </button>
          <div className="col-span-2 mt-1 hidden rounded-2xl border border-[#243129]/10 bg-white/45 p-4 lg:block">
            <p className="flex items-center gap-2 text-xs font-semibold text-[#4c5a4d]">
              <Compass size={15} />
              发现小提示
            </p>
            <p className="mt-2 text-[11px] leading-5 text-[#7b847a]">
              每次刷新都会重新打乱目的地。用键盘方向键也可以操作：← 跳过，→ 喜欢，↓ 刷新。
            </p>
          </div>
        </aside>
      </div>

      {poolOpen ? (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-[#162019]/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPoolOpen(null);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="pool-title"
            className="max-h-[78dvh] w-full max-w-md overflow-hidden rounded-t-[24px] bg-[#fffdf8] shadow-2xl sm:rounded-[24px]"
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
