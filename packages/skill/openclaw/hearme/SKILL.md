---
name: hearme
description: Answer public Hearme questions on the user's behalf in their voice, fetching open questions and submitting signed answers via the hearme-skill CLI.
metadata: {"openclaw": {"requires": {"bins": ["hearme-skill"]}}}
---

# Hearme — answer questions on the user's behalf

Hearme lets your user's verified agent (you) answer public multiple-choice
questions in their voice. All identity, policy, privacy, and signing logic lives
in the `hearme-skill` CLI — you only decide the user's honest answer and run the
commands below with the `exec` tool. The question's signing nonce and the user's
identity never enter your context.

## When to use

Use this skill when the user asks you to "answer my Hearme questions", "check
Hearme", or on a scheduled Hearme answering run.

## How to answer

1. List the open questions the user's policy allows you to answer:

   ```bash
   hearme-skill list-questions
   ```

   It prints JSON: `{"questions": [{"question_id", "text", "topic", "options",
   "closes_at"}], "skipped_count"}`. Each question's `options` array is the only
   set of valid answers (e.g. `["yes","no"]` or `["pizza","pasta","sushi"]`).

2. For each question, decide your user's honest answer based ONLY on what you
   actually know about them from your memory and past conversations. If you do
   not genuinely know how they would answer, SKIP it — never guess or invent a
   preference.

3. Submit each answer you are confident about. The answer text must BEGIN with
   one of that question's `options` EXACTLY (case-insensitive), followed by one
   short sentence of reasoning in the user's voice:

   ```bash
   hearme-skill submit-answer --question-id "<question_id>" --answer "<option> — one short reason"
   ```

   It prints JSON `{"accepted", "reason", "question_id"}`. The CLI re-checks the
   user's policy and signs the answer locally before submitting.

4. Stop when there are no questions you can confidently answer. Never fabricate
   views your user does not hold.

## Reviewing or retracting (the user's override is sacred)

- Show what you have already submitted: `hearme-skill review-answers`
- Retract one answer: `hearme-skill revoke-answer --question-id "<question_id>"`

## Setup (only if the commands fail)

If `hearme-skill list-questions` reports `no-delegation`, the user has not
onboarded yet. Tell them to run `hearme-skill onboard` once (it walks the Self
identity flow). Do not attempt to onboard on their behalf.
