# PR Sidebar

Your open GitHub pull requests, in the Firefox sidebar (and the Chrome side panel).

## Features

- **Your PRs and the ones you worked on** — anything you opened, plus anyone else's PR that has commits of yours on it (co-authored trailers count). A mention or a drive-by comment doesn't qualify. Someone else's PR shows their avatar and handle. Switch to author-only in ⚙.
- **At a glance** — title, repo, age, +/− diff size, comment count, draft state, CI pass/fail/pending (failed check names on hover), approved / changes-requested, merge queue position, conflict warnings. Refreshes every 10 seconds while visible.
- **Categories** — make an empty one from ＋ › New category, then drag PRs into it. Drag a category header to reorder; drag a PR anywhere outside a category to pull it out. Hovering a folded category while dragging opens it. Dragging a PR carries whatever is stacked on top of it. Rename, emoji, colour and delete live in the header's ⋯.
- **Epics** — drop a PR on a category header's `⭐ epic` slot (or tick Epic in its ⋯) to pin it into the header. The epic stays visible when the category is collapsed, so a fold shows the epic plus a count and a `✗ / ⚠ / ✓` summary of what's inside.
- **Stacked PRs render as a tree** — a PR based on another PR's branch nests under it, and any stack folds away with the ▾ next to its title.
- **Hotfix grouping** — backport PRs like `fix: thing (HOTFIX 2.52)` collapse into one 🔥 row under the main PR, with a failing-CI count while collapsed. The title pattern is configurable.
- **For later** — park a PR on the shelf and it drops out of the list until you want it. Pick a PR up and the header becomes a Save for later target; the archive button beside refresh counts what's parked and switches the list to the shelf. Drop on the header again to bring one back. A stack moves as one, and a parked PR keeps its category.
- **Search** — the box under the header narrows by title, repo, author or number. `/` focuses it, Escape clears it.
- **Blocked by** — mark a PR as blocked by another, picked from a dropdown. It sinks below actionable PRs with a ⛔ badge that flips to ✓ when the blocker merges; click the badge to open the blocker.
- **Notes** — attach a note to a PR, shown on hover over its 📝 badge.
- **Track someone else's PR** — ＋ › Track a PR by URL follows a PR the search doesn't return. It drops out once merged or closed.
- **Tab-aware** — the PR you're viewing is highlighted, and whatever hides it (category, stack, hotfix fold) opens. Clicking a PR focuses its existing tab instead of opening a duplicate.
- **Scoped** — optionally limit to an org (`org:your-org`) or specific repos (`repo:owner/name`).

## Privacy

Your GitHub token is stored locally in the browser and sent only to `api.github.com`. No analytics, no third-party services. See [PRIVACY.md](PRIVACY.md).

## Setup

1. Install the extension and open the sidebar.
2. Paste a GitHub token — a fine-grained token with **Pull requests: Read** (plus repo access) is safest.
3. Optionally set which PRs to show, a scope, and a custom hotfix title regex via ⚙.
