# Gallery capture recipe

These fixtures and `recipe.txt` reproduce the four main editor gallery scenes through the existing `script/demo.js` runner. The recipe is preserved byte for byte as captured CommonJS source; copy it to the local carrier's `demo.js` before running it.

The editor is not a package with an `engines.lumine` marker, so the runner uses a neutral local checkout of `breadcrumbs` as its carrier. Use the breadcrumb revision recorded in `../captures.json`, replace that checkout's `demo.js` with `recipe.txt`, and replace its `demo/` directory with `fixtures/`. The runtime package source remains unchanged. The recorded carrier dirty hash covers the local recipe and fixture changes.

Run from the editor checkout, with the other declared packages checked out in the workspace:

```sh
node script/demo.js capture <neutral-carrier> --workspace <workspace> --out <new-neutral-output>
node script/demo.js check <new-neutral-output>
```

The runner opens a real normal-mode window with an isolated profile, the One light theme, default fonts and a 1440 × 900 viewport. It opens the Python source, a live Markdown preview, the actual package list and About. It checks public text before capture and masks only the outside corners. Inspect every image before replacing `view-1.png` through `view-4.png`; retain the scene descriptions and original images in the public gallery, then regenerate the numbered README panels with `script/generate-branding.js --gallery-only` under Electron.

`../captures.json` records the actual date, clean editor revision, package and theme revisions, recipe and fixture hashes, environment, dimensions and accepted image hashes. Source revisions describe the captured application; subsequent media-only commits do not change that provenance.
