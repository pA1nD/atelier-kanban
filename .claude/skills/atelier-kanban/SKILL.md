---
name: atelier-kanban
description: Track and coordinate work on the local Atelier kanban board via HTTP. Use this skill when the user asks you to pick up a task, mark something in progress, move a card to done, create a new task for yourself or another agent, report being blocked, hand off work, read existing board context, or coordinate with other agents through the board. Also triggers when the user mentions Atelier, the kanban board, spaces, sprint status, or "what's on the board".
scope: global
---

# Atelier Kanban

You have access to a local Atelier kanban board that persists across agents. You coordinate with other agents — and with the user — by creating and moving cards on this board. This skill tells you how.

## Entry point

The installed Atelier always listens at **`http://atelier:1844/`** (mapped to `127.0.0.1` in `/etc/hosts` by `atelier install`). That's the default.

Set `$URL` with this one-liner and use it for every API call:

```bash
URL=${ATELIER_URL:-http://atelier:1844}
```

If someone has exported `ATELIER_URL` in their shell (e.g. while iterating against a dev server), it wins — otherwise you hit production. If `curl -sI "$URL/"` fails, Atelier isn't running at that URL — surface that to the user rather than guessing.

For the rest of this skill, assume `$URL` is resolved as above.

## The spaces model

A kanban board is partitioned into **spaces** — scoped sub-boards like `apprentice`, `design-system`, `ingest`. Every card belongs to exactly one space. You mostly work in one space at a time; cross-space coordination happens card by card (re-POST under a new URL).

**There is no endpoint to list all cards across all spaces.** This is intentional — it keeps the board from becoming a firehose of context. Always scope your reads to one space.

Spaces carry just a name (kebab-case, e.g. `apprentice`) and a short description. Tags (`perf`, `design`, `color`) are free-form keywords layered on top; use tags for cross-cutting themes, spaces for territories.

## Read: what's on the board

**List spaces:**

```bash
curl -s "$URL/api/kanban/spaces"
```

Returns a markdown list of spaces with card counts. Pick the one you care about.

**Read a space's cards:**

```bash
curl -s "$URL/api/kanban/spaces/apprentice/cards"
```

Returns multi-document markdown — one frontmatter-body block per card, separated by bare `---` lines.

Example output:

```markdown
---
id: atl-214
col: doing
title: wire realtime metrics to the dock strip
agent: ada
tags: [metrics, realtime]
progress: 62
created_at: 2026-04-23T10:15:00Z
updated_at: 2026-04-23T14:02:11Z
---

started pprof. memory stable but goroutine count climbing.

- [x] reproduce locally
- [ ] find the leak
```

Read the notes; they're where previous agents (and humans) left context. **Before picking up a card, read it.**

## Write: one markdown payload, any number of cards

Every write is a POST to either `/api/kanban/spaces` or `/api/kanban/spaces/<name>/cards`. The body is a markdown document with one or more frontmatter-body blocks.

**Rules:**
- `id: atl-NNN` present → update existing card. Only the fields you include change; omitted fields keep their current value. The body **replaces** the current notes (no merge).
- `id:` absent → server creates a new card and assigns `atl-NNN`.
- `col:` must be one of `todo`, `doing`, `needs`, `done`, `archive`.
- `tags:` is `[a, b, c]`. `agent:` is a free-form string (typically a name like `ada`, `operator`).
- `created_at` and `updated_at` are server-owned; any values you pass are ignored.
- A bare `---` line separates cards. **Horizontal rules inside card notes must use four or more dashes (`----`)**.

## Create a space (explicit)

Spaces must be created before you write cards into them. POST to a nonexistent space returns 404.

```bash
curl -X POST --data-binary @- "$URL/api/kanban/spaces" <<'EOF'
---
name: apprentice
---
work on the apprentice runtime
EOF
```

Reuse existing spaces where you can. Create a new space only when starting work that doesn't fit any existing one.

## Create / update cards

**One card:**

```bash
curl -X POST --data-binary @- "$URL/api/kanban/spaces/apprentice/cards" <<'EOF'
---
col: todo
title: investigate cold start latency on apprentice
agent: ada
tags: [perf, bootstrap]
---
first pass: profile startup from nothing → first tool call. focus on module graph.
EOF
```

**Many cards in one request:**

```bash
curl -X POST --data-binary @- "$URL/api/kanban/spaces/apprentice/cards" <<'EOF'
---
id: atl-214
col: doing
progress: 80
---
got the sparklines wired. moving to density pass.

---
col: todo
title: collapse toggle for metrics strip
agent: ada
tags: [ui, metrics]
---
follow-up from atl-214.
EOF
```

## Lifecycle verbs

**Pick up a todo:**

```bash
curl -X POST --data-binary @- "$URL/api/kanban/spaces/apprentice/cards" <<'EOF'
---
id: atl-215
col: doing
agent: ada
progress: 10
---
picked up. starting with a repro in isolation.
EOF
```

**Report progress:**

```bash
curl -X POST --data-binary @- "$URL/api/kanban/spaces/apprentice/cards" <<'EOF'
---
id: atl-215
progress: 45
---
narrowed the slow path to plugin-graph traversal. writing a cache.
EOF
```

**Blocked — needs input from another agent or the user:**

```bash
curl -X POST --data-binary @- "$URL/api/kanban/spaces/apprentice/cards" <<'EOF'
---
id: atl-208
col: needs
question: sqlite in-process vs. postgres over loopback?
---
both work. sqlite wins on simplicity; postgres on concurrent writes. waiting for the call.
EOF
```

**Hand off to another agent:**

```bash
curl -X POST --data-binary @- "$URL/api/kanban/spaces/apprentice/cards" <<'EOF'
---
id: atl-215
col: needs
agent: drafter
question: design review on the new loading state — does this match the lexicon?
---
screenshot attached in notes. ping me when reviewed.
EOF
```

**Finish:**

```bash
curl -X POST --data-binary @- "$URL/api/kanban/spaces/apprentice/cards" <<'EOF'
---
id: atl-215
col: done
progress: 100
---
shipped. 40% reduction in cold start. before/after in the notes above.
EOF
```

## Move a card between spaces

Re-POST the card (by id) under the target space's URL. The server relocates it.

```bash
# move atl-220 from apprentice to design-system
curl -X POST --data-binary @- "$URL/api/kanban/spaces/design-system/cards" <<'EOF'
---
id: atl-220
---
EOF
```

## Append vs replace notes

The body of a card POST **replaces** the current notes. If you want to add a note without losing history:

1. GET the card to see its current notes.
2. Append your addition locally.
3. POST the full notes back.

Short script pattern:

```bash
CURRENT=$(curl -s "$URL/api/kanban/spaces/apprentice/cards" | awk '/^---$/{c++} c==2,/^---$/{next} c>=3')
# … append to $CURRENT, then POST it back with the same id
```

(In practice, write the full new notes directly when you know what they should say.)

## Conventions

- **One focused space per session.** Start by reading your space; don't poll others unless you specifically need cross-space context.
- **Tags are keywords, not categories.** Use them liberally; they cost nothing.
- **Questions go in `question:`, not in notes.** That's what the UI + other agents scan for when looking at `needs` cards.
- **Don't recreate cards.** If work on a topic exists, update the existing card. Ids are the stable reference.
- **Notes are markdown.** Write checklists, code blocks, links. Other agents will read them.

## If something fails

- `404 space 'X' does not exist` — create it first with `POST /api/kanban/spaces`.
- `400 invalid col` — use `todo | doing | needs | done | archive`.
- `400 parse error` — check your frontmatter syntax. Bare `---` inside a body will be misread as a card separator.
- Cards in the wrong space — re-POST under the right URL.
