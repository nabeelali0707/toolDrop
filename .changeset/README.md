# Changesets

Each pull request that changes what people who install toolDrop will notice adds a changeset: run `pnpm changeset`, pick `tooldrop`, choose `patch` for fixes or `minor` for features, and describe the change in a sentence or two. Before 1.0 there are no `major` changes.

At release time, `pnpm changeset version` turns the pending changesets into a version bump and the package's CHANGELOG. See CONTRIBUTING.md, "Releases".
