/**
 * Lightweight web fetch for AstroCode.
 *
 * Retrieves a URL, strips HTML to readable text, and returns a trimmed,
 * token-bounded snippet — so the agent can pull docs/reference from the web.
 * Pure fetch + regex HTML stripping; no external deps.
 */
export interface FetchResult {
  url: string;
  status: number;
  text: string;
  bytes: number;
}

const MAX_BYTES = 12_000;

function stripHtml(html: string): string {
  let t = html;
  // Drop non-content blocks.
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  // Block closers → newlines so text doesn't run together.
  t = t.replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|pre|code|section|article|header|footer)>/gi, '\n');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  // Remove all remaining tags.
  t = t.replace(/<[^>]+>/g, '');
  // Common entities.
  t = t
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Collapse whitespace.
  t = t
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t;
}

export async function fetchUrl(url: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AstroCode/1.x (terminal coding agent)' },
    redirect: 'follow',
  });
  const raw = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  const looksHtml = /<\/?(html|head|body|div|p)\b/i.test(raw) || contentType.includes('text/html');
  const text = (looksHtml ? stripHtml(raw) : raw).slice(0, MAX_BYTES);
  return { url, status: res.status, text, bytes: text.length };
}
