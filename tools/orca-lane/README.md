# Orca lane poll

Decides, from GitHub state alone, whether an Orca bot may start or resume a ticket listed in `docs/lanes/orca/REGISTER.md`. The rules are in `docs/lanes/orca/HANDOVER.md`, section B3.

- `src/lane.ts` holds the pure logic: it parses the register, binds each ticket generation to one exact dispatch comment id, and provides an atomic claim, a token-fenced run lock (no takeover by age) and a bot-wide gate on the bot's machine.
- `src/poll.ts` is the CLI. `--mode observe` touches nothing. `--mode work` claims at most one ticket and prints a run token. `--mode check --key --token` must pass before every write. `--mode release --key --token` ends a run.
- `test/orca-lane.test.ts` holds the scenarios agreed with GPT on desk #393.
