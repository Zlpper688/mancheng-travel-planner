/**
 * 对话流程对抗性审查 —— 不是测 happy path，而是主动构造「模型乱返回 / 用户乱输入 /
 * 状态漂移」场景，暴露逻辑混乱导致的稳健性漏洞。
 *
 * 跑法：npx tsx scripts/check-chat-adversarial.ts
 */
import { applyResolvedPatch, cardIsSettled, makeDraft, wizardStep } from "../src/lib/chat/draft";
import { gateDefaultDimensions, gateHardConstraints, gatePlacesClaim, shouldAcceptCity, userStatedParty } from "../src/lib/chat/gate";
import type { ChatCardKind, ChatDraft, ResolvedPatch } from "../src/lib/chat/types";

let passed = 0;
let failed = 0;
function ok(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}
const fresh = (): ChatDraft => makeDraft("2026-11-28");
const withCity = (name: string) =>
  applyResolvedPatch(fresh(), {
    city: { name, lat: 30, lng: 120, address: `${name}市` },
    date: "2026-11-28",
    adults: 2,
    styles: ["citywalk"],
  });

console.log("1) 硬约束「人数」不能被模型脑补（与 city/date 同级）");
ok("用户说「1个成人」算表态", userStatedParty("1个成人"));
ok("用户说「带爸妈」算表态", userStatedParty("带我爸妈一起，腿脚不太好"));
ok("用户说「两大一小」算表态", userStatedParty("两大一小"));
ok("玩法卡文本不算人数表态", !userStatedParty("城市漫步、精华打卡、寻味本地"));
ok("纯城市名不算人数表态", !userStatedParty("驻马店"));
const partyGuard = gateHardConstraints(
  { adults: 3, children: 1, seniors: 1, city: withCity("驻马店").city },
  "驻马店",
);
ok("模型脑补的人数被拦", partyGuard.adults === undefined && partyGuard.children === undefined && partyGuard.seniors === undefined, JSON.stringify(partyGuard));
ok("用户没表态人数时不误放行 city", partyGuard.city !== undefined);
const partyOk = gateHardConstraints({ adults: 3 }, "我们一家三口");
ok("用户表态后人数放行", partyOk.adults === 3);

console.log("2) 真相源唯一：cardIsSettled 必须由 wizardStep 推导，不能各写一套");
const settledProbe = withCity("驻马店");
// 只有 style 已确认，其余待确认
const kinds: ChatCardKind[] = ["city", "date", "party", "style", "pace", "transport", "hotel"];
const currentStep = wizardStep(settledProbe);
for (const kind of kinds) {
  // 当前 step 指向的卡片必须未 settled；已确认维度必须 settled。
  const expected = kind === currentStep ? false : settledProbe.confirmed[kind as keyof ChatDraft["confirmed"]];
  ok(`${kind} 的 settled 与 wizardStep 一致`, cardIsSettled(kind, settledProbe) === expected, `${kind} settled=${cardIsSettled(kind, settledProbe)} expected=${expected} step=${currentStep}`);
}
ok("budget 永远视为已处理（提示词说不单独问）", cardIsSettled("budget", settledProbe));
ok("confirm 永远可显示", !cardIsSettled("confirm", settledProbe));

console.log("3) 换城市不能残留旧城市的点名景点 / 静默替换已确认酒店");
const withPick = applyResolvedPatch(withCity("厦门"), {
  selectedPlaces: [{ id: "p1", name: "鼓浪屿", lat: 24.44, lng: 118.06, address: "厦门", category: "attraction", source: "demo" }],
});
const switched = applyResolvedPatch(withPick, {
  city: { name: "驻马店", lat: 32.98, lng: 114.02, address: "河南省驻马店市" },
});
ok("换城市后旧城市点名景点被清空", switched.selectedPlaces.length === 0, JSON.stringify(switched.selectedPlaces.map((p) => p.name)));
const hotelPicked = applyResolvedPatch(withCity("厦门"), {
  hotel: { id: "h1", name: "厦门中山路酒店", lat: 24.48, lng: 118.09, address: "厦门", category: "hotel", source: "demo" },
});
ok("用户先确认了具体酒店", hotelPicked.confirmed.hotel && !hotelPicked.hotelUndecided);
const hotelSwitched = applyResolvedPatch(hotelPicked, {
  city: { name: "驻马店", lat: 32.98, lng: 114.02, address: "河南省驻马店市" },
});
ok("换城市后酒店确认状态被重置（不能悄悄换位还标已确认）", !hotelSwitched.confirmed.hotel, JSON.stringify({ confirmed: hotelSwitched.confirmed.hotel, hotel: hotelSwitched.hotel.name }));

console.log("4) 守门叠加不漏：默认值 + 硬约束同时脑补时全部拦下");
const combo = gateHardConstraints(
  gateDefaultDimensions({ adults: 9, pace: "packed", transport: "drive", hotelUndecided: true, styles: ["coastal"] }, "给我安排驻马店三天"),
  "给我安排驻马店三天",
);
ok("脑补人数被拦", combo.adults === undefined);
ok("脑补节奏被拦", combo.pace === undefined);
ok("脑补交通被拦", combo.transport === undefined);
ok("脑补住处被拦", combo.hotelUndecided === undefined);
ok("玩法(用户没提)保留由引擎兜底，不误伤", combo.styles !== undefined);

console.log("5) 边界输入稳健：空/异常 patch 不破坏状态");
const empty = applyResolvedPatch(fresh(), {});
ok("空 patch 不确认任何维度", Object.values(empty.confirmed).every((v) => !v));
const dup = applyResolvedPatch(withCity("厦门"), { styles: ["citywalk", "citywalk", "foodie"] });
ok("styles 去重", dup.styles.length === 2, JSON.stringify(dup.styles));
ok("换城市清掉不兼容玩法", applyResolvedPatch(withCity("厦门"), { styles: ["coastal"], city: { name: "驻马店", lat: 32.98, lng: 114.02 } }).styles.length === 0);

console.log("6) 城市硬约束：模型不能在用户没点名时改写城市");
ok("用户点名新城市→接受换城", shouldAcceptCity("驻马店", "厦门", false, "去驻马店玩三天"));
ok("用户没提城市→拒绝模型换城", !shouldAcceptCity("大理", "厦门", false, "三天，两个人"));
ok("已确认城市、用户没点名→拒绝改写", !shouldAcceptCity("大理", "驻马店", true, "轻松点"));
ok("已确认、用户点名→接受换城", shouldAcceptCity("大理", "驻马店", true, "改去大理"));
ok("值不变→接受（只是补确认）", shouldAcceptCity("驻马店", "驻马店", false, "三天"));

console.log("7) 点名景点硬约束：模型不能凭空塞景点进行程");
ok("用户原话点了景点名→接受", gatePlacesClaim(["鼓浪屿"], "想去鼓浪屿"));
ok("用户没点名→拒绝模型塞景点", !gatePlacesClaim(["鼓浪屿", "日光岩"], "就按你说的安排"));
ok("用户说没必去点→拒绝", !gatePlacesClaim(["鼓浪屿"], "没有，你安排吧"));
ok("用户点名其中一个→接受整组", gatePlacesClaim(["鼓浪屿", "日光岩"], "鼓浪屿和日光岩一定要去"));
ok("空数组无所谓", !gatePlacesClaim([], "随便"));

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
