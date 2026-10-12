import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getMemeOfDay } from "@/lib/db";
import { metadataBaseUrl } from "@/lib/metadata-url";
import {
  buildPostText,
  getChannelOrganizationId,
  getLastPostText,
  queuePost,
} from "@/lib/buffer";

// Daily Vercel Cron (vercel.json, 08:00 UTC). It only QUEUES the Meme of the
// Day in Buffer; Buffer publishes it to X at each channel's own queue slot.
// Nothing is written to DynamoDB: "did we already post this meme" is answered
// by reading the channel's latest post back from Buffer.

interface ChannelResult {
  channelId: string;
  result: "queued" | "skipped_same_meme" | "error";
  error?: string;
}

// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>". An unset secret
// must reject everything: otherwise the expected header would be the literal
// "Bearer undefined", which anyone can send.
function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  // timingSafeEqual needs two buffers of equal length. Hashing both sides
  // gives that, and the comparison time then says nothing about how much of
  // the secret (or its length) a guess got right.
  const given = createHash("sha256")
    .update(request.headers.get("authorization") ?? "")
    .digest();
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(given, expected);
}

function configError(message: string) {
  console.error(`buffer-motd: ${message}, nothing queued`);
  return NextResponse.json({ error: message }, { status: 500 });
}

// Each channel runs inside its own try/catch so one failing channel cannot
// stop the other.
async function queueForChannel(
  channelId: string,
  permalink: string,
  text: string,
  imageUrl: string
): Promise<ChannelResult> {
  try {
    const organizationId = await getChannelOrganizationId(channelId);
    const lastText = await getLastPostText(organizationId, channelId);
    if (lastText?.includes(permalink)) {
      console.log(`buffer-motd: skipped_same_meme channel=${channelId}`);
      return { channelId, result: "skipped_same_meme" };
    }
    await queuePost(channelId, text, imageUrl);
    console.log(`buffer-motd: queued channel=${channelId}`);
    return { channelId, result: "queued" };
  } catch (err) {
    // Only the message is logged: it is built in lib/buffer.ts from the HTTP
    // status or Buffer's own error text, never from the request headers, so
    // the API key cannot end up in the logs.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`buffer-motd: error channel=${channelId}: ${message}`);
    return { channelId, result: "error", error: message };
  }
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const meme = await getMemeOfDay();
  if (!meme) {
    console.log("buffer-motd: no meme of the day, nothing queued");
    return NextResponse.json({ result: "no_meme" });
  }

  // Buffer downloads the image when the post publishes, hours after this
  // runs, from its own servers. Only the permanent CloudFront URL works for
  // that. A relative /api/image/... path means CLOUDFRONT_DOMAIN is unset.
  if (!meme.imageUrl.startsWith("https://")) {
    return configError("meme image URL is not an absolute https URL (is CLOUDFRONT_DOMAIN set?)");
  }

  // Same base URL helper the NFT metadata routes use: NEXT_PUBLIC_APP_URL
  // when it is a usable https URL, otherwise the host this request came in
  // on. A link in a public post must be https, so anything else (local dev)
  // stops here.
  const baseUrl = metadataBaseUrl(request);
  if (!baseUrl.startsWith("https://")) {
    return configError("no usable https app URL for the permalink (is NEXT_PUBLIC_APP_URL set?)");
  }
  const permalink = `${baseUrl}/meme/${meme.id}`;

  const channelIds = (process.env.BUFFER_CHANNEL_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (!process.env.BUFFER_API_KEY || channelIds.length === 0) {
    return configError("BUFFER_API_KEY or BUFFER_CHANNEL_IDS is not set");
  }

  // Built once so both channels get the same post.
  const text = buildPostText(meme.caption, permalink);

  const results: ChannelResult[] = [];
  for (const channelId of channelIds) {
    results.push(await queueForChannel(channelId, permalink, text, meme.imageUrl));
  }

  const failed = results.some((r) => r.result === "error");
  return NextResponse.json({ memeId: meme.id, results }, { status: failed ? 500 : 200 });
}
