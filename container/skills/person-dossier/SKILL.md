---
name: person-dossier
description: >-
  Research a person or company for networking, career, and relationship
  intelligence — NOT sales outreach. Use whenever the user sends a LinkedIn
  profile URL, a person's name + company, or a company name/domain and asks
  "who is this", "research them", "prep me for a meeting", "what's happening at
  their company", "should I reach out", or wants conversation/connection/comment
  drafts. Pulls verified data from Apollo via the OneCLI gateway, builds a
  structured dossier, and produces ready-to-use (human-in-the-loop) drafts. Does
  NOT log into LinkedIn or automate LinkedIn actions.
---

# Person & Company Dossier (Career / Relationship Intelligence)

Goal: make the user the most-prepared person in any professional interaction.
You gather verified intelligence and prepare drafts; the user reviews and acts.
You never log into LinkedIn or send anything automatically.

## Golden rules

1. **Data comes from Apollo**, called through the OneCLI gateway. Apollo is
   official and safe. Do NOT scrape LinkedIn, do NOT use a browser to log into
   LinkedIn, do NOT ask the user for their LinkedIn password.
2. **Actions stay manual.** You produce drafts (connection notes, comments,
   follow-up messages, talking points). The user sends them himself.
3. **Be honest about gaps.** Apollo gives identity + company intel, NOT the
   text of someone's recent LinkedIn posts/comments or their writing style.
   Mark anything you can't verify as "needs the actual post" — never invent
   posts, quotes, or opinions.
4. **Respond in the user's language** (Hebrew for this user), warm and concrete.

## How to call Apollo (through the gateway)

The OneCLI gateway injects the Apollo API key automatically for any request to
`api.apollo.io`. **Do NOT put any API key in the request** — just call the host.
See the `onecli-gateway` skill for how the proxy works.

### 1. Enrich a person (from a LinkedIn URL, or name + company)

```bash
curl -s -X POST "https://api.apollo.io/api/v1/people/match" \
  -H "Content-Type: application/json" \
  -d '{"linkedin_url":"https://www.linkedin.com/in/SLUG","reveal_personal_emails":false}'
```

You can also match by `{"name":"...","organization_name":"..."}` or
`{"first_name":"...","last_name":"...","domain":"company.com"}`.

Useful fields in the response (`person` / `matches[0]`): `name`, `title`,
`headline`, `seniority`, `departments`, `city`, `country`, `linkedin_url`,
`employment_history` (career path + tenure), and `organization`
(`name`, `website_url`, `primary_domain`, `industry`, `estimated_num_employees`).

### 2. Enrich the company

```bash
curl -s "https://api.apollo.io/api/v1/organizations/enrich?domain=COMPANY_DOMAIN"
```

Useful fields: `industry`, `estimated_num_employees`, `annual_revenue`,
`total_funding`, `latest_funding_stage`, `latest_funding_round_date`,
`founded_year`, `technology_names`, `keywords`, short description.

### 3. Open roles / hiring signal (opportunities before they're "jobs")

```bash
curl -s "https://api.apollo.io/api/v1/organizations/ORG_ID/job_postings"
```

(`ORG_ID` is the organization `id` from step 1 or 2.) Open roles + headcount
growth are the strongest "something is happening here" signal.

### 4. Recommended contacts inside a target company

```bash
curl -s -X POST "https://api.apollo.io/api/v1/mixed_people/search" \
  -H "Content-Type: application/json" \
  -d '{"organization_domains":["company.com"],"person_titles":["Head of","VP","Director"],"per_page":10}'
```

Use this for "who's the right person to talk to here."

> Credits: each Apollo call costs the user credits. Make the calls you need for
> the dossier (usually person + company, plus job postings when relevant) — but
> don't loop or over-fetch.

## What to produce — the Dossier

After gathering data, write a clean dossier in the user's language. Structure:

**👤 מי האדם** — name, current title + company, seniority, location, career path
in one line (from `employment_history`).

**🎯 מה כנראה חשוב לו** — inferred from role, seniority, department, company
stage. Be explicit that this is inference, not a quote.

**🏢 מה קורה בחברה** — industry, size, growth, funding, notable open roles
(from job postings). This is the opportunity radar.

**💬 רעיונות לשיחה** — 3 concrete, specific angles grounded in the data above
(a recent funding round, a role they're hiring for, a shared domain).

**✍️ טיוטות מוכנות** —
  - *הודעת חיבור* (short, personal, no pitch).
  - *רעיון לתגובה לפוסט* — only if the user pasted an actual post; otherwise say
    you need the post text and offer a template.
  - *Talking points לפגישה* if a meeting is implied.

**⚠️ מה לא ידוע** — anything Apollo couldn't give (recent posts, writing style,
personal context). Tell the user how to fill it (paste the post text, etc.).

## Saving (optional)

If the user wants to keep it, save the dossier as markdown under the workspace
`people/` folder (e.g. `people/<firstname-lastname>.md`) so it builds into a
personal relationship database over time.

## Boundaries

- No LinkedIn login, no LinkedIn automation, no password handling.
- Never fabricate posts, quotes, mutual connections, or opinions.
- If Apollo returns no match, say so plainly and offer to try name + company.
