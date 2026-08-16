# Mechanical extraction rule for the chat arm

This rule is applied to the room timeline as it existed at the registered task
end, before an LLM judge sees it.

## Candidate outcome statement

A speech message is a candidate only if it:

1. names exactly one frozen package;
2. either lists all nine position/cash exposures or unambiguously says it is
   adopting the frozen package unchanged; and
3. contains at least one case-insensitive closure phrase from this fixed list:
   `committee decision`, `committee selects`, `the decision is`, `final
   decision`, `final package`, `approved package`, `we have decided`, `we
   decided`, or `consensus is`.

## Recorded assent

The candidate's author counts as one assent. Each of the other four seats must
post a later message that:

1. names the same package; and
2. contains at least one whole-word assent term from this fixed list: `agree`,
   `agreed`, `approve`, `approved`, `accept`, `accepted`, `support`,
   `supported`, or `yes`.

An assent does not count if the same message negates the term or conditions it
on a further unresolved change. Any later message from that seat that rejects,
reopens, or names a different package cancels its assent unless it assents
again afterward.

## Result

- If one candidate has valid assent from all five seats and no later
  contradictory candidate, extraction succeeds with that package.
- If two candidates satisfy the rule, the later one controls only if all five
  assents occur after it; otherwise extraction reports ambiguity.
- Anything else is `mechanical_no_outcome`.

The rule is intentionally strict. It does not guess that “sounds good” refers
to a particular package or infer unanimity from silence. Failure moves the
transcript to blind adjudication; it is not automatically graded as failure to
coordinate.
