/**
 * 向导不跳步回归 —— 针对用户实测「这里少一轮问啊」：
 * 玩法确认后模型把节奏/出行/住处的默认值打包写进 patch，
 * wizardStep 直接从 style 跳到 confirm，欢迎语承诺的节奏、住处两轮从没被问过。
 *
 * 跑法：npx tsx scripts/check-wizard-gate.ts
 */
import { applyResolvedPatch, makeDraft, wizardStep } from "../src/lib/chat/draft";
import {
  gateDefaultDimensions,
  triesToFinishEarly,
  userStatedHotel,
  userStatedPace,
  userStatedTransport,
} from "../src/lib/chat/gate";
import type { ResolvedPatch } from "../src/lib/chat/types";

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

// 复现用户现场：驻马店 / 1 成人 / 3 天 / 玩法点卡片确认，
// 节奏、出行、住处三项都还没问过。
let draft = makeDraft("2026-11-28");
draft = applyResolvedPatch(draft, {
  city: { name: "驻马店", lat: 32.98, lng: 114.02, address: "河南省驻马店市" },
  date: "2026-11-28",
  days: 3,
  adults: 1,
});
draft = applyResolvedPatch(draft, {
  styles: ["citywalk", "classic", "foodie"],
  experiences: ["oldtown", "temple", "museum", "food"],
});

const CARD_LABEL = "城市漫步、精华打卡、寻味本地 · 老街古城、古寺、博物馆、当地小吃";
const MODEL_GUESS: ResolvedPatch = {
  pace: "balanced",
  transport: "auto",
  hotelUndecided: true,
};

console.log("1) 玩法确认后必须停在节奏，不能直接到 confirm");
ok("城市/日期/人数/玩法已确认", draft.confirmed.city && draft.confirmed.date && draft.confirmed.party && draft.confirmed.style);
ok("节奏/出行/住处尚未确认", !draft.confirmed.pace && !draft.confirmed.transport && !draft.confirmed.hotel);
ok("下一步是 pace", wizardStep(draft) === "pace", wizardStep(draft));

console.log("2) 「点玩法卡片」不算对节奏/出行/住处表态");
ok("玩法卡文本不算节奏表态", !userStatedPace(CARD_LABEL), CARD_LABEL);
ok("玩法卡文本不算出行表态", !userStatedTransport(CARD_LABEL), CARD_LABEL);
ok("玩法卡文本不算住处表态（老街古城≠住处）", !userStatedHotel(CARD_LABEL), CARD_LABEL);

console.log("3) 模型脑补的默认值在玩法卡文本下必须被拦下");
const gated = gateDefaultDimensions(MODEL_GUESS, CARD_LABEL);
ok("拦掉 pace", gated.pace === undefined, JSON.stringify(gated));
ok("拦掉 transport", gated.transport === undefined, JSON.stringify(gated));
ok("拦掉 hotelUndecided", gated.hotelUndecided === undefined, JSON.stringify(gated));
ok("拦掉后向导仍停在节奏", wizardStep(applyResolvedPatch(draft, gated)) === "pace");

console.log("4) 用户真的表态时默认值/偏好要照收");
const stated = gateDefaultDimensions(MODEL_GUESS, "轻松点，坐地铁，还没定住处");
ok("用户说轻松→收下 pace", stated.pace !== undefined, JSON.stringify(stated));
ok("用户说地铁→收下 transport", stated.transport !== undefined, JSON.stringify(stated));
ok("用户说没定住处→收下 hotelUndecided", stated.hotelUndecided === true, JSON.stringify(stated));
ok("宽松授权词算节奏表态", userStatedPace("都行，你定"));
ok("宽松授权词算住处表态", userStatedHotel("看着办"));

console.log("5) 提前收尾拦截：信息没齐时 confirm 卡 / plan 都必须挡回追问");
const confirmCard = [{ id: "c1", kind: "confirm" as const, title: "信息齐了，开始安排？" }];
const paceCard = [{ id: "c2", kind: "pace" as const, title: "每天走多少？" }];
ok("节奏没确认时 confirm 卡=提前收尾", triesToFinishEarly("none", confirmCard, wizardStep(draft)));
ok("节奏没确认时 plan=提前收尾", triesToFinishEarly("plan", undefined, wizardStep(draft)));
ok("节奏卡不算提前收尾", !triesToFinishEarly("none", paceCard, wizardStep(draft)));
const allSet = applyResolvedPatch(draft, MODEL_GUESS);
ok("三项补确认后到 confirm", wizardStep(allSet) === "confirm", wizardStep(allSet));
ok("confirm 阶段的 confirm 卡正常放行", !triesToFinishEarly("none", confirmCard, wizardStep(allSet)));
ok("confirm 阶段的 plan 正常放行", !triesToFinishEarly("plan", undefined, wizardStep(allSet)));

console.log("6) 用户实测原话：模型说「信息齐了」但没带卡，也要挡回追问");
const wrapUpSay = "信息齐了。有必去或不想去的地方吗？没有就直接开始安排。";
ok("节奏没确认时收尾话术=提前收尾", triesToFinishEarly("none", undefined, wizardStep(draft), wrapUpSay));
ok("节奏没确认时收尾话术配 confirm 卡照样拦", triesToFinishEarly("none", confirmCard, wizardStep(draft), wrapUpSay));
ok("confirm 阶段收尾话术正常放行", !triesToFinishEarly("none", undefined, wizardStep(allSet), wrapUpSay));
const authorized = gateDefaultDimensions(MODEL_GUESS, "别问了，直接排");
ok("「直接排」授权时默认值放行", authorized.pace === "balanced" && authorized.transport === "auto" && authorized.hotelUndecided === true, JSON.stringify(authorized));
ok("「直接排」后到 confirm 不拦", !triesToFinishEarly("plan", undefined, wizardStep(applyResolvedPatch(draft, authorized))));

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);
