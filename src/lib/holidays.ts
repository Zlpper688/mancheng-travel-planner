import type { HolidayInfo } from "./types";

type HolidayRange = {
  name: string;
  start: string;
  end: string;
  crowd: number;
  hotelFactor: number;
  tip: string;
};

// 2026、2027 年放假安排来自国务院办公厅通知。
const HOLIDAYS: HolidayRange[] = [
  {
    name: "元旦",
    start: "2026-01-01",
    end: "2026-01-03",
    crowd: 1.18,
    hotelFactor: 1.12,
    tip: "跨年人流集中，热门餐厅和展馆建议提前订位。",
  },
  {
    name: "春节",
    start: "2026-02-15",
    end: "2026-02-23",
    crowd: 1.42,
    hotelFactor: 1.3,
    tip: "春节部分小店会歇业，出发前确认营业；景区预约要趁早。",
  },
  {
    name: "清明",
    start: "2026-04-04",
    end: "2026-04-06",
    crowd: 1.25,
    hotelFactor: 1.15,
    tip: "踏青高峰，近郊与墓园周边道路易拥堵，尽量早出发。",
  },
  {
    name: "劳动节",
    start: "2026-05-01",
    end: "2026-05-05",
    crowd: 1.38,
    hotelFactor: 1.28,
    tip: "五一热门景区常限流，门票和入馆名额务必提前预约。",
  },
  {
    name: "端午",
    start: "2026-06-19",
    end: "2026-06-21",
    crowd: 1.2,
    hotelFactor: 1.1,
    tip: "短途出行集中，返程尽量避开假期最后一天下午。",
  },
  {
    name: "中秋",
    start: "2026-09-25",
    end: "2026-09-27",
    crowd: 1.22,
    hotelFactor: 1.12,
    tip: "赏月点位人多，晚餐提前订，夜间返程留出余量。",
  },
  {
    name: "国庆",
    start: "2026-10-01",
    end: "2026-10-07",
    crowd: 1.5,
    hotelFactor: 1.38,
    tip: "全年最挤的假期之一，热门点建议开门就到，交通多留 30% 时间。",
  },
  {
    name: "元旦",
    start: "2027-01-01",
    end: "2027-01-03",
    crowd: 1.18,
    hotelFactor: 1.12,
    tip: "跨年人流集中，热门餐厅和展馆建议提前订位。",
  },
  {
    name: "春节",
    start: "2027-02-05",
    end: "2027-02-13",
    crowd: 1.42,
    hotelFactor: 1.3,
    tip: "春节部分小店会歇业，出发前确认营业；景区预约要趁早。",
  },
  {
    name: "清明",
    start: "2027-04-03",
    end: "2027-04-05",
    crowd: 1.25,
    hotelFactor: 1.15,
    tip: "踏青高峰，近郊与墓园周边道路易拥堵，尽量早出发。",
  },
  {
    name: "劳动节",
    start: "2027-05-01",
    end: "2027-05-05",
    crowd: 1.38,
    hotelFactor: 1.28,
    tip: "五一热门景区常限流，门票和入馆名额务必提前预约。",
  },
  {
    name: "端午",
    start: "2027-06-09",
    end: "2027-06-09",
    crowd: 1.12,
    hotelFactor: 1.05,
    tip: "只有一天假，周边短途最舒服，热门点早去早回。",
  },
  {
    name: "中秋",
    start: "2027-09-15",
    end: "2027-09-15",
    crowd: 1.12,
    hotelFactor: 1.05,
    tip: "赏月点位人多，晚餐提前订。",
  },
  {
    name: "国庆",
    start: "2027-10-01",
    end: "2027-10-07",
    crowd: 1.5,
    hotelFactor: 1.38,
    tip: "全年最挤的假期之一，热门点建议开门就到，交通多留 30% 时间。",
  },
];

// 调休上班的周末，按普通工作日处理。
const MAKEUP_WORKDAYS = new Set([
  "2026-01-04",
  "2026-02-14",
  "2026-02-28",
  "2026-05-09",
  "2026-09-20",
  "2026-10-10",
  "2027-01-31",
  "2027-02-14",
  "2027-05-08",
  "2027-09-26",
  "2027-10-09",
]);

export function getHoliday(date: string): HolidayInfo | null {
  const holiday = HOLIDAYS.find((item) => date >= item.start && date <= item.end);
  if (!holiday) return null;
  return {
    name: holiday.name,
    crowd: holiday.crowd,
    crowdPct: Math.round((holiday.crowd - 1) * 100),
    hotelFactor: holiday.hotelFactor,
    tip: holiday.tip,
  };
}

export function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (day === 0 || day === 6) && !MAKEUP_WORKDAYS.has(date);
}

export function crowdFactor(date: string): number {
  return getHoliday(date)?.crowd ?? (isWeekend(date) ? 1.08 : 1);
}
