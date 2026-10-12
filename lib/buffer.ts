// Server-only Buffer integration (KAN-84). Never import this from a "use
// client" file: BUFFER_API_KEY would end up in the browser bundle.
//
// Every GraphQL name used here (queries, fields, enum values) is copied from
// Buffer's published docs and reference. Values are written inline in the
// query text, the same way the docs' own examples do it, so nothing here
// depends on API behaviour the docs do not show.

const BUFFER_API_URL = "https://api.buffer.com";

const X_MAX_LENGTH = 280;
// X replaces every link with a t.co link, so a URL always costs 23 no matter
// how long or short it really is.
const X_URL_LENGTH = 23;
const ELLIPSIS = "…";

export const POST_TEMPLATES = [
  `Meme of the Day on MemeDay: "{caption}" Like it, tip the creator in SOL, or share it. {link}`,
  `"{caption}" is today's Meme of the Day. On MemeDay, creators get tipped in SOL directly from the feed. {link}`,
  `Today's pick on MemeDay: "{caption}" Creators post, fans tip in SOL, and memes can be minted as NFTs. {link}`,
];

// X does not count plain string length. Latin text and common punctuation
// cost 1 each; everything else (emoji, CJK, and also the ellipsis character)
// costs 2. The ranges are X's own, from twitter-text config/v3.json. A plain
// .length check would let a truncated post land at 281 and be rejected.
function xWeight(text: string): number {
  let weight = 0;
  for (const char of text) {
    const cp = char.codePointAt(0);
    const single =
      cp <= 4351 ||
      (cp >= 8192 && cp <= 8205) ||
      (cp >= 8208 && cp <= 8223) ||
      (cp >= 8242 && cp <= 8247);
    weight += single ? 1 : 2;
  }
  return weight;
}

// Length of a finished post as X counts it: the link is a flat 23.
export function xCountedLength(post: string, link: string): number {
  return xWeight(post.replace(link, "")) + X_URL_LENGTH;
}

// Walks whole characters (not UTF-16 halves), so an emoji is either kept or
// dropped, never cut in two.
function truncateToWeight(text: string, maxWeight: number): string {
  let kept = "";
  let used = xWeight(ELLIPSIS);
  for (const char of text) {
    used += xWeight(char);
    if (used > maxWeight) break;
    kept += char;
  }
  return kept.trimEnd() + ELLIPSIS;
}

// `random` is a parameter only so tests can force a specific template.
export function buildPostText(
  caption: string,
  link: string,
  random: () => number = Math.random
): string {
  const template = POST_TEMPLATES[Math.floor(random() * POST_TEMPLATES.length)];
  const clean = caption.trim();

  if (!clean) {
    return template
      .replace(`"{caption}"`, "")
      .replace(/ {2,}/g, " ")
      .trim()
      .replace("{link}", () => link);
  }

  const fixedWeight = xWeight(template.replace("{caption}", "").replace("{link}", ""));
  const budget = X_MAX_LENGTH - X_URL_LENGTH - fixedWeight;
  const text = xWeight(clean) > budget ? truncateToWeight(clean, budget) : clean;

  // Function replacers, because a plain string replacement would treat "$&"
  // or "$1" inside a caption as a pattern. The link goes in first so a caption
  // that happens to contain "{link}" is left as written.
  return template.replace("{link}", () => link).replace("{caption}", () => text);
}

// JSON string syntax is also valid GraphQL string syntax, so this is a safe
// way to put arbitrary text (quotes, newlines, emoji) into a query.
const gql = (value: string) => JSON.stringify(value);

async function bufferRequest(query: string) {
  const response = await fetch(BUFFER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.BUFFER_API_KEY}`,
    },
    body: JSON.stringify({ query }),
  });

  // No retry on a rate limit: Buffer's windows run up to 30 days, and the
  // cron fires again tomorrow anyway. The Retry-After value goes into the
  // error so it shows up in the logs.
  if (response.status === 429) {
    throw new Error(
      `Buffer rate limit hit (HTTP 429), Retry-After: ${response.headers.get("Retry-After")}`
    );
  }
  if (!response.ok) {
    throw new Error(`Buffer API returned HTTP ${response.status}`);
  }

  const body = await response.json();
  if (body.errors?.length) {
    const messages = body.errors.map((e: { message: string }) => e.message).join("; ");
    throw new Error(`Buffer API error: ${messages}`);
  }
  return body.data;
}

// The posts query needs an organization ID. Asking Buffer which organization
// owns the channel avoids a fourth env var, and stays correct if the account
// ever belongs to more than one organization.
export async function getChannelOrganizationId(channelId: string): Promise<string> {
  const data = await bufferRequest(`
    query ChannelOrganization {
      channel(input: { id: ${gql(channelId)} }) {
        organizationId
      }
    }
  `);
  return data.channel.organizationId;
}

// Text of the newest post on one channel, counting both published (sent) and
// still-queued (scheduled) posts, or null if the channel has none. Sorted by
// creation time so "newest" means "the last thing added to this channel".
export async function getLastPostText(
  organizationId: string,
  channelId: string
): Promise<string | null> {
  const data = await bufferRequest(`
    query LastPostForChannel {
      posts(
        first: 1
        input: {
          organizationId: ${gql(organizationId)}
          sort: [{ field: createdAt, direction: desc }]
          filter: { status: [sent, scheduled], channelIds: [${gql(channelId)}] }
        }
      ) {
        edges {
          node {
            id
            text
          }
        }
      }
    }
  `);
  return data.posts.edges?.[0]?.node.text ?? null;
}

// addToQueue puts the post in the channel's next free posting slot; Buffer
// publishes it then. The image is passed as a URL that Buffer downloads at
// publish time, so it has to be a permanent public URL.
export async function queuePost(
  channelId: string,
  text: string,
  imageUrl: string
): Promise<string> {
  const data = await bufferRequest(`
    mutation CreatePost {
      createPost(
        input: {
          text: ${gql(text)}
          channelId: ${gql(channelId)}
          schedulingType: automatic
          mode: addToQueue
          assets: [{ image: { url: ${gql(imageUrl)} } }]
        }
      ) {
        ... on PostActionSuccess {
          post {
            id
          }
        }
        ... on MutationError {
          message
        }
      }
    }
  `);
  // Buffer reports a rejected post (bad image URL, text too long, queue
  // limit) as HTTP 200 with a message instead of a post.
  if (!data.createPost.post) {
    throw new Error(`Buffer rejected the post: ${data.createPost.message}`);
  }
  return data.createPost.post.id;
}
