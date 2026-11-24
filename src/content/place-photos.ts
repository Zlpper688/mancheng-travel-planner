// 演示城市的人工校验图：逐张看过，确认是本地实景。
// 共享资源同名景点很多（芜湖也有中山路步行街），所以这里只写死 file/作者/许可，
// 运行时先查这张表；表里没有的点位宁可留白，也不拿外地照片凑数。
// thumb 固定 960px：维基只允许有限档缩略宽度，动态拼接容易 400。
export interface CuratedPhoto {
  city: string;
  name: string;
  thumb: string;
  page: string;
  author: string;
  license: string;
}

export const CURATED_PHOTOS: CuratedPhoto[] = [
  {
    city: "厦门",
    name: "鼓浪屿",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/11/Gulangyu_at_dusk.jpg/960px-Gulangyu_at_dusk.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Gulangyu_at_dusk.jpg",
    author: "周流劲火",
    license: "CC BY 2.5",
  },
  {
    city: "厦门",
    name: "日光岩",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/1d/%E6%97%A5%E5%85%89%E5%B2%A9.jpg/960px-%E6%97%A5%E5%85%89%E5%B2%A9.jpg",
    page: "https://commons.wikimedia.org/wiki/File:%E6%97%A5%E5%85%89%E5%B2%A9.jpg",
    author: "Webridge",
    license: "CC BY 3.0",
  },
  {
    city: "厦门",
    name: "菽庄花园",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/5/59/%E8%8F%BD%E5%BA%84%E8%8A%B1%E5%9B%AD_-_Shuzhuang_Garden_-_2013.01_-_panoramio.jpg/960px-%E8%8F%BD%E5%BA%84%E8%8A%B1%E5%9B%AD_-_Shuzhuang_Garden_-_2013.01_-_panoramio.jpg",
    page: "https://commons.wikimedia.org/wiki/File:%E8%8F%BD%E5%BA%84%E8%8A%B1%E5%9B%AD_-_Shuzhuang_Garden_-_2013.01_-_panoramio.jpg",
    author: "rheins",
    license: "CC BY 3.0",
  },
  {
    city: "厦门",
    name: "皓月园",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b8/%E7%9A%93%E6%9C%88%E5%9B%AD_-_Bright_Moon_Park_-_2013.01_-_panoramio.jpg/960px-%E7%9A%93%E6%9C%88%E5%9B%AD_-_Bright_Moon_Park_-_2013.01_-_panoramio.jpg",
    page: "https://commons.wikimedia.org/wiki/File:%E7%9A%93%E6%9C%88%E5%9B%AD_-_Bright_Moon_Park_-_2013.01_-_panoramio.jpg",
    author: "rheins",
    license: "CC BY 3.0",
  },
  {
    city: "厦门",
    name: "胡里山炮台",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/11/Hulishan_Fort_Krupp_artillery_01_20170728.jpg/960px-Hulishan_Fort_Krupp_artillery_01_20170728.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Hulishan_Fort_Krupp_artillery_01_20170728.jpg",
    author: "Tyg728",
    license: "CC BY-SA 4.0",
  },
  {
    city: "厦门",
    name: "厦门大学",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a0/%E5%8E%A6%E9%97%A8%E5%A4%A7%E5%AD%A6%E4%B8%BB%E6%A5%BC_%28The_main_building_of_Xiamen_University%29_-_panoramio.jpg/960px-%E5%8E%A6%E9%97%A8%E5%A4%A7%E5%AD%A6%E4%B8%BB%E6%A5%BC_%28The_main_building_of_Xiamen_University%29_-_panoramio.jpg",
    page: "https://commons.wikimedia.org/wiki/File:%E5%8E%A6%E9%97%A8%E5%A4%A7%E5%AD%A6%E4%B8%BB%E6%A5%BC_(The_main_building_of_Xiamen_University)_-_panoramio.jpg",
    author: "风二中",
    license: "CC BY 3.0",
  },
  {
    city: "厦门",
    name: "演武大桥观景平台",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/1/16/%E6%BC%94%E6%AD%A6%E5%A4%A7%E6%A1%A5%E8%A7%82%E6%99%AF%E5%B9%B3%E5%8F%B0%E4%B8%8A%E8%A7%82%E6%99%AF.jpg/960px-%E6%BC%94%E6%AD%A6%E5%A4%A7%E6%A1%A5%E8%A7%82%E6%99%AF%E5%B9%B3%E5%8F%B0%E4%B8%8A%E8%A7%82%E6%99%AF.jpg",
    page: "https://commons.wikimedia.org/wiki/File:%E6%BC%94%E6%AD%A6%E5%A4%A7%E6%A1%A5%E8%A7%82%E6%99%AF%E5%B9%B3%E5%8F%B0%E4%B8%8A%E8%A7%82%E6%99%AF.jpg",
    author: "Liuxingy",
    license: "CC BY-SA 4.0",
  },
  {
    city: "厦门",
    name: "沙坡尾",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b1/%E7%BD%91%E7%BA%A2%E5%8C%96%E6%B2%99%E5%9D%A1%E5%B0%BE2.jpg/960px-%E7%BD%91%E7%BA%A2%E5%8C%96%E6%B2%99%E5%9D%A1%E5%B0%BE2.jpg",
    page: "https://commons.wikimedia.org/wiki/File:%E7%BD%91%E7%BA%A2%E5%8C%96%E6%B2%99%E5%9D%A1%E5%B0%BE2.jpg",
    author: "向史公哲曰",
    license: "CC BY-SA 4.0",
  },
  {
    city: "厦门",
    name: "中山路步行街",
    thumb:
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2f/Zhongshan_Road%2C_Xiamen_2.jpg/960px-Zhongshan_Road%2C_Xiamen_2.jpg",
    page: "https://commons.wikimedia.org/wiki/File:Zhongshan_Road,_Xiamen_2.jpg",
    author: "Slyronit",
    license: "CC BY-SA 4.0",
  },
];