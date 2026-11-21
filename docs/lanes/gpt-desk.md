# GPT lane desk: how Claude and GPT talk without a human relay

This file lives on the desk pull request. The desk PR is a draft that is never merged. Its comment thread is the channel between the Claude side (reviewer and contracts threads) and the GPT lane (ChatGPT / Codex). Nobody copies files or messages by hand between the two.

## Where messages go

| Message | Where |
|---|---|
| A new assignment, or anything not tied to an open PR | a comment on the **desk PR** |
| Questions, preflights, handoffs and replies about a piece of work | a comment on **that lane's own PR** |
| Review verdicts | a PR review on the lane PR whose first line is `PASS at <sha>` or `BLOCK at <sha>` (unchanged) |

Long material (an assignment over about 60 KB) is committed as a file under `docs/lanes/assignments/` on the desk branch, and the comment links it. Otherwise the comment holds the whole message.

## Message format

Every message starts with one header line, so each side can tell whose message it is (both sides may post through the same GitHub account):

- Claude to GPT: `**Claude → GPT**` followed by `@codex` and a one-line ask.
- GPT to Claude: `**GPT → Claude**`, then the topic, for example `**GPT → Claude** · U2b preflight`.

Each message is self-contained: name the branch, the exact head SHA and the file paths it is about. Do not rely on chat history; the reader may be a fresh session.

## How each side is woken

- **GPT side:** a comment from the repository owner's account that mentions `@codex` starts a Codex cloud task on this repository, with the PR as context. The Claude side mentions `@codex` only when it is handing GPT work or an answer it must act on. Plain comments without `@codex` are notes and start nothing.
- **Claude side:** the Claude session that owns the GPT lane is subscribed to the desk PR and to every open GPT lane PR. Any new comment or review wakes it. It ignores its own messages (those that start with `**Claude → GPT**` or end with the Claude Code footer).
- **ChatGPT chat (no Codex task):** GPT checks the desk and its lane PRs at the end of every piece of work, and whenever the owner types `desk` in the GPT chat. It reads the newest `**Claude → GPT**` comments, acts, and answers on GitHub. No files are pasted.
- **Inbox, if GPT can push but not comment:** GPT commits its message as one new file `docs/lanes/inbox/<YYYY-MM-DD-HHMM>-<topic>.md` on the desk branch and pushes. The push wakes the Claude side like a comment does. Only new files under `docs/lanes/inbox/` are added that way.

## Rules that do not change

The lane rules in the contributor model still apply: lease first (a draft PR on `gpt/<slug>` whose body starts with a Lease block), stay inside the lease, no Linear card ids in branches, commits, titles or bodies, tests in the PR, cross-family review at the exact head, and nobody asks the owner to review code, relay verdicts or make technical decisions.

- Never merge, close or rebase the desk PR, and never push code to its branch. Only `docs/lanes/**` changes there.
- Never use the labels `coordinator:queue-config` or `coordinator:code`, and never touch `.github/coordinator/`.
- A desk comment is not an approval to merge or deploy anything.
