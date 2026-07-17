# Changesets

Every pull request that changes the published runtime must include a changeset:

```sh
bun run changeset
```

Select the package whose behavior changed, choose `patch`, `minor`, or `major`,
and write a concise user-facing summary. The runtime packages form one fixed
release train, so Changesets applies the highest requested bump to every runtime
package.

If a source change intentionally needs no release, record that decision:

```sh
bun run changeset --empty
```

Commit the generated `.changeset/*.md` file with the pull request. CI rejects
runtime source changes that add neither a release changeset nor an explicit
empty changeset.

## Release flow

1. Changesets accumulate on `main` as feature and fix pull requests merge.
2. `release-pr.yml` maintains a `chore: version packages` pull request.
3. The version command consumes the changesets, updates package changelogs, and
   synchronizes the selected version into `VERSION`, Cargo, Python, and lockfiles.
4. Merging the version pull request changes `VERSION`, which triggers the existing
   hardened npm, PyPI, and GitHub release workflow.

`@stll/anonymize-data` remains independently versioned and is not part of this
runtime release train. Do not select it in `bun run changeset`; CI rejects data
changesets until its independent release path is automated.
