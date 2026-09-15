/** Resolve sibling routes for both /call and /call/ links, preserving proxy prefixes. */
export function voiceEndpoint(route: "info" | "sdp" | "hangup", token: string, pageUrl = location.href): URL {
  const page = new URL(pageUrl)
  page.pathname = page.pathname.replace(/\/+$/, "")
  const url = new URL(route, page)
  url.search = ""
  url.hash = ""
  url.searchParams.set("t", token)
  return url
}
