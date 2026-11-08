---
name: graphify
description: Find what connects in CRX - who calls a database function or table, what a change affects, how modules link - before broad code search. Starts with a short ripgrep recipe; Graphify's local architecture graph is an optional aid. Source and live database evidence remain authoritative.
---

# Finding connections in CRX

Use this skill for structure and connection questions, not for a simple single-file edit or as a substitute for code review.

## Who calls this database function or table? Search first

Ripgrep answers this faster and more reliably than the graph, which is often stale and holds every historical copy of each function. Run these in Bash (Git Bash), not PowerShell, which quotes these patterns differently. Replace `<name>` and `<table>`:

```bash
rg -n "\.rpc\(\s*['\"]<name>['\"]" src supabase/functions
rg -n "['\"\`]<name>['\"\`]" src supabase/functions
rg -n -i "(CREATE( OR REPLACE)?|DROP) FUNCTION( IF EXISTS)?\s+(public\.)?<name>\s*\(" supabase/migrations | sort
rg -l -i "<name>\s*\(" supabase/migrations | sort
rg -n "\.from\(\s*['\"]<table>['\"]" src supabase/functions
```

1. Direct callers from screens, hooks and Edge Functions.
2. Indirect callers that pass the name as a string, such as the offline action queue, plus tests and comments to set aside.
3. Every migration that creates or drops the function, oldest first. For each argument list, the newest file holds the latest definition, and an older overload with different arguments stays active unless a later file drops it. Read the matching definition whole, and check live read-only evidence before claiming it is what runs.
4. SQL that calls it from other functions or triggers.
5. App code that reads or writes the table.

No hits never proves "no impact" on money, inventory, database or login work: names can be built at runtime, so widen the search or check live evidence.

## Optional: the Graphify graph

For broad "how do these modules connect" questions, the graph can narrow where to read. It is local and gitignored under `graphify-out/`, covers only the operating-code corpus in `.graphifyignore`, and never sends code anywhere. Check `graphify-out/GRAPH_REPORT.md`'s build commit against `git rev-parse HEAD`, and treat the graph as stale when they differ or when operating-code or database files have uncommitted changes; refresh with `npm run graph:refresh` only when the question needs the graph. If Graphify is missing or skips, use the search recipe and source reads instead and say so. A genuine refresh or query error is a tool problem to report, not something to hide.

```bash
graphify explain "<symbol>"
graphify affected "<symbol>" --depth 3
graphify path "<page or module>" "<helper or database function>"
graphify query "what connects <concept A> to <concept B>?" --budget 1200
```

Graph edges are leads, not proof: confirm each meaningful one in current source, and always read files you will edit.

## What to report

Name the search or graph query you ran, the candidate files, and the source or live evidence that confirmed or rejected each one. When a graph result was used, give its build commit. Never present a graph-only connection as verified behavior.
