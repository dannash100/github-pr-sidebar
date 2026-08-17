# Changelog

## 1.3 — 2026-08-18

### Added

- **For later.** A shelf for PRs you don't want in the way. Pick a PR up and the header becomes a Save for later target; the ⋯ on a row does the same. The archive button counts what's parked and switches the list to the shelf. A stack moves as one, and a parked PR keeps its category.

### Changed

- Settings and the per-PR ⋯ editor now share one set of controls.
- The bar on the PR you're viewing takes its category's colour.
- Dropping a PR out of a category aims at the whole area below the list, not the sliver under the last one.

### Fixed

- CI and conflicts only refreshed when the PR itself changed, so a rerun that went green could read ✗ for hours. CI re-checks every 45 seconds, the rest every 5 minutes.
- A drag released outside the sidebar left its card stuck on screen.
- Grabbing a row by an avatar started the browser's own drag on top of ours.

## 1.2 — 2026-08-17

### Added

- **Categories.** Create an empty one from ＋ › New category and drag PRs in. Drag a header to reorder, drag a PR outside any category to pull it out, hover a folded category mid-drag to open it. Dragging a PR brings whatever is stacked on top of it. Rename, emoji, colour and delete live in the header's ⋯.
- **Epics.** Drop a PR on a category header's ⭐ slot, or tick Epic in its ⋯, to pin it into the header. It stays visible when the category is folded, alongside a count and a ✗ / ⚠ / ✓ summary of what's hidden.
- **Collapsible stacks.** Any PR with PRs stacked on it gets a ▾ next to the title, expanded by default, and a `▸ n stacked` chip when folded.
- **PRs you worked on.** Anyone else's PR that carries commits of yours (co-authored trailers count) lists alongside your own, with the author's avatar and handle. Commit authorship comes from GraphQL and is cached per PR, so a poll costs no extra requests.
- **Search box** under the header: title, repo, author or number. `/` focuses it, Escape clears it.

### Changed

- Visual pass throughout: light/dark colour tokens, tinted badge pills, sticky header, accent bar on the PR you're viewing, real empty states.
- Header is three buttons. ＋ opens a menu (New category, Track a PR by URL), then refresh and settings.
- Settings rebuilt as a labelled panel with a Which PRs switch, help text and a link for creating a token.
- Drag and drop is pointer-driven rather than HTML5: a card trails the cursor, tilts into the turn, and says what releasing will do. Drop targets ring and lift; the dropped row settles into place.
- Existing pinned groups migrate to categories on first run, keeping their emoji, colour and folded state.

### Privacy

- Avatar images for other people's PRs load from `avatars.githubusercontent.com`. No token or identifying data is attached. See [PRIVACY.md](PRIVACY.md).
