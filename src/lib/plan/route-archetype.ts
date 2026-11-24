import type { PaceId, StyleId } from "../types";

export type RouteArchetypeId =
  | "day-trip"
  | "weekend"
  | "classic"
  | "deep"
  | "grand";

export interface RouteArchetype {
  id: RouteArchetypeId;
  label: string;
  summary: string;
  maxFarDays: number;
}

/**
 * 攻略按「一日游 / 两日游 / 三日游 / 多日环线」组织，而不是把景点平铺。
 * 这里把同样的时长骨架变成排线参数：能塞几个远足日、什么时候该收着排。
 */
export function routeArchetypeOf(input: {
  days: number;
  pace: PaceId;
  styles: StyleId[];
  farDays?: number;
}): RouteArchetype {
  const days = Math.max(1, input.days);
  let archetype: RouteArchetype;

  if (days <= 1) {
    archetype = {
      id: "day-trip",
      label: "一日游",
      summary:
        "一天只走一个片区，先保 2–3 个最有代表性的点，别把时间花在路上。",
      maxFarDays: 0,
    };
  } else if (days === 2) {
    archetype = {
      id: "weekend",
      label: "周末两日",
      summary:
        "一天主城、一天外围，两个方向不折返；傍晚留给夜景或日落。",
      maxFarDays: 1,
    };
  } else if (days <= 4) {
    archetype = {
      id: "classic",
      label: `经典 ${days} 日`,
      summary:
        "主城一片加一个远足方向，固定一个傍晚收尾，其余交给顺路的街区。",
      maxFarDays: 1,
    };
  } else if (days <= 7) {
    archetype = {
      id: "deep",
      label: `深度 ${days} 日`,
      summary:
        "主城拆成两片，再加 1–2 个远足方向；中间留半天慢下来，别天天满档。",
      maxFarDays: 2,
    };
  } else {
    archetype = {
      id: "grand",
      label: `环线 ${days} 日`,
      summary:
        "以酒店为基地分片推进，每 2–3 天换一个方向；远足日之间插一天近处，恢复体力。",
      maxFarDays: 3,
    };
  }

  if (input.pace === "chill") {
    archetype = {
      ...archetype,
      summary: `${archetype.summary} 慢节奏下每天再少排一个点。`,
      maxFarDays: Math.min(archetype.maxFarDays, 1),
    };
  } else if (input.pace === "packed" && days >= 5) {
    archetype = {
      ...archetype,
      maxFarDays: archetype.maxFarDays + 1,
    };
  }
  if (input.styles.includes("family")) {
    archetype = {
      ...archetype,
      summary: `${archetype.summary} 带娃时远足不超过一天，午后就近回住处。`,
      maxFarDays: Math.min(archetype.maxFarDays, 1),
    };
  }

  const hardCap = Math.max(0, days - 1);
  const cap =
    input.farDays !== undefined
      ? Math.max(0, Math.min(input.farDays, hardCap))
      : Math.min(archetype.maxFarDays, hardCap);
  return { ...archetype, maxFarDays: cap };
}
