# Removed Option A design scope

The documents and `amend-outcome.json` / `amend2-outcome.json` in this directory
are historical records only. Their unsupported/retained design obligations and
source digests describe earlier revisions, not current deliverables. See
[A12 closure](../A12-CLOSURE.md) for the current disposition.

At pre-change head `1a1f012427404c3aedde61516749dd8174519981`, the attempt had
an inert AppArmor profile, JavaScript design validator and lifecycle simulation,
eight model mutations, 17 model tests and synthetic receipt examples. These
have been removed, not promoted to production evidence. Git history retains
the exact bytes. No native static ELF, production installer, authenticated
collector, or six native production mutation controls were ever implemented.
Production confinement is systemd-run with `RestrictNamespaces=yes`; the user
namespace was a wrapper-test substitute for sudo/root, removed under Option A.
The independently useful suite-admission hardening remains in service/.
