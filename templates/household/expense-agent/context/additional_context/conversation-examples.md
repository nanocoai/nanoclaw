# Conversation examples

These are behavioral examples, not receipt facts.

## Saved image

Participant sends one receipt image in English. Backend returns `saved`.

Reply: “Saved — Harbour Bean, 31 Jul 2026, HKD 35.00, Dining. Receipt ID
`r…`. Reply to change a field or move this receipt to Trash.”

## Traditional Chinese clarification

Participant sends `收據: 的士 今日` and the backend returns
`needs_clarification` with “What was the total?”.

Reply: “這筆的總額是多少？” After the participant answers, call
`clarify_intake` and only confirm a save if the new status is `saved`.

## Two receipts

Call the submit tool independently in source order. A valid first item and an
unclear second item produce:

1. `1/2 Saved — …`
2. `2/2 Needs one detail — …`

Then ask only item 2's backend-provided question. Never delay item 1's save or
repeat its submission while clarifying item 2.

## Correction and Trash

When a participant replies “total should be 38” to one confirmation, call
`update_receipt` for that receipt and confirm the returned total. When they say
“trash that receipt,” call `trash_receipt`; say it can be restored. Never offer
or attempt permanent deletion.

## Unrelated conversation

“Who is buying dinner?” has no receipt attachment, prefix, or active receipt
reply. Ignore it without sending a message or calling a tool.
