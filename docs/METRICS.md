# Compact agent-run metadata

v0.2.0 adds one optional `AI-Run` trailer. `AI-Agent` and `AI-Model` remain required; `AI-Model` must identify the actual model, not `unknown`. Run metadata is harness-supplied provenance, not proof of authorship, an analytics service, or a quality score. Do not put prompts, traces, credentials, or free-form notes in git.

## Schema 1

```text
AI-Run: <schema>|<provider>|<model>@<version>|<effort>|<in>/<max>|<out>|<session>|<task>
```

Example footer:

```text
AI-Agent: hermes-coder
AI-Model: claude-sonnet-4.5
AI-Run: 1|anthropic|claude-sonnet-4.5@20250901|h|18234/200000|2510|ses_01K8|feat-auth
```

| Column | Rule |
| --- | --- |
| 1: schema | Exactly `1` |
| 2: provider | `anthropic`, `openai`, `github-copilot`, `local`, or `other` |
| 3: model@version | Model must match `AI-Model`; version is `[A-Za-z0-9._-]+` or `unknown` |
| 4: effort | `l`, `m`, `h`, or `x` for low, medium, high, or max |
| 5: in/max | Two nonnegative decimal integer counts, each independently allowed to be `-` |
| 6: out | Nonnegative decimal integer count or `-` |
| 7: session | Opaque `[A-Za-z0-9._-]{1,64}` identifier |
| 8: task | Opaque `[A-Za-z0-9._-]{1,64}` identifier |

Use `-` as the missing-value sentinel for provider, effort, counts, session, and task. It is not another provider or effort level. A missing version is `unknown`, giving `<model>@unknown`. A missing model is not a metadata slot: the publisher refuses to create an agent commit without the actual model id.

Keep all eight columns, with no spaces around `|`. Model ids are single-line tokens starting with a letter or digit and may contain letters, digits, `.`, `_`, `-`, `:`, `/`, or `+`, including a provider path such as `owner/model`. Placeholders and whitespace, `|`, `@`, or backticks are invalid. No field supplied by the harness may contain a pipe. Session and task identifiers must not contain personal data or secrets.

Parsers ignore extra trailing `|fields` for forward compatibility. Unknown unrelated trailer keys are ignored. When a schema-bearing `AI-Run` is present, invalid columns 1-8 cause a parse error; unsupported schemas are errors too. An absent or empty `AI-Run` has no schema and produces no record. Extra fields do not rescue invalid known columns. There is no `AI-X-*` family or additional YAML document.

## Harness environment

Export only values actually reported by the harness before invoking [agent-pr.mjs](../scripts/agent-pr.mjs). The helper does not read `.env`, infer a provider from a model, estimate token counts, or generate session/task IDs.

| Environment variable | Stored value | When missing |
| --- | --- | --- |
| `AI_PROVIDER` | Provider from the allowed list | `-` |
| `AI_MODEL` | Required `AI-Model` and model part of column 3 | Supply `--model` or publishing exits `2` |
| `AI_MODEL_VERSION` | Version token in column 3 | `unknown` |
| `AI_EFFORT` | `low`/`l` -> `l`, `medium`/`m` -> `m`, `high`/`h` -> `h`, `max`/`x` -> `x` | `-` |
| `AI_CONTEXT_USED` | `in` | `-` |
| `AI_CONTEXT_MAX` | `max` | `-` |
| `AI_CONTEXT_OUT` | `out` | `-` |
| `AI_SESSION` | Session identifier | `-` |
| `AI_TASK` | Task identifier | `-` |

`--model` takes precedence over `AI_MODEL`; both the required trailer and `AI-Run` use the selected model. The publisher exits `2` if neither supplies a valid model id; it never invents one. If all nine variables are unset or empty, no `AI-Run` is written, even with `--model`. `AI_MODEL` alone counts as environment input. With run input and a known model, missing slots use sentinels. Do not invent identity information just to emit a record. Malformed supplied values, including an unknown effort, are rejected before key access or GitHub requests.

For example, `AI_PROVIDER=local` with `--model gpt-5` produces `1|local|gpt-5@unknown|-|-/-|-|-|-`. Model-only input `AI_MODEL=known-model` produces `1|-|known-model@unknown|-|-/-|-|-|-`. Counts of zero stay `0`, not `-`. The `unknown` suffix is a missing model **version**, not a missing model id.

## PR body

When run metadata is present, the publisher upserts exactly this two-line pair:

```text
<!-- agent-run:1 -->
`1|anthropic|claude-sonnet-4.5@20250901|h|18234/200000|2510|ses_01K8|feat-auth`
```

There is no closing marker or second document. An existing `<!-- agent-run:1 -->` pair is replaced; duplicates are collapsed to one pair. Other PR body text is retained. For an existing PR, the helper reads the current body and verifies the branch and head SHA before updating it. A new draft PR receives the pair at creation. When no run metadata is supplied, the helper does not modify existing PR metadata.

The commit receives one `AI-Run` footer line; the PR body receives the tagged pair rather than another copy of that footer line. Evaluation comments are separate from both.

## Validate and export locally

The default [trailer checker](../scripts/check-agent-trailers.mjs) still checks only `AI-Agent` and `AI-Model`. Opt in to requiring a valid, model-matching run trailer on agent-classified commits:

```bash
node scripts/check-agent-trailers.mjs --require-run --message-file path/to/message.txt
node scripts/check-agent-trailers.mjs --require --require-run --message-file path/to/message.txt
```

`--require-run` alone does not classify an unmarked human commit as an agent commit. Combine it with `--require` to check every message. The default PR workflow and its permissions are unchanged.

The [message parser](../scripts/parse-agent-run.mjs) and [history exporter](../scripts/export-agent-metrics.mjs) print JSONL to standard output, with one object per commit containing run metadata:

```bash
node scripts/parse-agent-run.mjs --message-file path/to/message.txt
node scripts/export-agent-metrics.mjs
node scripts/export-agent-metrics.mjs --ref main..HEAD
```

```json
{"sha":"0123456789abcdef0123456789abcdef01234567","agent":"hermes-coder","model":"claude-sonnet-4.5","schema":1,"provider":"anthropic","model_version":"20250901","effort":"h","context_used":18234,"context_max":200000,"context_out":2510,"session":"ses_01K8","task":"feat-auth"}
```

The message parser accepts `--message TEXT` instead of `--message-file`, plus an optional full `--sha`; without it, `sha` is `null`. The history exporter reads only local Git history, defaults to `HEAD`, and emits oldest first. Neither fetches from GitHub or exports commit bodies, prompts, traces, unknown fields, or evaluations.

JSON uses `null` for `-` sentinels, integer numbers for counts, and a string for `model_version`, including `unknown`. Integers beyond JavaScript's safe range remain decimal strings instead of being rounded. Commits without metadata are skipped. A malformed record fails export without partial output. Exit codes are `0` for success or no records, `1` for metadata/history errors, and `2` for usage or message-file input errors. Both commands support `--help`.

When vendoring the checker or publisher, include `scripts/parse-agent-run.mjs` as well as their existing dependencies. The read-only exporter is optional. See [adopt.md](adopt.md).

## Human evaluation comments

A human may leave this separate PR comment:

```text
AI-Eval: 1|accept|3|n
```

This documents a human comment format only. `accept` is the human's decision; the remaining values are not interpreted or assigned a scoring scale by v0.2.0. The publisher must not generate `AI-Eval`, post evaluation comments, or add an evaluation trailer. Humans evaluate via comments, not by rewriting commit trailers. The parser and exporter do not process these comments or calculate quality scores.