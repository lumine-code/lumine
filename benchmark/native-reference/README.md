# Optional native document reference

These differential tests compare the JavaScript model with a separately built native Superstring. They are outside `spec/`, do not use default Node test-discovery filenames, and are not part of `npm test`. A requested comparison fails explicitly if its reference is unavailable; there is no automatic skip or fallback to the JavaScript implementation.

Use a standalone native checkout or a frozen package built from `lumine-code/superstring` revision `809c57b536eca226a6cb9433bc75e07a39462574`. Follow that repository's build instructions with a supported Node runtime and native toolchain. Do not install the reference into the editor's `node_modules`. The directory must contain the native package's `package.json`, entry point and `build/Release/superstring.node`.

On Windows:

```powershell
$env:LUMINE_NATIVE_SUPERSTRING = 'C:\path\to\native-reference'
npm run test:document-native
```

On Unix:

```sh
LUMINE_NATIVE_SUPERSTRING=/path/to/native-reference npm run test:document-native
```

The runner validates the package identity and native binary, prints the selected paths and binary SHA-256, and runs every `*.reference.js` file here. Loading the reference also verifies that its entry point actually loaded the selected native Release binding. Building or downloading the reference is an explicit separate step. The selected binary must support the runtime used for the comparison.

The suite retains randomized patch composition and geometry comparisons, marker coordinates/query/invalidation comparisons, text edits and undo, completion scoring and UTF-16 coordinate checks. Standard tests independently exercise flat-string replay, inverse patches, marker affinity and coordinate lists, persistent snapshots, file I/O and editor integration without native Superstring.

`npm run benchmark:text-model` and `npm run benchmark:text-model-renderer` measure the current editor without a native reference. Their historical source filenames remain stable for recorded benchmark provenance. The explicitly native-versus-JS `benchmark:document-integration` additionally requires an archived native editor with its own dependencies resolving the same native binary. Select the external reference through `LUMINE_NATIVE_SUPERSTRING` or `--native-reference PATH`; the driver checks binary hashes before measuring. Neither the current editor nor its ordinary benchmark tools install native Superstring.
