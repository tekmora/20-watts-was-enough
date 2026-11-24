# 0134 — Report the Stage-0 conditions per mechanism

- **Status:** accepted
- **Date:** 2026-11-24
- **Decided by:** the coordination order recorded as
  `rank-dispatch-20261124-0937-20-watts-was-enough` (2026-11-24; paraphrased:
  take the next unit of milestone M0 from the ranked frontier); issue #481.
- **Authority:** `research/stage0-conditions.md`, its generator
  `scripts/generate-stage0-conditions.mjs` and the rules in
  `scripts/lib/stage0-conditions.mjs`. The report records operational progress
  only. No claim, principle, candidate, fixture or status changes.
- **Related:** [0089](0089-publish-a-derived-mechanism-index.md)

## Context

The [research roadmap](../concept/90-research-roadmap.md#stage-0--evidence-synthesis-and-contracts)
lists seven conditions that complete Stage 0 for one mechanism. It names the
[domain inventory](../research/domain-inventory.md) and the
[adoption matrix](../research/adoption-matrix.md) as the files that expose how
far each mechanism has come, but neither file states the seven conditions per
mechanism. Issue #481 asks for one table that does.

The facts behind the conditions already sit in authored files: claim sources
and chapter links in `research/claims.md`, claim links in the concept
chapters, bundles in `research/principle-registry.md`, and protocol headings
in the experiment files audited into `experiments/test-coverage.json`. A
hand-filled table would copy those facts and drift from them at the next
ledger edit.

## Decision

1. Generate `research/stage0-conditions.md` with
   `npm run generate:stage0-conditions` from the adoption matrix, the domain
   inventory, the claim ledger, the principle registry,
   `research/references.bib`, `experiments/test-coverage.json` and every
   `concept/*.md` chapter. One report row is one adoption-matrix row, in matrix
   order.
2. Each condition cell takes one of three states:
   - `holds`: the structural rule for that condition passed;
   - `gap`: the rule failed, and the evidence names what is missing;
   - `open`: no repository check decides the condition.
3. The rules, each with its limit stated in the report:

   | # | Rule | Limit |
   | --- | --- | --- |
   | 1 | a row claim names at least one primary-source key that exists in `research/references.bib` | scope of the claim is not judged |
   | 2 | the *What already exists* cell is not a placeholder | presence, not nearness |
   | 3 | a row claim sits in a `P-` bundle, or a row experiment link is a held candidate | none |
   | 4 | `gap` when no row claim lists a concept chapter under *Used by* and no concept chapter links a row claim; otherwise `open` | no check reads chapter content |
   | 5 | `holds` when the condition-4 chapters contain no equation; otherwise `open` | no symbol or unit check exists |
   | 6 | an experiment artifact routed to a row claim, or linked from the row, has comparator, ablation, measurement and failure headings | headings only |
   | 7 | no row cell and no primary-source field of a row claim links into `sources/` | links only |

4. A concept chapter counts for condition 4 in either direction: a row claim
   lists it under *Used by*, or it links a row claim through
   `../research/claims.md#c-N`, ranges included. Many chapters cite a claim
   without the claim listing the chapter back; reading only *Used by* marked
   49 of 81 mechanisms as having no chapter, against 7 with both directions.
   Every input file is read as Markdown: reference-style links count like
   inline links, and links inside code spans or fenced code do not count.
   The parser leaves a reference whose label has no definition as plain
   text, so the generator also fails on reference syntax left in text: a
   `][label]` or `][]` junction, or a bracketed claim id such as `[C-005]`.
5. A mechanism maps to the domain-inventory rows that share one of its
   condition-3 bundles. A bundle cell names single principles or inclusive
   ranges such as `P-005--P-010` or `P-001–P-013`; each range counts every
   principle it spans. The wider-horizon table has no bundle column and is
   not mapped; the report states how many of its rows were skipped.
6. `npm run validate:stage0-conditions` regenerates the report in memory and
   fails when the committed file is missing or stale. It runs in `npm test`,
   `check:full-without-workstation` and `check:lane-research`. The generator
   fails closed on unknown table headers, unknown claims in the matrix or a
   chapter, unknown bibliography keys, unknown inventory states, reversed
   claim or principle ranges, reference-style links without a definition,
   coverage artifacts whose `missingFacets` is not an array of declared
   protocol facet ids, input files above 8 MiB, more than 200 chapter files
   and a report above 2 MiB.
7. A cell that holds passed a structural check. It promotes no claim and is
   no scientific result.
8. Each condition with at least one `gap` row gets its own issue that lists
   the affected mechanisms. Conditions 4 and 5 share one issue for the
   missing content check.

## Consequences

- Editing a matrix row, a claim's primary-source or *Used by* field, a
  principle bundle, a held candidate, an inventory row, an experiment's
  protocol headings, or a chapter's claim links or equations can make the
  report stale; the freshness check names it.
- Conditions 4 and 5 stay `open` for every mechanism with a chapter until a
  check reads chapter content. The report says so rather than marking them
  met.
- Condition 6 inherits the heading patterns of
  `scripts/audit-test-coverage.mjs`, including its failure pattern that also
  matches promotion headings.
- The primary-source label list includes *Primary and authoritative sources*,
  which the label list of `tooling/internal/docscheck/check.go` does not read
  yet, so keys under that label are checked here first.

## Alternatives considered

- **A hand-written table in the issue or the roadmap.** No generator, but it
  goes stale at the first ledger edit and nothing detects it.
- **Seven new columns in the adoption matrix.** One file, but it mixes authored
  dispositions with derived state and multiplies churn in an authored table.
- **New fields in `research/mechanism-index.json`.** Reuses a generator, but
  the issue asks for a readable table, and Decision 0089 admits new index
  content only for a named consumer.

## Verification and disclosure

`scripts/generate-stage0-conditions.test.mjs` covers a valid tree, a removed
report, a tampered report, a changed disposition, a renamed matrix header, an
unknown matrix claim, a new chapter link to a row claim, an unknown chapter
claim, an unknown argument and an oversized claim ledger, plus unit cases for
claim ranges, chapter claim links and each condition rule. With the chapter
links dropped from condition 4, the condition-4 unit case and the freshness
check fail. Antigravity (Gemini 4 Carbon) drafted the generator and tests
under a specification by Claude Code; Claude Code reviewed the draft, added
the chapter-link direction, wrote this record and ran the checks on the
workstation. Automated tests describe the exercised boundaries, not
independent scientific review.
