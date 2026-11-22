# 0133 — Let the repository admin bypass main on pull requests

- **Status:** accepted
- **Date:** 2026-11-22
- **Decided by:** ruling of 2026-10-26 for this repository, recorded as
  `20w-ruleset-operator-bypass-20261026` (paraphrased: add the repository
  admin role as a bypass actor in pull-request mode to ruleset `21746706`
  through the rulesets API and read the ruleset back), and the follow-up
  ruling of 2026-11-22 recorded as
  `20-watts-was-enough-ruleset-bypass-drift` (paraphrased: make that one
  update only after the temporary check removal for pull request #546 has
  been reverted, compare every other field with the snapshot taken then, and
  keep coding agents off the bypass).
- **Partly supersedes:** [0096](0096-tighten-the-live-main-ruleset-to-the-rendered-policy.md)
  point 4, only where it keeps the bypass list empty and leaves the file's
  bypass actor unwritten. Every other part of 0096 stands.
- **Authority:** repository host-settings record; no change to research
  authority, claim status or acceptance criteria.

## Context

Decision 0096 tightened ruleset `21746706`, which protects `main`, towards
[`.github/rulesets/main.json`](../.github/rulesets/main.json) as the pinned
Praetor engine renders it, and changed nothing that would loosen the live
ruleset. The file names one bypass actor that the live ruleset lacked: the
repository admin role (`RepositoryRole`, actor id `5`) in bypass mode
`pull_request`. The engine renders that actor because `.standards.yaml`
declares `review_mode: single_maintainer`. Point 4 of 0096 left it out
because adding it loosens the ruleset.

With an empty bypass list, a required check that fails on every pull request
for a reason outside the pull request also blocks the pull request that
fixes it. After the repository moved from `cordanaLLM` to `tekmora`,
`Apply pull-request metadata` failed on every open pull request, including
the fix in #546. Without a bypass actor, landing that fix meant removing the
check from the ruleset, merging, and adding it back: two extra ruleset
updates, during which every pull request could merge without the check.

The rulesets API defines bypass mode `pull_request` as bypassing rules on
pull requests only (schema `repository-ruleset-bypass-actor` in
`github/rest-api-description`). The REST reference does not list role ids;
the engine source names `5` as the id GitHub writes for the admin role.

## Decision

1. The bypass list of ruleset `21746706` holds one entry: the repository
   admin role, actor id `5`, bypass mode `pull_request`. The live ruleset
   then equals the rendered file in this field.
2. Only the human maintainer uses the bypass, and only on a pull request
   whose failing rule cannot pass for a reason outside that pull request.
   Coding agents do not use it; they merge only when GitHub reports the pull
   request mergeable without a bypass.
3. The change is one update through the rulesets API that sets only the
   bypass list, made after the #546 window is closed. A read-back must show
   the new entry and every other field equal to the snapshot taken after the
   window closed. The rest of point 5 of 0096 applies unchanged.
4. The entry is removed when `review_mode` returns to `independent`, because
   the pinned engine then renders no bypass actor.

## Consequences

- A direct push to `main` stays refused for every actor, the maintainer
  included: mode `pull_request` does not cover pushes.
- The maintainer can merge a pull request past a failing rule. The same API
  schema states that only mode `exempt` skips the bypass audit entry, so each
  use in mode `pull_request` is recorded.
- A broken required check no longer needs a temporary ruleset change, and no
  window opens in which every pull request can merge without it.
- The OpenSSF Scorecard Branch-Protection check counts administrator
  enforcement as off once a ruleset names any bypass actor (`docs/checks.md`
  in `ossf/scorecard`, commit `b62c617675f5`, read 2026-11-22). The score does
  not change now: the ruleset requires no approval, so the check's second tier
  is unmet with or without the bypass. Issue #8 tracks the stronger review
  rules; when they apply, point 4 removes the bypass actor again.
- The engine audit finds the live bypass list equal to the file.
- [`docs/repository-rule-crosswalk.md`](../docs/repository-rule-crosswalk.md)
  records the read-back.

## Alternatives considered

- **Keep the list empty and open a window per incident.** Used once for
  #546. Each incident costs two ruleset updates and lets every pull request
  merge without the removed check while the window is open.
- **Bypass mode `always`.** It would also let the admin push to `main`
  directly, past the pull-request, signature and check rules.
- **Bypass mode `exempt`.** The rules would not run for the admin at all,
  and GitHub would create no bypass audit entry.
