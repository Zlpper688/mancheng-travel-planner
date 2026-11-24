import { PLACE_PROFILES, type PlaceProfile } from "../../content/places";
import { cleanNameForMatch } from "../providers/normalize";

export type { PlaceProfile };

export function findPlaceProfile(
  city: string,
  name: string,
): PlaceProfile | undefined {
  // 只做整名匹配：鼓浪屿上的子景点不能继承整岛的船票、耗时与介绍。
  const target = cleanNameForMatch(name);
  if (!target) return undefined;
  for (const profile of PLACE_PROFILES) {
    if (
      !profile.city.some(
        (token) => city.includes(token) || token.includes(city),
      )
    ) {
      continue;
    }
    if (profile.names.some((token) => cleanNameForMatch(token) === target)) {
      return profile;
    }
  }
  return undefined;
}