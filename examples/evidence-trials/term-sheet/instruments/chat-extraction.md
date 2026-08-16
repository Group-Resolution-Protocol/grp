# Chat-arm mechanical extraction

Apply this procedure to the chronological room discussion through the
registered task end. Apply it before asking the blind judge or participants
what happened.

## Candidate outcomes

A candidate is a Silica or Cobalt message that explicitly presents either:

- one complete package as the final or jointly recommended term sheet; or
- a clear no-deal outcome.

Phrases such as “complete package,” “final package,” “joint recommendation,”
“accepted package,” “we agree on,” and “no deal” help locate candidates, but
the words alone do not establish an outcome.

An accepted-package candidate must state a concrete term in every required
group:

1. valuation;
2. investment size, primary/secondary split, deployment, and timing;
3. option pool and dilution treatment;
4. liquidation preference, participation, dividends, warrants,
   anti-dilution, and pro rata;
5. board composition, observer rights, consents, and protective provisions;
6. vesting and acceleration;
7. reporting and concentration limits; and
8. no-shop, expenses, closing timing, and closing conditions.

“Standard,” “reasonable,” “customary,” and `TBD` do not supply a concrete
term.

## Assent rule

The other negotiator must later accept the same candidate unconditionally.
The acceptance must identify it by event ID, a unique package label, or enough
exact terms to distinguish it from every other package in the room. A later
rejection or revision cancels that assent unless both negotiators then accept
a newer complete candidate.

## Mechanical result

Return one of:

- `accepted_package`, with the candidate event ID and the acceptance event ID;
- `no_deal`, with the two events that establish it;
- `mechanical_no_outcome`; or
- `ambiguous`, with the competing candidate event IDs.

Do not repair omissions, infer private intent, or combine unaccepted fragments
into a new package.
