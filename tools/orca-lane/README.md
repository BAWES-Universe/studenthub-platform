# Orca lane poll

Decides, from GitHub state alone, whether an Orca bot may start or resume a ticket listed in `docs/lanes/orca/REGISTER.md`. The rules are in `docs/lanes/orca/HANDOVER.md`, section B3.

- `src/lane.ts` holds the pure logic: it parses the register, binds each ticket generation to one exact dispatch comment id, and provides an atomic claim, a bot-wide, token-fenced run lock held through execution (no takeover by age) on the bot's machine. Work mode takes the run lock before it claims, so polls are serialized.
- `src/poll.ts` is the CLI. `--mode observe` touches nothing. `--mode work` claims at most one ticket and prints a run token. `--mode check --key --token` must pass before every write. `--mode release --key --token` ends a run. `--mode recover --key` clears a lock left by a run verified stopped.
- `test/orca-lane.test.ts` holds the scenarios agreed with GPT on desk #393.
