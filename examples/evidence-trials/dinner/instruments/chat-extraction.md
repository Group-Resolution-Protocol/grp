# Mechanical extraction rule for Dinner chat

Apply this rule to the room timeline at the registered task end, before the
judge sees it.

A speech message is a candidate outcome only if it names exactly one frozen
restaurant-and-time plan and contains one of these case-insensitive phrases:
`dinner decision`, `the decision is`, `final decision`, `final plan`, `we have
decided`, `we decided`, `we agree on`, or `consensus is`.

The author counts as one assent. Each of the other two people must later name
the same plan and use one whole-word assent term: `agree`, `agreed`, `approve`,
`approved`, `accept`, `accepted`, `support`, `supported`, or `yes`. Negated or
conditional assent does not count. A later rejection or different plan cancels
assent until that person assents again.

The assent must refer to the candidate restaurant-and-time plan itself.
Agreement only about a fallback, reservation owner, or other downstream detail
does not count. Conditional or negating language elsewhere in the same message
does not disqualify an otherwise unconditional assent to the primary plan.

Extraction succeeds only when one candidate has valid assent from all three
and no later contradiction. Otherwise return `mechanical_no_outcome`, or
`ambiguous` if two candidates satisfy the rule without clean supersession.
