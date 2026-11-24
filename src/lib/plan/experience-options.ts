import type { ExperienceId } from "../types";

export interface ExperienceOption {
  id: ExperienceId;
  label: string;
}

// 设置面板只露出最像「心愿单」的八件事，其余交给风格与自动排线。
// 单独成文件，避免客户端组件把整套路书推导逻辑打进首屏包。
export const EXPERIENCE_OPTIONS: ExperienceOption[] = [
  { id: "sunset", label: "看日落" },
  { id: "sunrise", label: "看日出" },
  { id: "coast", label: "海边" },
  { id: "oldtown", label: "老街古城" },
  { id: "food", label: "当地小吃" },
  { id: "hike", label: "登山徒步" },
  { id: "boat", label: "坐船" },
  { id: "photo", label: "拍照" },
];
