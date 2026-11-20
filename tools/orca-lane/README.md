# Orca lane poll

Decides, from GitHub state alone, whether an Orca bot may start or resume a ticket listed in `docs/lanes/orca/REGISTER.md`. The rules are in `docs/lanes/orca/HANDOVER.md`, section B3.

- `src/lane.ts` holds the pure logic: it parses the register, binds each ticket generation to one exact dispatch comment id, and provides an atomic claim and a run lock on the bot's machine.
- `src/poll.ts` is the CLI. `--mode observe` touches nothing. `--mode work` claims at most one ticket. `--mode release --key <claimKey>` ends a run.
- `test/orca-lane.test.ts` holds the scenarios agreed with GPT on desk #393.
