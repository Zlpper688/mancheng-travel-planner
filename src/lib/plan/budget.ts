import { BUDGET_TIERS } from "../constants";
import type {
  BudgetItem,
  BudgetSummary,
  BudgetTier,
  DayPlan,
  TripInput,
} from "../types";

const MISC_PER_DAY: Record<BudgetTier, number> = {
  economy: 20,
  comfort: 45,
  premium: 100,
};

const round = (value: number) => Math.max(0, Math.round(value));

export function buildBudget(
  days: DayPlan[],
  input: TripInput,
  hotelFactor = 1,
): BudgetSummary {
  const seniors = input.seniors ?? 0;
  const travelers = Math.max(1, input.adults + input.children + seniors);
  // 全是老人或儿童同行时，用餐/门票权重也不能归零。
  const childWeight = Math.max(
    1,
    input.adults + seniors + input.children * 0.6,
  );
  const ticketWeight = Math.max(
    1,
    input.adults + seniors * 0.85 + input.children * 0.5,
  );
  const tier = BUDGET_TIERS[input.budgetTier];
  const nights = Math.max(0, input.days - 1);
  const rooms = Math.max(1, Math.ceil(Math.max(1, input.adults + seniors) / 2));

  const stops = days.flatMap((day) => day.stops);
  const meals = stops.filter((stop) => stop.kind === "meal");
  const cafes = stops.filter((stop) => stop.kind === "cafe");
  const sights = stops.filter((stop) => stop.kind === "sight");

  const baseHotelPrice =
    input.hotelPrice && input.hotelPrice > 0
      ? input.hotelPrice
      : input.hotel?.cost && input.hotel.cost > 0
        ? input.hotel.cost
        : tier.hotel;
  const nightly = baseHotelPrice * hotelFactor;
  const hotelTotal = nightly * nights * rooms;
  const anchorOnly =
    Boolean(input.hotelUndecided) ||
    !input.hotel ||
    input.hotel.id.startsWith("base-") ||
    input.hotel.id.startsWith("center-") ||
    input.hotel.name.includes("市中心");
  const hotelItem: BudgetItem = {
    key: "hotel",
    label: "住宿",
    detail:
      nights === 0
        ? "一日行程，不含住宿"
        : `${nights} 晚 × ${rooms} 间${hotelFactor > 1 ? " · 已计假期上浮" : ""}`,
    min: round(hotelTotal),
    max: round(hotelTotal * 1.12),
    note:
      nights === 0
        ? undefined
        : anchorOnly
          ? `未锁定具体酒店，按${input.hotel?.name ?? "推荐落脚片区"}的位置与「${tier.label}」档预留，实际以预订页为准`
          : "按「" + tier.label + "」档参考房价，实际以预订页为准",
  };

  const fallbackMeal = (tier.food[0] + tier.food[1]) / 2;
  const fallbackCafe = (tier.cafe[0] + tier.cafe[1]) / 2;
  const knownMeals = meals.reduce((sum, stop) => sum + (stop.place.cost ?? 0), 0);
  const knownCafes = cafes.reduce((sum, stop) => sum + (stop.place.cost ?? 0), 0);
  const unknownMeals = meals.filter((stop) => stop.place.cost === undefined).length;
  const unknownCafes = cafes.filter((stop) => stop.place.cost === undefined).length;
  const expectedCafes = Math.max(
    cafes.length,
    input.pace === "packed" && !seniors ? 0 : input.days,
  );
  const missingCafes = Math.max(0, expectedCafes - cafes.length);
  const expectedMeals = Math.max(meals.length, input.days * 2);
  const missingMeals = Math.max(0, expectedMeals - meals.length);

  const foodTotal =
    (knownMeals +
      unknownMeals * fallbackMeal +
      knownCafes +
      unknownCafes * fallbackCafe +
      missingMeals * fallbackMeal +
      missingCafes * fallbackCafe) *
    childWeight;
  const foodItem: BudgetItem = {
    key: "food",
    label: "餐饮",
    detail:
      missingMeals > 0
        ? `${expectedMeals} 顿正餐（行程内 ${meals.length} 段）· ${expectedCafes} 次茶歇 · ${travelers} 人`
        : `${expectedMeals} 顿正餐 · ${expectedCafes} 次咖啡茶歇 · ${travelers} 人`,
    min: round(foodTotal * 0.88),
    max: round(foodTotal * 1.35),
    note: "有参考人均的按人均计；自由用餐时段按同档餐厅中位数预留",
  };

  const knownTickets = sights.reduce((sum, stop) => sum + (stop.ticket ?? 0), 0);
  const unknownTickets = sights.filter((stop) => stop.ticket === undefined).length;
  const ticketTotal =
    knownTickets * ticketWeight + unknownTickets * tier.ticket * 0.55 * ticketWeight;
  const ticketItem: BudgetItem = {
    key: "ticket",
    label: "门票 / 入馆",
    detail:
      unknownTickets > 0
        ? `${sights.length} 个景点 · ${unknownTickets} 个未标价，已按区间预留`
        : `${sights.length} 个景点 · 按参考票价`,
    min: round(ticketTotal * 0.85),
    max: round(
      (knownTickets * ticketWeight + unknownTickets * tier.ticket * ticketWeight) * 1.08,
    ),
    note: "多数博物馆与寺庙免费；未标价点位按同档参考票价预留",
  };

  const legs = days.flatMap((day) => day.legs);
  const vehicles = Math.max(1, Math.ceil(travelers / 4));
  const transportTotal = legs.reduce(
    (sum, leg) =>
      sum + leg.cost * (leg.costUnit === "vehicle" ? vehicles : travelers),
    0,
  );
  const transportItem: BudgetItem = {
    key: "transport",
    label: "市内交通",
    detail: `${days.length} 天 · ${legs.length} 段路程${vehicles > 1 ? ` · 打车按 ${vehicles} 辆计` : ""}`,
    min: round(transportTotal * 0.8),
    max: round(transportTotal * 1.3 + travelers * 10),
    note: "步行免费；公交/地铁按票价，打车按里程估费整车计",
  };

  const miscTotal = MISC_PER_DAY[input.budgetTier] * travelers * days.length;
  const miscItem: BudgetItem = {
    key: "misc",
    label: "零花与机动",
    detail: "饮水、零食、伴手礼与临时加项",
    min: round(miscTotal * 0.5),
    max: round(miscTotal * 1.6),
  };

  const items = [hotelItem, foodItem, ticketItem, transportItem, miscItem];
  const totalMin = items.reduce((sum, item) => sum + item.min, 0);
  const totalMax = items.reduce((sum, item) => sum + item.max, 0);

  return {
    totalMin,
    totalMax,
    perPersonMin: round(totalMin / travelers),
    perPersonMax: round(totalMax / travelers),
    travelers,
    items,
  };
}
