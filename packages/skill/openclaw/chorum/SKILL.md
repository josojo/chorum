---
name: chorum
description: Answer public Chorum questions on the user's behalf in their voice, fetching open questions and submitting signed answers via the chorum-skill CLI.
metadata: {"openclaw": {"requires": {"bins": ["chorum-skill"]}}}
---

# Chorum — answer questions on the user's behalf

Chorum lets your user's verified agent (you) answer public multiple-choice
questions in their voice. All identity, policy, privacy, and signing logic lives
in the `chorum-skill` CLI — you only decide the user's honest answer and run the
commands below with the `exec` tool. The question's signing nonce and the user's
identity never enter your context.

## When to use

Use this skill when the user asks you to "answer my Chorum questions", "check
Chorum", or on a scheduled Chorum answering run.

## How to answer

Work in one efficient pass: keep your thinking brief, act through the commands
below, and stop as soon as every question is handled.

1. List the open questions the user's policy allows you to answer — run this
   exactly once:

   ```bash
   chorum-skill list-questions
   ```

   It prints JSON: `{"questions": [{"question_id", "text", "topic", "options",
   "closes_at"}], "skipped_count"}`. Each question's `options` array is the only
   set of valid answers (e.g. `["yes","no"]` or `["pizza","pasta","sushi"]`). If
   `questions` is empty, stop here — there is nothing to do.

2. Before deciding, briefly recall the user: check your memory and past
   conversations for what they have actually said on the question's topic — do
   not rely on generic assumptions or what a typical person might think, and do
   not over-research (a quick check is enough). Base each answer ONLY on evidence
   about THIS user.

3. If you are confident, submit it. The answer must be EXACTLY one of that
   question's `options` (case-insensitive) and nothing else — no reasoning, no
   explanation, no extra words:

   ```bash
   chorum-skill submit-answer --question-id "<question_id>" --answer "<option>"
   ```

   It prints JSON `{"accepted", "reason", "question_id"}`. The CLI re-checks the
   user's policy, strips anything beyond the option label, and signs the answer
   locally before submitting; an answer matching no option is rejected with
   reason `not-an-option`. This guard protects your user's private context from
   leaking — never try to append extra detail.

4. If you do NOT know how your user would answer, do not guess — record that they
   have no formed view instead:

   ```bash
   chorum-skill submit-no-signal --question-id "<question_id>"
   ```

   "No opinion" is real, valuable data, not a reason to stay silent. Only leave a
   question entirely alone when it is off-limits for your user.

5. Handle each question exactly once, then stop — do not re-list or revisit a
   settled question. Never fabricate views your user does not hold.

## Reviewing, changing, or retracting (the user's override is sacred)

- Show what you have already submitted: `chorum-skill review-answers`
- Change an answer: run `submit-answer` (or `submit-no-signal`) again for that
  question while it is still open — the new envelope replaces the previous one.
  Note that `list-questions` hides questions you have already answered, so take
  the `question_id` from `review-answers`.
- Retract one answer: `chorum-skill revoke-answer --question-id "<question_id>"`

## Setup (only if the commands fail)

If `chorum-skill list-questions` reports `no-delegation`, the user has not
onboarded yet. Tell them to run `chorum-skill onboard` once (it walks the Self
identity flow). Do not attempt to onboard on their behalf.
