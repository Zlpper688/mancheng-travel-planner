# 景点信息核实数据（enrichment）

本目录每个 `<城市>.json` 是**联网核实过**的景点真实信息，由 agent 用网络搜索逐城补齐。
必须与 `../cities/<城市>.json` 里的必去点（must）对齐，坐标/评分/门票/简介都要有出处，**严禁编造**。

## 文件格式

```json
{
  "city": "成都",
  "verifiedAt": "2026-11-25",
  "method": "websearch",
  "sources": ["腾讯地图", "维基导游"],
  "center": [104.066, 30.657],
  "places": {
    "春熙路": {
      "name": "春熙路步行街",
      "lng": 104.07721,
      "lat": 30.6555,
      "category": "street",
      "rating": 4.8,
      "ticket": "免费",
      "hours": "全天开放",
      "intro": "成都最繁华的商业步行街，由春熙东路/西/南/北四条步行街组成。",
      "source": "腾讯地图",
      "verified": true
    }
  },
  "unverified": ["某个实在查不到坐标的点"]
}
```

## 字段约束

- `places` 的 key **必须**用 `../cities/<城市>.json` 里 `must[].name` 的原名（一字不差），
  这样引擎才能按名字接上；`name` 可以是核实到的正式全名。
- `lng` / `lat`：经纬度，**经度在前纬度在后**，取搜索结果里地图给出的数值，不要自己估算。
- `category`：只能是 `attraction / museum / park / viewpoint / beach / street / temple / market / nature / food / cafe / hotel / other`。
- `rating` / `ticket` / `hours` / `intro`：查到就填，查不到就省略该字段，不要编。
- `source`：写明出处（腾讯地图 / 高德 / 维基导游 / 携程 / 马蜂窝 等）。
- `verified`：只有真正拿到坐标的才写 `true`。
- `unverified`：查不到可靠坐标的点名放这里，宁可留白也不编造。
- `center`：城市中心 `[lng, lat]`，能查到就填，方便引擎定位。

## 搜索建议

一次 WebSearch 常常能带回一个城市多个点的坐标（腾讯地图参考资料会给经纬度+评分+营业时间，
维基导游会给坐标+门票+简介）。优先搜「城市名 + 必去点名 + 经纬度」，再补搜单个查不到的点。
