import type { TripVector } from "@/lib/plan/prefs";
import type {
  BudgetTier,
  CityOption,
  ExperienceId,
  PaceId,
  Place,
  StyleId,
  TransportPref,
} from "@/lib/types";

// 对话层只负责把旅行约束收齐；坐标、路线、耗时一律由行程引擎给。
export interface ChatConfirmed {
  city: boolean;
  date: boolean;
  party: boolean;
  style: boolean;
  pace: boolean;
  transport: boolean;
  hotel: boolean;
}

export interface ChatDraft {
  city: CityOption;
  hotel: Place;
  hotelUndecided: boolean;
  days: number;
  date: string;
  pace: PaceId;
  styles: StyleId[];
  experiences: ExperienceId[];
  transport: TransportPref;
  budgetTier: BudgetTier;
  adults: number;
  children: number;
  seniors: number;
  avoidSteep: boolean;
  notes: string;
  /**
   * 连续偏好（每维 0~1）。草稿里始终有值，中性 0.5 表示没表过态；
   * 只有偏离中性时才往排线请求里带，避免「默认值悄悄影响打分」。
   */
  prefs: TripVector;
  selectedPlaces: Place[];
  confirmed: ChatConfirmed;
}

export type ChatCardKind =
  | "city"
  | "date"
  | "party"
  | "style"
  | "pace"
  | "transport"
  | "budget"
  | "hotel"
  | "confirm";

export interface ChatCard {
  id: string;
  kind: ChatCardKind;
  title: string;
  hint?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  cards?: ChatCard[];
}

// 模型只能给“名字”和枚举值，真正的坐标由服务端查。
export interface ChatPatch {
  city?: string;
  days?: number;
  date?: string;
  pace?: PaceId;
  styles?: StyleId[];
  experiences?: ExperienceId[];
  transport?: TransportPref;
  budgetTier?: BudgetTier;
  adults?: number;
  children?: number;
  seniors?: number;
  avoidSteep?: boolean;
  notes?: string;
  hotelQuery?: string;
  hotelUndecided?: boolean;
  selectedNames?: string[];
  /** 连续偏好的增量：只带这一轮说到的维度。 */
  prefs?: Partial<TripVector>;
}

// 服务端解析后的补丁，客户端可以直接写进草稿。
export interface ResolvedPatch {
  city?: CityOption;
  hotel?: Place;
  hotelUndecided?: boolean;
  days?: number;
  date?: string;
  pace?: PaceId;
  styles?: StyleId[];
  experiences?: ExperienceId[];
  transport?: TransportPref;
  budgetTier?: BudgetTier;
  adults?: number;
  children?: number;
  seniors?: number;
  avoidSteep?: boolean;
  notes?: string;
  /** LLM 只填它听出来的那几维，其余沿用草稿。 */
  prefs?: Partial<TripVector>;
  selectedPlaces?: Place[];
}

export interface ChatReply {
  say: string;
  patch?: ResolvedPatch;
  cards?: ChatCard[];
  action?: "plan" | "none";
}

export interface ChatApiResponse {
  ai: boolean;
  configured: boolean;
  model?: string;
  reply?: ChatReply;
  reason?: string;
}