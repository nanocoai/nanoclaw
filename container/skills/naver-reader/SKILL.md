---
name: naver-reader
description: Fetch and read Naver blog posts or list all posts from a blog. Use when the user mentions a Naver blog, shares a blog.naver.com URL, asks to read/summarize a post, or asks to list posts from a blogger. Trigger examples: "이 네이버 블로그 읽어줘", "메르 블로그 목록 보여줘", "ranto28 최신 글", "https://blog.naver.com/... 요약해줘"
allowed-tools: Bash(curl:*), Bash(python3:*)
---

# Naver Blog Reader

## Parse any Naver blog URL

```python
import re

url = "https://blog.naver.com/ranto28/224233242850"
m = re.match(r'https?://blog\.naver\.com/([^/?]+)(?:/(\d+))?', url)
blog_id = m.group(1)   # e.g. "ranto28"
log_no  = m.group(2)   # e.g. "224233242850" — None if just a blog homepage
```

## Read a post (blog_id + log_no required)

Naver blog pages load via iframe — fetch the PostView URL directly:

```bash
curl -s -A "Mozilla/5.0" \
  "https://blog.naver.com/PostView.naver?blogId={blog_id}&logNo={log_no}&redirect=Dlog&widgetTypeCall=true&noTrackingCode=true&directAccess=false" \
| python3 -c "
import sys, re
html = sys.stdin.read()
out = []
for s in re.findall(r'<span[^>]*se-fs-fs16[^>]*>(.*?)</span>', html, re.DOTALL):
    t = re.sub(r'<[^>]+>', '', s).replace('&quot;','\"').replace('&amp;','&').replace('\u200b','').strip()
    if t: out.append(t)
print('\n'.join(out))
"
```

If output is empty, the post uses an older editor — extract `id=\"postViewArea\"` instead.

## List posts (blog_id only)

RSS covers only the latest 50. For full history, paginate the async API:

```bash
python3 << 'EOF'
import urllib.request, re, time
from urllib.parse import unquote_plus

BLOG_ID = "{blog_id}"

def fetch(page):
    url = f"https://blog.naver.com/PostTitleListAsync.naver?blogId={BLOG_ID}&currentPage={page}&countPerPage=30"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Referer": f"https://blog.naver.com/{BLOG_ID}"})
    with urllib.request.urlopen(req) as r:
        return r.read().decode()

def parse(raw):
    for m in re.finditer(r'\{"sellerServiceStatus[^}]+\}', raw):
        o = m.group(0)
        logno = re.search(r'"logNo":"(\d+)"', o)
        title = re.search(r'"title":"([^"]+)"', o)
        date  = re.search(r'"addDate":"([^"]+)"', o)
        if logno and title:
            yield logno.group(1), date.group(1) if date else "", unquote_plus(title.group(1))

raw = fetch(1)
total = int(re.search(r'"totalCount":"(\d+)"', raw).group(1))
total_pages = (total + 29) // 30
posts = list(parse(raw))
for p in range(2, total_pages + 1):
    posts.extend(parse(fetch(p)))
    time.sleep(0.15)

print(f"Total: {len(posts)} posts")
for logno, date, title in posts:
    print(f"{date}\thttps://blog.naver.com/{BLOG_ID}/{logno}\t{title}")
EOF
```
