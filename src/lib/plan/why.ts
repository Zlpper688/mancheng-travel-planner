// 「为什么这么排」：把排线时的判断翻译成人话。
//
// 这些结论全部来自行程里已有的字段（主景、片区、时间轴、日出日落、
// 远足标记、餐食位置），不引入新的推断——宁可少说一句，也不猜。
import { PACES } from "../constants";
import { minutesToTime, placeDistance } from "../geo";
import type { DayPlan, Place, TripInput } from "../types";
import type { DaySeed } from "./select";

const MAX_BULLETS = 4;

function pairs(sights: Place[]): { a: Place; b: Place; km: number } | null {
  if (sights.length < 2) return null;
  let best: { a: Place; b: Place; km: number } | null = null;
  for (let i = 0; i < sights.length; i += 1) {
    for (let j = i + 1; j < sights.length; j += 1) {
      const km = placeDistance(sights[i], sights[j]);
      if (!best || km > best.km) best = { a: sights[i], b: sights[j], km };
    }
  }
  return best;
}

function toMin(hhmm?: string): number | null {
  if (!hhmm) return null;
  const [hh, mm] = hhmm.split(":").map((part) => Number(part));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  return hh * 60 + mm;
}

function duration(minutes: number): string {
  const value = Math.max(0, Math.round(minutes));
  const h = Math.floor(value / 60);
  const m = value % 60;
  if (!h) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function explainDay({
  day,
  seed,
  input,
}: {
  day: DayPlan;
  seed: DaySeed;
  input: TripInput;
}): string[] {
  // 留白日没有点位，硬解释「为什么这么排」只会自相矛盾。
  if (!day.stops.length) return [];
  const bullets: string[] = [];
  const sights = day.stops.filter((stop) => stop.kind === "sight");
  const hero = day.heroPlaceId
    ? day.stops.find((stop) => stop.place.id === day.heroPlaceId)
    : sights[0];
  const sunrise = day.weather?.sunrise;
  const sunset = day.weather?.sunset;

  // 1. 主轴：先解释这天为什么围着它转
  if (hero) {
    const rating = hero.place.rating;
    const badge =
      rating && rating > 0
        ? `评分 ${rating.toFixed(1)}`
        : (hero.place.popularity ?? 0) >= 4
          ? "名气够、又顺路"
          : "同片区里最值得停的一个";
    bullets.push(
      `主轴定在「${hero.place.name}」—— ${badge}，先把它固定住，其余点位再往它周围收。`,
    );
  } else if (day.stops.length) {
    bullets.push(
      `这天没有大景点，按「${PACES[input.pace].label}」节奏把吃、喝和顺路小点串起来，不硬凑。`,
    );
  }

  // 2. 片区：解释为什么这些点能在一天里走完
  const spread = pairs(sights.map((stop) => stop.place));
  if (day.far) {
    const longest = Math.max(0, ...day.legs.map((leg) => leg.distanceKm));
    // day.area 在远足日会带上「远足 · 」前缀，这里只留地名。
    const area = day.area.replace(/^远足\s*·\s*/, "");
    bullets.push(
      `远足日：主要景点在${area}，单程最长一段 ${longest.toFixed(
        1,
      )} km，整天只走这一个方向，不再回城绕第二片。`,
    );
  } else if (spread && spread.km <= 8) {
    // area 有时是片区名（青羊），有时只有方位（东南方向），后者要补个「酒店」才通顺。
    const area = /方向$/.test(day.area) ? `酒店${day.area}` : day.area;
    bullets.push(
      `${sights.length} 个景点都在${area}一带，最远两点相距 ${spread.km.toFixed(
        1,
      )} km，串成一条线走，不用来回穿城。`,
    );
  } else if (sights.length === 1) {
    bullets.push(
      `景点只留了「${sights[0].place.name}」一个，其余时间给吃饭、休息和路上的不确定。`,
    );
  } else if (spread) {
    bullets.push(
      `${sights.length} 个景点横跨 ${spread.km.toFixed(
        1,
      )} km，是靠「${seed.theme}」这条线拉在一起的，路上时间已经算进时间轴。`,
    );
  }

  // 3. 时间：几点出门、为什么是这个点
  if (day.rhythm?.sunrise) {
    const sunriseMin = toMin(sunrise);
    const slack = sunriseMin === null ? null : sunriseMin - day.startMin;
    const start = minutesToTime(day.startMin);
    bullets.push(
      slack === null
        ? `早上 ${start} 出门，赶在日出前到机位。`
        : slack >= 10
          ? `早上 ${start} 出门，比日出（${sunrise}）早 ${slack} 分钟，走过去和等天色都算进去了。`
          : slack >= 0
            ? `早上 ${start} 出门，比日出（${sunrise}）早 ${slack} 分钟，走到机位正好天亮。`
            : `早上 ${start} 出门，太阳（${sunrise}）已经出来了，到机位刚好赶上晨光。`,
    );
  } else if (day.rhythm?.early) {
    bullets.push(
      `早市、早场要赶早，${minutesToTime(day.startMin)} 就出门，去晚了摊位就收了。`,
    );
  } else {
    bullets.push(
      `${minutesToTime(day.startMin)} 出发、${minutesToTime(
        day.endMin,
      )} 回酒店，路上共 ${duration(day.stats.travelMin)}，其余时间都留给了停留点。`,
    );
  }

  // 4. 收尾或午饭，二选一，避免一次说太多
  if (day.rhythm?.sunset) {
    bullets.push(
      `日落点压轴（当天日落 ${sunset ?? "约 17:30"}），看完天就黑，回程按末班车往前倒排。`,
    );
  } else if (day.rhythm?.night) {
    bullets.push("收尾放在夜市，晚饭就在那片解决，不从城这头跑回那头吃。");
  } else {
    const lunch = day.stops.find(
      (stop) => stop.kind === "meal" && stop.startMin >= 11 * 60 && stop.startMin <= 14 * 60 + 30,
    );
    if (lunch) {
      const previous = [...day.stops]
        .filter((stop) => stop.endMin <= lunch.startMin)
        .pop();
      const km = previous ? placeDistance(previous.place, lunch.place) : 0;
      bullets.push(
        km > 0 && km <= 1.2
          ? `午饭落在「${lunch.place.name}」，离上一个点只有 ${km.toFixed(
              1,
            )} km，吃完接着走，不额外绕路。`
          : `午饭排在「${lunch.place.name}」（${minutesToTime(
              lunch.startMin,
            )}），按当时的所在片区挑的，不为了吃饭折返。`,
      );
    }
  }

  return bullets.slice(0, MAX_BULLETS);
}
