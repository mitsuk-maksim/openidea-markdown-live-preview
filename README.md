# Markdown Live Preview for OpenIDEA

OpenIDEA opens `.md` and `.markdown` in Live Preview. Click prose, code, or an empty list item to edit at the caret. In prose, **Enter** starts a paragraph or continues a list. **Shift+Enter** inserts a Markdown line break. **↑ / ↓** move between visible lines and blocks. Use **Open as Text** to edit Markdown markup directly.

Type **/** in an empty paragraph to insert a code block, table, or checklist. Type to filter and choose with **↑ / ↓** and **Enter**. In a code block, **⌘Enter / Ctrl+Enter** starts a paragraph after it. You can also click the blank area below a final code block.

In a list, **Tab** nests the current item under the previous one and **Shift+Tab** moves it out one level. Type **`[]`** or **`- [ ]`** and press **Space** to start a checklist item. The same key converts list, heading, and quote markers as you type.

**Enter** after a newly typed list marker opens the first item for typing. In an empty continuation item, **Enter** leaves the list. **Backspace** or **Delete** removes an empty item without changing adjacent labels.

Click a table cell to edit its content inside the grid. Use **Tab** and **Shift+Tab** to move between cells, **Enter** to confirm, **Shift+Enter** for a line break in a cell, and **Esc** to cancel. **+ Row** and **+ Column** add an empty row or column and focus the first new cell.

Deleting a selection across cells clears the selected text and preserves the grid. A selection that ends partway through a table can be copied. To delete a whole table with nearby text, select it from outside the grid.

- **⌘B / Ctrl+B** toggles bold and **⌘I / Ctrl+I** toggles italic.
- **⌘⇧C / Ctrl+Shift+C** toggles inline code. **⌘⇧⌥C / Ctrl+Shift+Alt+C** inserts a code block or wraps the selection.
- **⌘A / Ctrl+A** selects the current editable text, cell, or code. Press it again to select the entire file. Copying the entire file preserves its Markdown source.
- **⌘− / Ctrl−** and **⌘+ / Ctrl+** change the shared Live Preview font size. **⌘0 / Ctrl+0** resets it.
- Click an HTTP(S) link to open it in the browser. Project links use the optional `project.read` grant. Use **Option-click / Alt-click** to edit a link's text or destination. Select text and use **⌘K / Ctrl+K** to add a link.

## Build and install

Use Node.js 26, Rust with the `wasm32-wasip2` target, and `zip`. Run `npm ci`, `npm test`, and `npm run build`. The build stages the package in `dist/plugin/` and creates an unsigned `dist/markdown-live-preview-<version>.oiplugin` for local testing. In OpenIDEA 0.1.46 or a later release with a compatible plugin API, choose **Settings → Plugins → Manage Plugins → Install Plugin from Package File…**.

The plugin uses `editor.read` to load the current Markdown file and `editor.write` to apply edits. The optional `project.read` permission resolves relative links to headings in other project files. The plugin is licensed under [Apache 2.0](LICENSE). The package includes notices for the OpenIDEA code and the bundled libraries and fonts.

## Publish to OpenIDEA

The [community registry](https://github.com/l0ng-ai/openidea-plugins#publishing-a-plugin) lists signed releases in **Settings → Plugins → Available**. Publish the source under an open-source license and build the package from the same revision as the release.

Get the `openidea-plugin` CLI from an OpenIDEA release or build it using the instructions in the registry. Generate the publisher key once with `openidea-plugin keygen` and store the private key outside the repository. Use the same key for subsequent releases.

```sh
npm ci
npm test
npm run build
openidea-plugin pack dist/plugin --key "$OPENIDEA_SIGNING_KEY" --publisher memitsuk \
  --out dist/memitsuk.markdown-live-preview-0.5.26.oiplugin
openidea-plugin check dist/memitsuk.markdown-live-preview-0.5.26.oiplugin
shasum -a 256 dist/memitsuk.markdown-live-preview-0.5.26.oiplugin
```

Upload the signed package to the corresponding GitHub Release. Submit a pull request to the registry with the package URL and SHA-256 in `plugins/memitsuk.markdown-live-preview.toml`. For the first release, add `publishers/memitsuk.toml` with the publisher's public key and GitHub account. Use the current version from `plugin.toml` in the commands above when publishing a later release.

The **Plugin package** GitHub Actions workflow checks the unsigned package on pull requests. Run it manually on `main` with the private key stored as the `OPENIDEA_SIGNING_KEY` repository secret to download the signed package and its SHA-256 as a workflow artifact.

## Rendering

Live Preview uses OpenIDEA 0.1.46's [Markdown renderer](src/upstream/openidea-render.ts), [preview styles](src/upstream/markdown-preview.css), and [code highlighter](src/upstream/code-highlight.ts) for the full document. The plugin adds editing by mapping rendered elements to Markdown. Constructs without a reliable source mapping are editable via **Open as Text**. Embedded raster images render, while images from files and the network show their alt text. Mermaid is shown as source code.

## Preview fixtures

Open [syntax.md](test/fixtures/syntax.md) in Live Preview and use **Open as Text → Preview Only** to compare it with OpenIDEA's preview of the same file.

Use a copy of [editing.md](test/fixtures/editing.md) to exercise empty list items, nested lists, inline formatting, table cells, and fenced code in the installed plugin.

Run `npm run fixtures:markdown` to download the [CommonMark 0.31.2 examples](https://spec.commonmark.org/0.31.2/spec.json) and [cmark-gfm extension tests](https://github.com/github/cmark-gfm/blob/0.29.0.gfm.13/test/extensions.txt) into `dist/markdown-corpus`. Each case gets its own `.md` file so reference definitions and unclosed code fences stay within their example.
