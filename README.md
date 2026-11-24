# pi-flex-review

`pi-flex-review` is a [Pi](https://pi.dev/) extension for independent code review by an agent,
following [Pi’s minimalist design philosophy](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/).

Adapted from
[Earendil’s `pi-review`](https://github.com/earendil-works/pi-review),
it preserves the idea of independent reviews within the same Pi session,
replaces predefined review modes with free-form requests,
and lets you choose the reviewer’s conversation context.

## Install

```bash
pi install git:github.com/grothesque/pi-flex-review
```

## Starting a review

Give the reviewing agent any free-form request:

```text
/review last two commits
/review src/integrator.rs, focusing on numerical stability
/review --fresh changes since origin/main
/review --resume Are you satisfied?
```

A plain `/review` is equivalent to `/review uncommitted changes`.
The optional `--fresh` or `--resume` must come first.

## Choosing the reviewer’s context

- **No option:** choose a conversation point with the familiar `/tree` selector,
  retaining earlier requirements, discussions, or implementation context.
- **`--fresh`:** start before the first user message, without prior discussion.
- **`--resume`:** continue where the last `/end-review` in the current conversation left the reviewer,
  for example to reassess fixes with the previous findings in mind.

## Review methodology

The review instructions focus on **correctness, elegance, and consistency**,
without assuming any particular application domain.
They apply equally to code and other project material.

Custom review instructions in `REVIEW_GUIDELINES.md` are discovered like `AGENTS.md`
and included in the review request.
For example, to give extra emphasis to project guidance kept in `AGENTS.md`,
a project’s `REVIEW_GUIDELINES.md` could contain:

```markdown
As part of the requested review, check adherence to the applicable guidance in `AGENTS.md`.
```

## Ending a review

Finish a review with:

```text
/end-review
```

You can then return only, return + summarize, or return + queue fixing work.
