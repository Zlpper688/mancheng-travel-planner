import { minutesToTime } from "@/lib/geo";
import type { DayWeather, HourlyPoint, RainWindow } from "@/lib/types";
import { Icon } from "../Icon";
import { cn } from "../ui";

/**
 * 当日天气条 + 24 小时温度/降水小图。
 *
 * 图表只在「有雨信号」或「够 8 个小时温度」时才画，避免没有数据的日子占位置。
 */

function WeatherChart({
  hours,
  windows,
}: {
  hours: HourlyPoint[];
  windows?: RainWindow[];
}) {
  const wetSignal = hours.some(
    (entry) => entry.mm >= 0.2 || (entry.prob ?? 0) >= 40,
  );
  const temps = Array.from(
    { length: 24 },
    (_, hour) => hours.find((item) => item.hour === hour)?.temp,
  );
  const knownTemps = temps.filter((value): value is number => value !== undefined);
  const showTemp = knownTemps.length >= 8;
  if (!wetSignal && !showTemp) return null;

  const peak = Math.max(0.6, ...hours.map((entry) => entry.mm));
  const labels = (windows ?? []).slice(0, 2).map((window) => {
    const range = `${minutesToTime(window.startMin)}–${minutesToTime(
      window.endMin,
    )}`;
    return window.peakProb > 0
      ? `${range}（最高 ${Math.round(window.peakProb)}%）`
      : range;
  });
  const tempMin = showTemp ? Math.min(...knownTemps) : 0;
  const tempMax = showTemp ? Math.max(...knownTemps) : 0;
  const tempSpan = Math.max(1, tempMax - tempMin);
  const segments: string[] = [];
  let current: string[] = [];
  temps.forEach((temp, hour) => {
    if (temp === undefined) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(
      `${hour + 0.5},${Math.round((1 - (temp - tempMin) / tempSpan) * 100)}`,
    );
  });
  if (current.length > 1) segments.push(current.join(" "));

  return (
    <div className="mt-2">
      {showTemp ? (
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-micro text-ink-faint">气温</span>
          <svg
            viewBox="0 0 24 100"
            preserveAspectRatio="none"
            className="h-4 flex-1 text-amber opacity-80"
            aria-hidden="true"
          >
            {segments.map((points) => (
              <polyline
                key={points}
                points={points}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          <span className="shrink-0 text-micro tabular-nums text-ink-faint">
            {Math.round(tempMin)}°~{Math.round(tempMax)}°
          </span>
        </div>
      ) : null}
      {wetSignal ? (
        <>
          <div className="mt-1 flex h-7 items-end gap-[2px]">
            {Array.from({ length: 24 }, (_, hour) => {
              const entry = hours.find((item) => item.hour === hour);
              const mm = entry?.mm ?? 0;
              const prob = entry?.prob ?? 0;
              const wet = mm >= 0.2 || prob >= 55;
              const height =
                mm > 0
                  ? Math.max(10, Math.round((mm / peak) * 100))
                  : wet
                    ? 12
                    : 4;
              return (
                <span
                  key={hour}
                  title={`${String(hour).padStart(2, "0")}:00 · ${mm.toFixed(1)} mm${
                    entry?.prob !== undefined
                      ? ` · 降水概率 ${Math.round(entry.prob)}%`
                      : ""
                  }${entry?.temp !== undefined ? ` · ${entry.temp.toFixed(1)}°C` : ""}`}
                  className={cn(
                    "flex-1 rounded-t-[2px]",
                    mm >= 0.2
                      ? "bg-[#5b7ba6]"
                      : wet
                        ? "bg-[#a9b8cd]"
                        : "bg-line/60",
                  )}
                  style={{ height: `${height}%` }}
                />
              );
            })}
          </div>
          <div className="mt-0.5 flex justify-between text-micro tabular-nums text-ink-faint">
            <span>0 时</span>
            <span>6</span>
            <span>12</span>
            <span>18</span>
            <span>24 时</span>
          </div>
          {labels.length ? (
            <p className="mt-1 text-[10.5px] text-ink-faint">
              雨段 {labels.join("、")}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export default function WeatherStrip({ weather }: { weather: DayWeather }) {
  const hasDetail = Boolean(weather.tip || weather.backup || weather.estimated);
  return (
    <div className="mb-3 rounded-xl border border-line/70 bg-paper/70 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-soft">
        <Icon name={weather.icon} size={14} className="text-jade" />
        <span className="font-medium text-ink">{weather.label}</span>
        <span className="tabular-nums">
          {Math.round(weather.tMin)}° ~ {Math.round(weather.tMax)}°
        </span>
        {weather.precipProb !== undefined && weather.precipProb >= 10 ? (
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            <Icon name="rain" size={10} />
            {Math.round(weather.precipProb)}%
          </span>
        ) : weather.precipProb === undefined &&
          weather.precipMm !== undefined &&
          weather.precipMm > 0 ? (
          <span className="inline-flex items-center gap-0.5 tabular-nums">
            <Icon name="rain" size={10} />
            {weather.precipMm.toFixed(1)} mm
          </span>
        ) : null}
        {weather.sunrise && weather.sunset ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-ink-faint">
            <Icon name="sun" size={10} />
            日出 {weather.sunrise} · 日落 {weather.sunset}
          </span>
        ) : null}
      </div>
      {weather.hourly?.length ? (
        <WeatherChart hours={weather.hourly} windows={weather.rainWindows} />
      ) : null}
      {hasDetail ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10.5px] leading-relaxed">
          {weather.tip ? (
            <span className="text-ink-soft">{weather.tip}</span>
          ) : null}
          {weather.backup ? (
            <span className="text-jade">雨天备选：{weather.backup.name}</span>
          ) : null}
          {weather.estimated ? (
            <span className="rounded bg-amber-soft px-1 py-px text-micro text-amber">
              去年同期气候
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

