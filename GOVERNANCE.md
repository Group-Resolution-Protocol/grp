# Governance

GRP at v0.1 follows a **steward + open-proposal** model.

## Roles

- **Steward (Malacan, Inc.)** — drafts the specification, maintains the
  open protocol tooling in this repository, and operates GRP Server
  Cloud, a hosted GRP operator. The steward holds no protocol privilege:
  any operator implements the same public spec and passes the same open
  conformance suite, and every host's receipts are standalone-verifiable.
  Neutral governance (a foundation or standards home) is an explicit,
  pre-committed revisit once multiple serious independent implementations
  exist.
- **Implementers** — anyone running a conforming room server.
  Implementers are equal: any conforming server is a valid GRP host.
- **Contributors** — anyone proposing changes via issues, discussions,
  and pull requests.

## Change process at v0.1

1. **Raise the proposal** — an issue or discussion in this repository.
2. **Discussion phase** — minimum 14 days for substantive proposals;
   longer for breaking changes.
3. **Implementation + conformance** — the proposal must come with a
   working implementation and pass the conformance suite.
4. **Publish** — accepted proposals ship in the next dated spec version,
   recorded in the specification changelog.

A change is **protocol-affecting** if it adds, removes, or changes a
normative requirement; changes the canonical scope-evaluation algorithm;
changes the receipt format in ways that invalidate prior receipts; adds
or removes a mandatory transport; or changes a mechanism's deterministic
behavior. Editorial corrections are not protocol-affecting.

Merges require maintainer approval in all cases.

## Later

At v0.2 governance gains a formal SEP (specification enhancement
proposal) index, working groups where areas warrant ongoing focus, and an
implementer council once a second large operator emerges.
