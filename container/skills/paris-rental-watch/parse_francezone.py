#!/usr/bin/env python3
"""
francezone bbs_2 list/detail HTML parser.

Usage:
    curl -s -A 'Mozilla/5.0' 'https://www.francezone.com/bbs/list.html?table=bbs_2' \
        | python3 parse_francezone.py list
    curl -s -A 'Mozilla/5.0' 'https://www.francezone.com/bbs/view.html?idxno=2521572' \
        | python3 parse_francezone.py detail
"""
import json
import re
import sys
from html import unescape

VIEW_BASE = "https://www.francezone.com/bbs/view.html?idxno="
LIST_BASE = "https://www.francezone.com/bbs/list.html?table=bbs_2"


def read_stdin() -> str:
    raw = sys.stdin.buffer.read()
    for enc in ("utf-8", "euc-kr", "cp949"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def strip_tags(s: str) -> str:
    s = re.sub(r"<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>", "", s, flags=re.I | re.S)
    s = re.sub(r"<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>", "", s, flags=re.I | re.S)
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"</?(p|div|li|tr|h[1-6])\b[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = unescape(s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def parse_list(html: str) -> list[dict]:
    """Extract post rows. Returns newest-first."""
    posts: list[dict] = []
    seen_ids: set[str] = set()

    # Strategy 1: anchor tags pointing to view.html?idxno=NNN
    for m in re.finditer(
        r'<a[^>]+href="[^"]*view\.html\?idxno=(\d+)[^"]*"[^>]*>(.*?)</a>',
        html,
        re.I | re.S,
    ):
        post_id = m.group(1)
        title_html = m.group(2)
        title = strip_tags(title_html)
        if not title or len(title) < 2:
            continue
        if post_id in seen_ids:
            continue
        seen_ids.add(post_id)
        posts.append(
            {
                "post_id": post_id,
                "title": title,
                "url": f"{VIEW_BASE}{post_id}",
                "date": "",
            }
        )

    # Attach a date from the surrounding row (first YYYY-MM-DD found within ~600 chars
    # after the anchor). Real list rows have a date cell; sidebar widgets do not.
    # Filter out anchors without nearby dates — they're not list entries.
    for post in posts:
        anchor_pat = re.compile(
            r'view\.html\?idxno=' + re.escape(post["post_id"]),
            re.I,
        )
        m = anchor_pat.search(html)
        if not m:
            continue
        window = html[m.end() : m.end() + 600]
        d = re.search(r"(20\d{2})[-.](\d{1,2})[-.](\d{1,2})", window)
        if d:
            post["date"] = f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}"

    posts = [p for p in posts if p["date"]]
    posts.sort(key=lambda p: (p["date"], int(p["post_id"])), reverse=True)
    return posts


def parse_detail(html: str) -> dict:
    """Extract post body + image URLs + post date.

    francezone wraps the post body in `<section class="bbs-view-content container">…</section>`
    and the post header (with date) in `<section class="bbs-view-header">…</section>`.
    """
    body = ""
    body_html = ""
    m = re.search(
        r'<section[^>]+class="[^"]*bbs-view-content[^"]*"[^>]*>(.*?)</section>',
        html,
        re.I | re.S,
    )
    if m:
        body_html = m.group(1)
        body = strip_tags(body_html)

    if len(body) < 30:
        # Fallback: try generic article tag
        m = re.search(r"<article\b[^>]*>(.*?)</article>", html, re.I | re.S)
        if m:
            body_html = m.group(1)
            body = strip_tags(body_html)

    # Pull images from the body section only, not page-wide nav/sidebar.
    image_urls: list[str] = []
    seen_imgs: set[str] = set()
    if body_html:
        for img in re.finditer(r'<img[^>]+src=["\']([^"\']+)["\']', body_html, re.I):
            src = img.group(1).strip()
            if not src:
                continue
            if src.startswith("//"):
                src = "https:" + src
            elif src.startswith("/"):
                src = "https://www.francezone.com" + src
            if any(
                skip in src.lower()
                for skip in ("/icon", "/emoticon", "/btn_", "/img/menu", "/logo/")
            ):
                continue
            if src in seen_imgs:
                continue
            seen_imgs.add(src)
            image_urls.append(src)
            if len(image_urls) >= 10:
                break

    post_date = ""
    # Date from bbs-view-header section (preferred — it's the publish date)
    hm = re.search(
        r'<section[^>]+class="[^"]*bbs-view-header[^"]*"[^>]*>(.*?)</section>',
        html,
        re.I | re.S,
    )
    header_blob = hm.group(1) if hm else html
    d = re.search(
        r"(20\d{2})[-.](\d{1,2})[-.](\d{1,2})\s+(\d{1,2}):(\d{2})", header_blob
    )
    if d:
        post_date = (
            f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}"
            f"T{int(d.group(4)):02d}:{d.group(5)}"
        )
    else:
        d = re.search(r"(20\d{2})[-.](\d{1,2})[-.](\d{1,2})", header_blob)
        if d:
            post_date = f"{d.group(1)}-{int(d.group(2)):02d}-{int(d.group(3)):02d}"

    return {"body": body, "image_urls": image_urls, "post_date": post_date}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in ("list", "detail"):
        print(json.dumps({"error": "usage: parse_post.py {list|detail}"}))
        sys.exit(2)
    html = read_stdin()
    if sys.argv[1] == "list":
        out = parse_list(html)
    else:
        out = parse_detail(html)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
