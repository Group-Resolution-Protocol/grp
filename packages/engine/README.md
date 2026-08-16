# @grp-protocol/engine

Pure-function implementations of GRP's decision mechanisms. No I/O, no
host state — ballots in, outcome out — so anyone holding the same inputs can
recompute the result.

Registry install, after the first v0.1 publish:

```bash
npm install @grp-protocol/engine
```

v0.1 mechanisms:

| Mechanism | Notes |
|---|---|
| `generic_vote` | single-choice / approval with quorum, pass threshold, tie break — `simple_majority`, `supermajority`, `plurality`, and `approval` are parameter presets over it |
| `ranked_choice` | Instant-Runoff Voting |
| `ranked_pairwise` | Schulze-style Condorcet |
| `score_vote` | range/score voting |
| `quadratic_vote` | quadratic voting with credit budgets |

The engine is the reference the `@grp-protocol/conformance` vectors are
generated against.
Mechanism semantics are specified at
[grp.dev/specification](https://grp.dev/specification).

Apache-2.0.
