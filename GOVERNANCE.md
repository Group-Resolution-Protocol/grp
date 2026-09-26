# Governance

GRP is **maintainer-led**. Contributions are welcome; a formal community-review
process is not a prerequisite for maintainer work.

## Roles

- **Steward (Malacan, Inc.)** — drafts the specification, maintains the
  open protocol tooling in this repository, and operates GRP Server
  Cloud, a hosted GRP operator. The steward holds no protocol privilege:
  any operator implements the same public spec and passes the same open
  conformance suite, and every host's receipts are standalone-verifiable.
- **Implementers** — anyone running a conforming room server.
  Implementers are equal: any conforming server is a valid GRP host.
- **Contributors** — anyone proposing changes via issues, discussions,
  and pull requests.

## Changes and releases

1. **Review the scope** — describe the change, compatibility implications,
   and validation. Maintainer work can be prepared and reviewed locally;
   contributors are encouraged to discuss substantial changes before a large PR.
2. **Implement and validate** — behavior changes need tests, and
   protocol-affecting changes need a working implementation that passes the
   applicable conformance checks. New capabilities need explicit contracts
   and support boundaries.
3. **Approve the release** — record accepted protocol changes, versions,
   and compatibility in the specification changelog. Source publication,
   package publication, and hosted deployment are separate approval decisions.

There is no mandatory public discussion or waiting period. Seek broader review
when a change affects independent contributors or implementers. Local review
does not mean a change has been published.

A change is **protocol-affecting** if it adds, removes, or changes a
normative requirement; changes the canonical scope-evaluation algorithm;
changes the receipt format in ways that invalidate prior receipts; adds
or removes a mandatory transport; or changes a mechanism's deterministic
behavior. Editorial corrections are not protocol-affecting.

Merges require maintainer approval in all cases.

## Later

Add formal community governance only when actual participation warrants it,
not on a predetermined version schedule.
