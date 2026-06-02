# LLM Wiki

> Source: [karpathy/llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)

A pattern for building personal knowledge bases using LLMs.

This is an idea file, designed to be copied to your own LLM Agent (e.g. OpenAI Codex, Claude Code, OpenCode / Pi, etc.). Its goal is to communicate the high-level idea, with your agent building out specifics through collaboration with you.

## The Core Idea

Most interactions with LLMs and documents follow RAG patterns: upload files, retrieve relevant chunks at query time, generate answers. The knowledge is re-derived on each question with no accumulation.

The concept here differs fundamentally. Rather than just retrieving from raw documents, the LLM incrementally builds and maintains a persistent wiki — a structured, interlinked markdown collection sitting between you and raw sources. When adding new material, the LLM reads it, extracts key information, and integrates it into existing wiki pages—updating entities, revising summaries, flagging contradictions, strengthening synthesis. Knowledge compiles once and stays current rather than re-deriving on every query.

The wiki becomes a persistent, compounding artifact. Cross-references already exist. Contradictions are flagged. Synthesis reflects everything read. The wiki enriches with every source added and question asked.

You source material and ask questions; the LLM maintains everything—summarizing, cross-referencing, filing, and organizing. The LLM acts as programmer; Obsidian serves as IDE; the wiki functions as codebase.

**Applications include:**
- Personal: tracking goals, health, self-improvement
- Research: deep dives over weeks/months
- Reading: building companion wikis while progressing through books
- Business/teams: internal wikis fed by Slack, transcripts, documents
- Analysis: competitive research, due diligence, trip planning, hobby deep-dives

## Architecture

Three layers comprise the system:

**Raw sources** — immutable curated documents (articles, papers, images, data). The LLM reads but never modifies these.

**The wiki** — LLM-generated markdown directories containing summaries, entity pages, concept pages, comparisons, syntheses. The LLM owns this entirely, creating and updating pages while maintaining cross-references and consistency.

**The schema** — configuration document (e.g., CLAUDE.md) explaining wiki structure, conventions, and workflows for ingestion, querying, and maintenance. This key file transforms the LLM into disciplined wiki maintainer rather than generic chatbot.

## Operations

**Ingest:** Drop new sources into the raw collection; the LLM processes them. The agent reads sources, discusses takeaways, writes summaries, updates indexes, refreshes entity and concept pages, logs entries. Single sources might touch 10-15 wiki pages. Prefer ingesting individually while staying involved, though batch ingestion with less oversight is possible.

**Query:** Ask questions against the wiki. The LLM searches relevant pages, synthesizes answers with citations. Answers take various forms—markdown pages, comparison tables, slide decks, charts, canvas. Good answers can be filed back into the wiki as new pages—explorations compound in the knowledge base rather than disappearing into chat history.

**Lint:** Periodically health-check the wiki. Look for contradictions, stale claims superseded by newer sources, orphan pages lacking inbound links, important concepts lacking dedicated pages, missing cross-references, data gaps. The LLM suggests investigations and sources to pursue, keeping the wiki healthy as it grows.

## Indexing and Logging

Two special files help navigate the growing wiki:

**index.md** — content-oriented catalog of everything (each page with link, one-line summary, optional metadata like dates or source counts), organized by category. The LLM updates it on every ingest. When answering queries, read the index first to locate relevant pages before drilling deeper. This approach works surprisingly well at moderate scale (~100 sources, ~hundreds of pages) while avoiding embedding-based RAG infrastructure needs.

**log.md** — append-only chronological record of what happened and when (ingests, queries, lint passes). Each entry beginning with consistent prefix (e.g., `## [2026-04-02] ingest | Article Title`) becomes parseable with simple tools—`grep "^## \[" log.md | tail -5` yields last 5 entries. The log shows wiki evolution timeline and helps the LLM understand recent activity.

## Optional: CLI Tools

At scale, small tools help the LLM operate more efficiently. Search engine over wiki pages is most obvious—at small scale the index suffices, but as the wiki grows, proper search becomes necessary. qmd (https://github.com/tobi/qmd) offers local search with hybrid BM25/vector search and LLM re-ranking, entirely on-device. It includes both CLI (so LLMs can shell out) and MCP server (native tool integration). Build simpler custom search scripts as needs arise.

## Tips and Tricks

- **Obsidian Web Clipper** converts web articles to markdown for quick source collection
- **Download images locally:** Set attachment folder in Obsidian Settings, bind download hotkey. All images store locally; LLM views and references directly instead of relying on potentially broken URLs
- **Obsidian's graph view** visualizes wiki connectivity—what connects to what, hub pages, orphans
- **Marp** provides markdown-based slide deck format with Obsidian plugin integration
- **Dataview** plugin queries page frontmatter, generating dynamic tables/lists when LLM adds YAML frontmatter
- The wiki is simply a git-backed markdown directory—version history, branching, collaboration included

## Why This Works

Knowledge base maintenance's tedious part is bookkeeping, not reading/thinking: updating cross-references, keeping summaries current, noting data contradictions, maintaining consistency across pages. Humans abandon wikis as maintenance burden outpaces value. LLMs don't bore, don't forget updates, can touch 15 files in one pass. Wiki maintenance becomes nearly free.

Humans curate sources, direct analysis, ask good questions, think about meaning. LLMs handle everything else.

This relates in spirit to Vannevar Bush's 1945 Memex—personal curated knowledge stores with associative document trails. Bush's vision resembled this more than what the web became: private, actively curated, with connections between documents as valuable as documents themselves. Bush couldn't solve maintenance; LLMs handle that.

## Note

This document intentionally remains abstract, describing the idea rather than specific implementation. Directory structure, schema conventions, page formats, tooling—all depend on domain, preferences, and LLM choice. Everything is optional and modular. Pick what's useful; ignore what isn't. Your sources might be text-only (no image handling needed). Your wiki might stay small enough that index files suffice (no search engine required). You might want different output formats entirely. Share this with your LLM agent and work collaboratively to instantiate a version fitting your needs. This document's sole purpose is communicating the pattern; your LLM figures out the rest.
