import type { ChatCard, ResolvedPatch } from "./types";

/**
 * 向导不跳步守门。
 *
 * 背景（用户实测「这里少一轮问啊」）：
 * 对话模式里模型常把节奏/出行/住处这些「可默认」维度用默认值打包写进 patch。
 * 服务端 applyResolvedPatch 一旦见到这些字段就把 confirmed 标成 true，
 * wizardStep 于是从 style 直接跳到 confirm——欢迎语承诺的节奏、住处两轮被吞掉。
 *
 * 两条独立的防线：
 * 1) gateDefaultDimensions：用户没有真的表态时，拦下模型脑补的默认值。
 *    只有用户原话里出现该维度的表态信号，才允许默认值/偏好进 patch。
 *    判断只看「用户本轮原话」，不看模型说了什么——和 userStatedDate 一个思路。
 * 2) triesToFinishEarly：即便 patch 漏网，前端在信息没齐时也必须挡回
 *    confirm 卡和 action:"plan"，强制追问 wizardStep 指向的那一步。
 */

// 「别问了 / 直接排」是规则6的明确授权：剩余维度按默认值收下即可。
// 三个维度都要认这个词，否则用户明确要排时反被守门挡住。
const BLANKET_RE =
  /别问|直接排|直接安排|开始安排|你安排|你定|看着办|随你|随便|都行|都随便|随意/;

// 节奏表态：轻松/赶/充实，或把选择权交给我（此时用默认 balanced）。
const PACE_RE =
  /轻松|悠闲|慢一点|慢些|放慢|别太赶|不要太赶|不赶|从容|舒服|松弛|充实|多玩|多看|紧凑|赶一点|赶一些|赶时间|chill|packed|balanced|自动/;
// 出行表态：具体方式，或交给我（auto）。注意「骑行/徒步/坐船」是玩法心愿不是出行方式，
// 不放在这里，避免用户点玩法卡时被误判成已经表态出行。
const TRANSPORT_RE =
  /地铁|公交|打车|出租|开车|自驾|步行|走路|坐车|搭车|交通|出行|通勤|自动/;
// 住处表态：想住哪/还没定/交给我。
// 不能把「古城/老城」单独算住处——那是玩法心愿（老街古城），会被玩法卡误命中。
// 「住」字本身已经覆盖「住老城 / 想住 / 住处 / 住宿」。
const HOTEL_RE =
  /住|酒店|宾馆|民宿|客栈|落脚|市中心|还没定|没定|未定|推荐.*住/;

export function userStatedPace(text: string): boolean {
  return PACE_RE.test(text) || BLANKET_RE.test(text);
}

export function userStatedTransport(text: string): boolean {
  return TRANSPORT_RE.test(text) || BLANKET_RE.test(text);
}

export function userStatedHotel(text: string): boolean {
  return HOTEL_RE.test(text) || BLANKET_RE.test(text);
}

// 人数是硬约束（提示词规则3：城市/日期/人数必须由用户说清，不能用默认值蒙混）。
// 模型很爱自己脑补「2 成人」，若不守门，runPlan 的 >=1 校验会被假人数骗过。
// 「两位/三口/带娃/一家/我们/独自」等都算表态；玩法卡文本一律不算。
const PARTY_RE =
  /成人|大人|小孩|儿童|孩子|老人|长辈|爸妈|父母|带娃|亲子|一家|三口|两口|情侣|独自|一个人|几个人|几位|[0-9一二三四五六七八九十两]\s*(个|位|人|口|大|小)|我们|同行|结伴/;

export function userStatedParty(text: string): boolean {
  return PARTY_RE.test(text) || BLANKET_RE.test(text);
}

/**
 * 硬约束守门：城市/日期/人数里，只有用户本轮原话明确说过的才允许进 patch。
 * 日期已有 userStatedDate 单独校验（在 model.ts），这里补人数这道缺口；
 * 城市已有 resolveCity + nameSimilarity 校验，不动。
 */
export function gateHardConstraints(
  patch: ResolvedPatch,
  userText: string,
): ResolvedPatch {
  const gated: ResolvedPatch = { ...patch };
  const partyStated =
    gated.adults !== undefined ||
    gated.children !== undefined ||
    gated.seniors !== undefined;
  if (
    partyStated &&
    !userStatedParty(userText)
  ) {
    delete gated.adults;
    delete gated.children;
    delete gated.seniors;
  }
  return gated;
}

/**
 * 拦下模型脑补的默认值：只有用户本轮原话真的表态过该维度，才保留对应字段。
 * 城市/日期/人数是硬约束，另有各自的校验，不在这里处理。
 */
export function gateDefaultDimensions(
  patch: ResolvedPatch,
  userText: string,
): ResolvedPatch {
  const gated: ResolvedPatch = { ...patch };
  if (gated.pace !== undefined && !userStatedPace(userText)) delete gated.pace;
  if (gated.transport !== undefined && !userStatedTransport(userText)) {
    delete gated.transport;
  }
  if (gated.hotelUndecided && !userStatedHotel(userText)) {
    delete gated.hotelUndecided;
  }
  return gated;
}

// 模型收尾话术：和 confirm 卡一起出现时好拦，单独出现时也要挡，
// 否则会先显示「信息齐了」再追问节奏，文案自相矛盾。
const WRAP_UP_SAY_RE =
  /信息齐[了全]|都齐了|信息够[了]|信息齐全|开始安排|可以开始排|可以安排|那就按|按现在这些|开始排|直接排/;

/**
 * 城市是硬约束：只有用户本轮原话点名了这个城市，或模型给的就是当前草稿城市
 * （只是补确认），才接受。原实现里 `!draft.confirmed.city ||` 会让模型在用户
 * 只说「三天两人」时擅自把城市改成任意值——和人数脑补同源的漏洞。
 */
export function shouldAcceptCity(
  nextName: string,
  draftCityName: string,
  confirmed: boolean,
  userText: string,
): boolean {
  if (nextName === draftCityName) return true;
  // 换城必须用户在原话里点了新城市名；已确认过的城市更要严格。
  return userText.includes(nextName);
}

/**
 * 点名景点是硬约束：模型常凭空列一堆景点塞进行程。只有用户原话里真的出现
 * 了至少一个模型给的景点名，才接受这组 selectedNames。
 */
export function gatePlacesClaim(names: string[], userText: string): boolean {
  if (!names.length) return false;
  return names.some((name) => name.length > 0 && userText.includes(name));
}

/**
 * 信息没齐时，模型给的 confirm 卡、action:"plan"、收尾话术都算提前收尾，必须挡回。
 * step 由服务端/前端各自的 wizardStep 算好后传进来，本函数不重复实现步骤判定。
 */
export function triesToFinishEarly(
  action: "plan" | "none" | undefined,
  cards: ChatCard[] | undefined,
  step: string,
  say?: string,
): boolean {
  if (step === "confirm") return false;
  return (
    action === "plan" ||
    Boolean(cards?.some((card) => card.kind === "confirm")) ||
    Boolean(say && WRAP_UP_SAY_RE.test(say))
  );
}
