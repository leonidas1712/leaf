# Leaf agent guide

Read `AGENT-CONTROL.md` before operating or changing Leaf.
Use `leaf` for lifecycle, durable workspace, and navigation actions.
Default to Chrome for this user's visible reader.
Do not claim browser success from a `saved` result. Require `applied` and inspect the returned state or visible browser when needed.
All connected browser views share one workspace. Select a reader only for live heading navigation.
Keep document contents and runtime credentials out of logs and committed evidence.
Keep this app independent of other application repositories.

## Development

Source lives in the checkout. Runtime state belongs outside the repository.
Run `python3 -m unittest discover -p 'test_*.py' -v` after Python changes.
Run `npm --prefix web run build` after TypeScript, React, or CSS changes.
Keep the CLI help, README, agent guide, and portable skill consistent with behavior changes.
Retain revision checks, local authentication, sanitized Markdown, and isolated Mermaid rendering.
Do not commit screenshots of private documents. Do not reset a user's saved workspace for testing.
The installer points to this checkout; restart Leaf and refresh the browser to load changes.
