import { minutesToTime } from "./geo";

export function money(value: number): string {
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

export function moneyRange(min: number, max: number): string {
  if (Math.abs(max - min) < 1) return money(min);
  return `¥${Math.round(min).toLocaleString("zh-CN")}–${Math.round(max).toLocaleString("zh-CN")}`;
}

export function clockRange(startMin: number, endMin: number): string {
  return `${minutesToTime(startMin)}–${minutesToTime(endMin)}`;
}

export function countdown(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round(km * 1000))} 米`;
  return `${km.toFixed(1)} km`;
}
