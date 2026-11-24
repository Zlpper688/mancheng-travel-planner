export function isDemoCity(city: string): boolean {
  const clean = city.replace(/市$/, "").trim();
  return clean === "厦门" || clean.includes("厦门");
}