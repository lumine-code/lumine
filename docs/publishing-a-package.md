# Publishing a package

A Lumine package is just a public Git repository with a `package.json`. Anyone can already install it directly by its `owner/repo`; publishing is about making it **discoverable** and keeping **versions** tidy.

## Tag your releases

Publish stable releases as Git **tags**. Give each release a semver tag (`1.2.0` or `v1.2.0`) and make sure the `package.json` version matches. This powers ref selection and [update](https://lumine-code.github.io/docs.html#packages-and-themes/managing-packages) checks:

- installing `owner/repo` picks your highest stable tag;
- installing `owner/repo@1.2.0` selects that exact tag;
- a package installed from the bare repository follows newer stable tags.

The manifest version names the release and carries no `-dev` suffix between releases. To release, set the version, commit, create the matching tag, and push both. A user's selected tag is separate from the commit pin through which the editor may bundle that package.

## Requirements

- A valid `package.json` with at least `name`, `repository`, and `version`.
- `"engines": { "lumine": "^1.0.0" }` so Lumine knows it is compatible; a manifest without the `lumine` engine cannot be installed.
- A stable `name`, which is the package's runtime identity. A dev or installed package with the same name as a bundled one deliberately overrides the lower-priority copy, so reuse a name only when distributing another ref of that same package. See [Managing packages](https://lumine-code.github.io/docs.html#packages-and-themes/managing-packages).

## Getting into the Install tab

Lumine's **Install** tab aggregates one or more **catalogs**. The default [`lumine-code/packages`](https://github.com/lumine-code/packages) catalog lists every package maintained by `lumine-code`, including packages also bundled with the editor so users can install another ref.

A catalog is a JSON array. A permanent source-only entry may be a Git source such as `owner/repo`; the editor resolves its ref and reads its manifest. A catalog service may instead enrich it into a snapshot object containing `source`, `resolvedSha`, `selectedRef`, `refs` and `metadata`, which lets the Install tab use one reviewed resolution without fetching every repository first.

You can publish your own catalog and ask users to add it as a source; the Install tab accepts any number. A package does not need a catalog entry to be installable: users can type `owner/repo` or select a release with `owner/repo@1.2.0`.
