---
name: jev
description: >-
  Call Jev (TypeSafe AI's System One model) to turn messy input into typed,
  calibrated decisions — a choice, a score, or a yes/no probability — instead of
  free text. Use it inside an agent for routing, classification, scoring,
  extraction, guardrails and gating: the small, fast, high-volume judgments that
  are too fuzzy for a hand-written `if` and too small for a frontier LLM call.
---

# Jev — typed decisions for your agent

Jev is a **decision model**, not a chat model. You give it a `state` (any messy
context) and a set of typed `questions`; it returns structured `answers` with
calibrated probabilities that your code can branch on directly. It responds in
70–500 ms, never hallucinates a format, and can't emit an invalid type because
the shape of every answer is fixed by your request.

Reach for Jev instead of another LLM call whenever you need a **fast, cheap,
typed judgment**: which tool/route, how risky, how urgent, allow or block, which
of N buckets, keep or drop.

## Endpoint & auth

```
POST https://jevtypesafeai.com/api/v1/decide
Authorization: Bearer $JEV_API_KEY        # a jv_live_... key
Content-Type: application/json
```

This is a hosted, metered proxy over the official Jev API — no TypeSafe waitlist.
Get a key at https://jevtypesafeai.com/pricing (sign in, prepay a small balance;
you're billed per input token, output is free). Store it as the environment
variable `JEV_API_KEY` and never hard-code or print it.

> Prefer the official API directly? Point the same request shape at
> `https://api.typesafe.ai/v1/systemone` with your TypeSafe key instead.

## The three question types

Every question is exactly one of these:

- **choice** — pick one of up to 255 labelled options. Give a `criteria` map of
  `{ key: "what this option means" }`. Returns the winning `choice` key,
  per-option `probabilities`, and a `confidence`.
- **score** — place the input on an ordered 2–10 level scale. Give a `criteria`
  array of level descriptions (low → high). Returns a fractional `score` plus the
  full distribution.
- **noul** — a calibrated yes/no as a probability from 0 to 1. Give only
  `instructions`. Returns `noul` (0.0–1.0). Perfect for gates and guardrails.

You can ask several questions at once; they are evaluated in parallel in one
round trip and share the `state` cost.

## Request body

```json
{
  "state": "Customer: I've been charged twice and nobody has replied for 3 days.",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Where should this go?",
      "criteria": {
        "billing": "billing, payments or refunds",
        "bug": "the product is broken",
        "account": "login or access"
      }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this?",
      "criteria": ["routine", "today", "urgent", "critical, about to churn"]
    },
    "escalate": {
      "type": "noul",
      "instructions": "Escalate to a human now?"
    }
  }
}
```

## Response

```json
{
  "answers": {
    "route":    { "type": "choice", "choice": "billing", "confidence": 1.0,
                  "probabilities": { "billing": 0.87, "bug": 0.08, "account": 0.05 } },
    "urgency":  { "type": "score", "score": 3.0,
                  "probabilities": { "0": 0.0, "3": 1.0 } },
    "escalate": { "type": "noul", "noul": 0.94 }
  },
  "usage": { "input_tokens": 62, "cost_usd": 0.000026, "credits_remaining_usd": 4.99 }
}
```

Because the types are fixed, branch with plain code and no parsing:

```
if (answers.escalate.noul > 0.7) handoffToHuman()
route(answers.route.choice)
```

## curl

```bash
curl https://jevtypesafeai.com/api/v1/decide \
  -H "Authorization: Bearer $JEV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"state":"...","questions":{"escalate":{"type":"noul","instructions":"Escalate now?"}}}'
```

## When to use it in an agent

- **Route to the right model** — score a request's complexity, send it to a fast,
  balanced, or frontier model.
- **Guardrail tool calls** — before running a shell command or editing a file,
  ask a `noul` "is this risky?" and allow / confirm / block.
- **Compact context** — for each stale tool result, a `choice` of keep / truncate
  / drop, so long sessions shrink without a lossy summary rewrite.
- **Classify & extract** — turn free text (tickets, emails, logs) into a typed
  field with one `choice`.

## Rules of thumb

- Trim the `state` to only what the decision needs — you pay per input token.
- Batch related questions into one call rather than many.
- Use `confidence` / `probabilities` to auto-handle the easy, high-confidence
  cases and escalate only the uncertain few.
- Keep the API key in `JEV_API_KEY`; never echo it into logs or the transcript.
- A `402` means the prepaid balance is empty — top up at the pricing page.

This skill and endpoint are provided by the independent site jevtypesafeai.com,
not by TypeSafe AI. For official access and source-of-truth pricing see
https://typesafe.ai.
