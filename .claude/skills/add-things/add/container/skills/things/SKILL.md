---
name: things
description: Manage Things 3 tasks — list, search, add, complete, or update todos. Use whenever the user asks about tasks, todos, projects, or their Things app.
allowed-tools: mcp__nanoclaw__things_list, mcp__nanoclaw__things_search, mcp__nanoclaw__things_add, mcp__nanoclaw__things_update, mcp__nanoclaw__things_delete
---

# Things 3 Integration

Things 3 runs on the macOS host. Use the `things_list`, `things_search`, `things_add`, `things_update`, and `things_delete` MCP tools — they communicate with the host via IPC and run the Things CLI there. Results are returned as JSON.

## Reading tasks

```
things_list(view="today")               # Today's tasks
things_list(view="inbox")               # Inbox
things_list(view="upcoming")            # Upcoming
things_list(view="anytime")             # Anytime list
things_list(view="someday")             # Someday
things_list(view="logtoday")            # Completed today
things_list(view="logbook")             # All completed
things_list(view="projects")            # All projects
things_list(view="areas")               # All areas
things_list(view="tags")                # All tags
```

Filters (work with most views):
- `project="Project Name"` — filter by project
- `area="Area Name"` — filter by area
- `tag="tag-name"` — filter by tag
- `search="keyword"` — substring match on title/notes
- `limit=25` — max results

## Searching

```
things_search(query="meeting notes")
things_search(query="biking", status="incomplete")
things_search(query="completed tasks", status="completed")
```

## Adding tasks

```
things_add(title="Buy milk")
things_add(title="Review PR", when="today", list="Work")
things_add(title="Read book", when="someday", tags="reading")
things_add(title="Ship feature",
           notes="See doc at...", deadline="2026-03-01",
           list="Engineering", when="tomorrow")
```

`when` accepts: `today`, `tomorrow`, `evening`, `anytime`, `someday`, `YYYY-MM-DD`

## Updating / completing / deleting tasks

Get the `uuid` field from `things_list` or `things_search` first, then:

```
things_update(id="UUID", completed=true)          # Complete a task
things_update(id="UUID", canceled=true)           # Cancel a task
things_update(id="UUID", when="tomorrow")         # Reschedule
things_update(id="UUID", notes="New notes")       # Replace notes
things_update(id="UUID", append_notes="Update")   # Append to notes
things_update(id="UUID", tags="urgent,work")      # Replace tags
things_update(id="UUID", add_tags="flagged")      # Add a tag
things_update(id="UUID", list="New Project")      # Move to project
things_delete(id="UUID")                          # Trash a task
```

## Common patterns

**Morning briefing**: `things_list(view="today")`

**Add from message**: Parse user intent → `things_add(title="...", ...)` → confirm.

**Find and complete**: `things_search(query="...")` → get uuid → `things_update(id="...", completed=true)`

**Move to someday**: `things_update(id="...", when="someday")`
