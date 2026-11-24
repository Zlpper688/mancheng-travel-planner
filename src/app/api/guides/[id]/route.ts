import { NextResponse } from "next/server";
import { readGuide } from "@/lib/guides/store";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const guide = await readGuide(id);
    if (!guide) {
      return NextResponse.json(
        { error: "没有找到这份攻略", code: "GUIDE_NOT_FOUND" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { guide },
      {
        headers: {
          "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        },
      },
    );
  } catch (error) {
    console.error("[guides:id]", error);
    return NextResponse.json(
      { error: "攻略库暂时读不出来", code: "GUIDES_UNAVAILABLE" },
      { status: 500 },
    );
  }
}