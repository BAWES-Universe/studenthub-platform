# Decision 2026-10-04: drop features with no use in the last 12 months

This file records a decision already made. It adds no interpretation. Everything in quotes is copied verbatim from the project history.

## The decision

- **Who:** Khalid (user_01JGxPLv6XjfT1DYhtZsSnqn)
- **When:** 2026-10-04 13:59:57Z
- **Where:** decision card `cmsg_017YX3Qwzqx67eG7uwzZ7o6wKJNR6ebmPQnY2ioZ5PKVYz`, posted 13:59:34Z in the project thread "What StudentHub does today" (`cmsg_017YX3Qwzqx67eG7uwzZ7o6wH975j289kaMGaVS19GyjFv`). The choice is recorded at message `cmsg_017YX3Qwzqx67eG7uwzZ7o6wNhjuo8aKpur7ZhNbHcPyZp` as `option_index: 0`, `chosen_by: user_01JGxPLv6XjfT1DYhtZsSnqn`.
- **Form:** Khalid tapped an option on the card. He wrote no free text, so the card's wording below is the decision.

Card question: "Drop the features nobody used this year from the StudentHub rebuild?"

Card context: "Hermes's prod counts show no use in 12 months for: interviews, applications, chat, tickets, full-timers, evaluations, exams, staff leave/expenses/standup, email campaigns, perks, wallet, Xero, inspector login, company-sent invitations and employer team invites. The old app keeps running and keeps their data either way. Dropping them shrinks the rebuild from 76 screens to roughly 50."

Option chosen (index 0): "Drop all". Its consequence as written on the card: "The rebuild covers only what people use; any dropped item can come back later as new work."

Options not chosen: "One by one" and "Keep all".

## Features covered (exactly as listed on the card)

interviews, applications, chat, tickets, full-timers, evaluations, exams, staff leave/expenses/standup, email campaigns, perks, wallet, Xero, inspector login, company-sent invitations, employer team invites.

## Usage evidence

The evidence is Hermes's read-only usage check against live legacy prod, window 2025-10-01 to 2026-10-04, posted on SHU-213 on 2026-10-04 at 13:09:45Z. It went through Khalid's Linear key and opens "From: Hermes". Khalid also pasted the same numbers into the thread at 13:58:31Z (`cmsg_017YX3Qwzqx67eG7uwzZ7o6wNUdv75aP5EmY58YyYjyf2U`). For chat and tickets: "Chat & tickets (U-05, U-06) — 0 chat messages, 0 tickets in 12mo (last 2025-06-09 / 2024-09-10); all 12 tickets ever were candidate-opened, 0 staff-opened. **dead**".

## Later decisions that touch this one

- On 2026-10-27, Khalid set the rule "do whats best practice and dont break anything. use prod code as benchmark with no regressions". It is recorded in `contracts/decisions-2026-10-27.md`.
- Since then, several items on the list above have been rebuilt as new work (interviews, applications, full-timers and stand-up exist on main). The card allowed this: "any dropped item can come back later as new work".
- This file does not say which other items are still dropped. It only records what was decided on 10-04.

## Release matrix rows this can support

- U-05 (`/messages` conversations): "chat" is named on the card.
- U-06 (`/support` tickets): "tickets" is named on the card.
- A-21 (`/service`: conversations, tickets, voicemail records): conversations (chat) and tickets are named on the card. **Voicemail records are not named.** Khalid needs to confirm whether voicemail records are in scope before A-21 can be waived on this record alone.
