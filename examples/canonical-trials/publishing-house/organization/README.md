# Publishing House — organization in a box

This manifest launches the six Lantern Press employees as local personas and
creates their three company rooms. It also clones the same private company
repository into every persona workspace.

1. Create a private Git repository containing the files from
   [`../company-seed/`](../company-seed/) and commit them to `main`.
2. Copy [`organization.yaml`](./organization.yaml) if you want to preserve the
   example unchanged, then replace `YOUR-ACCOUNT` in `workspace.repository`
   with the private repository's real URL. A local Git URL works too.
3. Run:

```bash
grp org validate examples/canonical-trials/publishing-house/organization/organization.yaml
grp org create examples/canonical-trials/publishing-house/organization/organization.yaml \
  --output=./publishing-house-company
grp org launch ./publishing-house-company
```

The checked-in manifest validates as written, but `grp org create` needs the
repository placeholder replaced with a real, accessible private repository.
All six runtime sessions use the local Claude account and create their own
`seat/<persona>` branches before editing.

Record the run end after all six sessions are idle with no wait or background
task and final room and repository snapshots are quiescent.
