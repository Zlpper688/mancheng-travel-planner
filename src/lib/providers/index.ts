import type { DataSourceKind } from "../types";
import { amapProvider } from "./amap";
import { openProvider } from "./open";
import type { PlaceProvider } from "./types";

export function isAmapConfigured(): boolean {
  return Boolean(process.env.AMAP_KEY?.trim());
}

export function getProvider(): PlaceProvider {
  return isAmapConfigured() ? amapProvider : openProvider;
}

export function dataSourceInfo(): {
  source: DataSourceKind;
  label: string;
  note: string;
} {
  return isAmapConfigured()
    ? {
        source: "amap",
        label: "高德实时数据",
        note: "商户、评分、公交换乘与驾车路线来自高德开放平台",
      }
    : {
        source: "open",
        label: "开放地图数据",
        note: "OpenStreetMap / Wikidata 点位，真实步行与驾车路径",
      };
}
