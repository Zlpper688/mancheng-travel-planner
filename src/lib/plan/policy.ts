export function isDepartureDay(days: number, day: number): boolean {
  // 首日从酒店出发，没有落地时间约束；只有最后一天按离城日减量。
  return days >= 3 && day === days;
}

export function dayStopLimit(input: {
  perDayLimit: number;
  edge: boolean;
  closesLate: boolean;
}): number {
  // 傍晚/夜市收尾的日子多留一个白天的支撑位，避免午后空一大段。
  return Math.max(
    1,
    input.perDayLimit - (input.edge ? 1 : 0) + (input.closesLate ? 1 : 0),
  );
}

export function dayMinuteBudget(input: {
  sights: number;
  edge: boolean;
  closingBonus: number;
}): number {
  // 日落/夜市日天然玩到晚上，多给一个支撑位的时长。
  return input.sights * 80 * (input.edge ? 0.88 : 1) + input.closingBonus;
}

export function lateReturnLimits(input: {
  paceEndMin: number;
  family: boolean;
  closesLate: boolean;
  farLong: boolean;
}): { overrunLimit: number; endLimit: number } {
  // 夜景日天然收得晚，别用普通日的回家时间砍掉白天的核心点位。
  // 带小孩时把晚归上限收紧：宁可少一个日落支撑点，也别让一家人深夜还在外面。
  const overrunLimit = input.family ? 60 : 90 + (input.closesLate ? 45 : 0);
  const endLimit = Math.min(
    input.paceEndMin + (input.farLong ? 75 : 0),
    input.family ? 21 * 60 + 30 : 24 * 60,
  );
  return { overrunLimit, endLimit };
}

export const PAID_SIGHT_WARNING_LIMIT = 4;