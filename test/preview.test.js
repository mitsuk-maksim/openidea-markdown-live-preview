import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Transaction } from "@codemirror/state";
import { history } from "@codemirror/commands";
import { GFM } from "@lezer/markdown";
import { mountNativePreview } from "../src/native-preview.js";
import { renderMarkdown } from "../src/upstream/openidea-render.ts";

const { window } = new JSDOM("<body></body>", { pretendToBeVisual: true });
const { document } = window;
Object.assign(globalThis, { window, document });
const language = markdown({ extensions: GFM });
const fixture = await readFile(new URL("fixtures/syntax.md", import.meta.url), "utf8");

function mount(text, extensions = []) {
  const root = document.createElement("main");
  document.body.append(root);
  root.tabIndex = -1;
  let preview;
  const view = {
    state: EditorState.create({ doc: text, extensions: [language, history(), ...extensions] }),
    dispatch(spec) {
      const startState = view.state;
      const tr = spec instanceof Transaction ? spec : startState.update(spec);
      view.state = tr.state;
      preview.update({ startState, state: tr.state, docChanged: tr.docChanged });
    },
  };
  preview = mountNativePreview(root, view, language.language.parser);
  return { root, view, text: () => view.state.doc.toString(), close: () => root.remove() };
}

function clickAt(element, node, offset) {
  document.caretRangeFromPoint = () => {
    const range = document.createRange();
    range.setStart(node, offset);
    return range;
  };
  document.getSelection().removeAllRanges();
  element.click();
}

function type(field, value) {
  if (field.tagName === "TEXTAREA") field.value = value;
  else field.textContent = value;
  field.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
}

function press(field, key, options = {}) {
  return !field.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
}

test("Enter after typing a bare list marker opens the list before Enter can exit it", () => {
  for (const prefix of ["1.", "12)", "-", "[]", "- [x]"]) {
    for (const spaceFirst of [false, true]) {
      const page = mount("");
      try {
        document.getSelection().removeAllRanges();
        page.root.click();
        const field = document.activeElement;
        type(field, prefix);
        document.getSelection().collapse(field.firstChild, prefix.length);
        if (spaceFirst) press(field, " ");
        press(document.activeElement, "Enter");
        assert.ok(page.root.querySelector("li [contenteditable]"), prefix);
        type(document.activeElement, "label");
        assert.equal(page.text(), (prefix === "[]" ? "- [ ]" : prefix) + " label");
      } finally {
        page.close();
      }
    }
  }
});

test("both delete keys remove a blank item without deleting adjacent labels and Undo restores the marker", () => {
  for (const [above, blank, below] of [
    ["- above", "- ", "- below"], ["1. above", "2.", "3. below"],
    ["- [x] above", "- [ ]", "- [ ] below"], ["- [ ] above", "- [x] ", "- [ ] below"],
  ]) {
    for (const key of ["Backspace", "Delete", "Enter"]) {
      const original = [above, blank, below].join("\n");
      const page = mount(original);
      try {
        const item = page.root.querySelector(".md-empty-item");
        document.getSelection().removeAllRanges();
        item.click();
        assert.ok(document.activeElement.classList.contains("md-empty-caret"));
        const checkbox = item.querySelector("input");
        if (checkbox) assert.equal(checkbox.compareDocumentPosition(document.activeElement) &
          window.Node.DOCUMENT_POSITION_FOLLOWING, window.Node.DOCUMENT_POSITION_FOLLOWING);
        assert.ok(press(document.activeElement, key));
        assert.equal(page.text(), above + "\n\n\n\n" + below);
        assert.ok(document.activeElement.matches("p [contenteditable]"));
        assert.match(document.activeElement.parentElement.previousElementSibling?.textContent ?? "", /above/);
        assert.match(document.activeElement.parentElement.nextElementSibling?.textContent ?? "", /below/);
        if (key === "Enter") {
          type(document.activeElement, "inserted");
          assert.equal(page.text(), above + "\n\ninserted\n\n" + below);
        } else {
          press(document.activeElement, "z", { metaKey: true });
          assert.equal(page.text(), original);
          press(document.activeElement, "z", { metaKey: true, shiftKey: true });
          assert.equal(page.text(), above + "\n\n\n\n" + below);
        }
      } finally {
        page.close();
      }
    }
  }
});

test("Backspace changes list structure at the label start and preserves adjacent text", () => {
  for (const [text, index, expected] of [
    ["1. First\n2. Second\n3. Third", 1, "1. First\n\nSecond\n\n3. Third"],
    ["- [x] First\n- [ ] Second", 1, "- [x] First\n\nSecond"],
    ["- First\n  - Second\n- Third", 1, "- First\n- Second\n- Third"],
    ["- First\n\n  - \n- Third", 1, "- First\n\n- \n- Third"],
  ]) {
    const page = mount(text);
    try {
      const items = [...page.root.querySelectorAll("li")];
      const item = items[index];
      const textNode = [...item.childNodes].find((node) => node.nodeType === 3 && node.data.trim());
      if (textNode) clickAt(item, textNode, textNode.data.length - textNode.data.trimStart().length);
      else {
        document.getSelection().removeAllRanges();
        item.click();
      }
      press(document.activeElement, "Backspace");
      assert.equal(page.text(), expected);
    } finally {
      page.close();
    }
  }
});

test("delete at boundaries preserves unrelated blocks and removes whole inline graphemes", () => {
  for (const [text, key, target, expected] of [
    ["first\n\n```\nx\n```\n\nlast", "Backspace", "p:last-group", "first\n\n```\nx\n```\n\nlast"],
    ["first\n\n| A |\n| --- |\n| B |\n\nlast", "Delete", "p", "first\n\n| A |\n| --- |\n| B |\n\nlast"],
    ["# Title\n\n- Other", "Delete", "h1", "# Title\n\n- Other"],
    ["first\n\n---\n\nlast", "Backspace", "p:last-group", "first\n\n---\n\nlast"],
    ["one 👩‍💻**bold**", "Backspace", "strong", "one **bold**"],
    ["a**é**b", "Delete", "p", "ab"],
    ["1. one\n2. two", "Delete", "li", "1. one two"],
  ]) {
    const page = mount(text);
    try {
      const block = target === "p:last-group" ? [...page.root.querySelectorAll("p")].at(-1) : page.root.querySelector(target);
      const node = block.firstChild;
      clickAt(block, node, key === "Backspace" ? 0 : node.length);
      assert.ok(press(document.activeElement, key));
      assert.equal(page.text(), expected);
    } finally {
      page.close();
    }
  }
});

test("structural Enter and Shift+Enter preserve list or quote markup and inline formatting", () => {
  for (const [text, selector, offset, shiftKey, expected] of [
    ["1. **hello**", "strong", 2, false, "1. **he**\n2. **llo**"],
    ["1. **hello**", "strong", 5, false, "1. **hello**\n2. "],
    ["- [x] hello", "li", 3, false, "- [x] he\n- [ ] llo"],
    ["> **hello**", "strong", 2, false, "> **he**\n> **llo**"],
    ["- hello", "li", 2, true, "- he\\\n  llo"],
    ["1. hello", "li", 2, true, "1. he\\\n   llo"],
    ["> hello", "p", 2, true, "> he\\\n> llo"],
    ["A `code` B", "code", 2, false, "A `co`\n\n`de` B"],
  ]) {
    const page = mount(text);
    try {
      const element = page.root.querySelector(selector);
      const node = [...element.childNodes].find((node) => node.nodeType === 3 && node.data.trim());
      clickAt(element, node, offset);
      press(document.activeElement, "Enter", { shiftKey });
      assert.equal(page.text(), expected);
    } finally {
      page.close();
    }
  }
});

test("left, right and Shift+Right can cross inline formatting boundaries", () => {
  const page = mount("a**test** then `code`");
  try {
    const p = page.root.querySelector("p");
    clickAt(p, p.firstChild, 1);
    assert.ok(press(document.activeElement, "ArrowRight", { shiftKey: true }));
    assert.equal(document.getSelection().toString(), "t");
    const bold = p.querySelector("strong");
    clickAt(bold, bold.firstChild, 0);
    assert.ok(press(document.activeElement, "ArrowLeft"));
    assert.equal(document.activeElement.textContent, "a");
    assert.equal(document.getSelection().anchorOffset, 0);
    document.getSelection().collapse(document.activeElement.firstChild, 1);
    assert.ok(press(document.activeElement, "ArrowRight"));
    assert.ok(document.activeElement.closest("strong"));
    assert.equal(document.getSelection().anchorOffset, 1);
    assert.equal(page.text(), "a**test** then `code`");
  } finally {
    page.close();
  }
});

test("Select All selects the whole formatted paragraph and a second press selects the file", () => {
  const text = "# Earlier\n\nLeft **bold** and *italic*.\n\nLater";
  const page = mount(text);
  try {
    const bold = page.root.querySelector("strong");
    clickAt(bold, bold.firstChild, 1);
    press(document.activeElement, "a", { metaKey: true });
    assert.equal(document.getSelection().toString(), "Left bold and italic.");
    press(document.activeElement, "a", { metaKey: true });
    assert.equal(clipboard(page.root, "copy", ""), text);
  } finally {
    page.close();
  }
});

test("a formatting shortcut at a bare caret creates emphasis only when typing starts", () => {
  for (const [key, mark, tag] of [["b", "**", "strong"], ["i", "*", "em"]]) {
    const page = mount("plain ");
    try {
      const p = page.root.querySelector("p");
      clickAt(p, p.firstChild, p.firstChild.length);
      press(document.activeElement, key, { metaKey: true });
      assert.equal(page.text(), "plain ");
      assert.ok(document.activeElement.parentElement.matches(tag));
      type(document.activeElement, "word");
      assert.equal(page.text(), "plain " + mark + "word" + mark);
      document.activeElement.blur();
      assert.equal(page.root.querySelector(tag).textContent, "word");
    } finally {
      page.close();
    }
  }
});

test("Tab in a table commits cells, Escape cancels, and document Undo restores a committed edit", () => {
  const original = "| First | Second |\n| --- | --- |\n| One | Two |";
  const page = mount(original);
  try {
    const cell = page.root.querySelector("td");
    clickAt(cell, cell.firstChild, 1);
    type(document.activeElement, "A | B");
    press(document.activeElement, "Tab");
    assert.equal(document.activeElement.value, "Two");
    assert.match(page.text(), /A \\\| B/);
    type(document.activeElement, "discard");
    press(document.activeElement, "Escape");
    assert.match(page.text(), / Two /);
    press(page.root, "z", { metaKey: true });
    assert.equal(page.text(), original);
  } finally {
    page.close();
  }
});

test("inline code shortcut preserves selection, handles backticks, and accepts new typing", () => {
  const page = mount("A plain word.");
  try {
    const node = page.root.querySelector("p").firstChild;
    document.getSelection().setBaseAndExtent(node, 7, node, 2);
    press(page.root, "C", { metaKey: true, shiftKey: true });
    assert.equal(page.text(), "A `plain` word.");
    assert.equal(document.getSelection().toString(), "plain");
    assert.equal(document.getSelection().anchorOffset, 5);
    press(page.root, "C", { metaKey: true, shiftKey: true });
    assert.equal(page.text(), "A plain word.");
    clickAt(page.root.querySelector("p"), page.root.querySelector("p").firstChild, 7);
    press(document.activeElement, "C", { metaKey: true, shiftKey: true });
    type(document.activeElement, "a`b");
    document.activeElement.blur();
    assert.equal(page.text(), "A plain``a`b`` word.");
    assert.equal(page.root.querySelector("code").textContent, "a`b");
  } finally {
    page.close();
  }
});

test("code block shortcut wraps selection and opens an empty fenced editor at the cursor", () => {
  const page = mount("Before sample after.");
  try {
    const node = page.root.querySelector("p").firstChild;
    document.getSelection().setBaseAndExtent(node, 7, node, 13);
    press(page.root, "C", { metaKey: true, shiftKey: true, altKey: true });
    assert.equal(page.text(), "Before \n\n```\nsample\n```\n\n after.");
    const field = document.activeElement;
    assert.equal(field.getAttribute("aria-label"), "Edit code block");
    assert.deepEqual([field.selectionStart, field.selectionEnd], [0, 6]);
    press(field, "Enter", { metaKey: true });
    type(document.activeElement, "New paragraph.");
    assert.equal(page.root.querySelector("pre code").textContent, "sample");
    assert.match(page.text(), /```\n\nNew paragraph\.\n\n after\.$/);
  } finally {
    page.close();
  }
});

test("clicking under the final fence places a prose caret and can close an unfinished fence", () => {
  for (const fence of ["```json\n{}\n```", "```json\n{}"]) {
    const page = mount(fence);
    try {
      document.getSelection().removeAllRanges();
      page.root.click();
      assert.equal(page.text(), fence);
      type(document.activeElement, "Following");
      assert.equal(page.text(), "```json\n{}\n```\n\nFollowing");
    } finally {
      page.close();
    }
  }
});

test("slash menu filters, inserts blocks, and leaves literal text on Escape", () => {
  for (const [query, element, label] of [
    ["/таб", "table", "Edit table cell Markdown"],
    ["/code", "pre code", "Edit code block"],
    ["/check", "li input[type=checkbox]", "Edit Markdown text"],
  ]) {
    const page = mount("");
    try {
      document.getSelection().removeAllRanges();
      page.root.click();
      type(document.activeElement, query);
      assert.equal(page.root.querySelectorAll(".md-slash-menu button").length, 1);
      press(document.activeElement, "Enter");
      assert.ok(page.root.querySelector(element));
      assert.equal(document.activeElement.getAttribute("aria-label"), label);
    } finally {
      page.close();
    }
  }
  const page = mount("");
  try {
    document.getSelection().removeAllRanges();
    page.root.click();
    const field = document.activeElement;
    type(field, "/");
    press(field, "ArrowDown");
    assert.equal(page.root.querySelector(".md-slash-menu .selected").textContent, "Table");
    press(field, "Escape");
    assert.equal(page.root.querySelector(".md-slash-menu"), null);
    assert.equal(page.text(), "/");
    assert.equal(document.activeElement, field);
  } finally {
    page.close();
  }
});

test("empty ordered items, bullets and checkboxes accept text when clicked", () => {
  const page = mount("1. first\n2.\n3. third\n\n-\n- [ ]\n- [x] complete");
  try {
    const empty = page.root.querySelectorAll("li.md-empty-item");
    assert.equal(empty.length, 3);
    for (const [selector, value] of [["ol li:nth-child(2)", "middle"], ["ul li:first-child", "bullet"],
      ["ul li:nth-child(2)", "task"]]) {
      document.getSelection().removeAllRanges();
      page.root.querySelector(selector).click();
      const field = document.activeElement;
      assert.equal(field.getAttribute("aria-label"), "Edit Markdown text");
      type(field, value);
      field.blur();
    }
    assert.equal(page.text(), "1. first\n2. middle\n3. third\n\n- bullet\n- [ ] task\n- [x] complete");
    assert.equal(page.root.querySelectorAll("input[type=checkbox]").length, 2);
  } finally {
    page.close();
  }
});

test("space turns Markdown prefixes into editable blocks before text is entered", () => {
  for (const [prefix, element, expected] of [
    ["[]", "li input[type=checkbox]", "- [ ] test"],
    ["- [ ]", "li input[type=checkbox]", "- [ ] test"],
    ["- [x]", "li input:checked", "- [x] test"],
    ["-", "ul li", "- test"],
    ["1.", "ol li", "1. test"],
    ["##", "h2", "## test"],
    [">", "blockquote", "> test"],
  ]) {
    const page = mount("");
    try {
      document.getSelection().removeAllRanges();
      page.root.click();
      const field = document.activeElement;
      type(field, prefix);
      document.getSelection().collapse(field.firstChild, prefix.length);
      press(field, " ");
      assert.ok(page.root.querySelector(element), prefix);
      assert.equal(document.activeElement.getAttribute("aria-label"), "Edit Markdown text");
      type(document.activeElement, "test");
      assert.equal(page.text(), expected);
    } finally {
      page.close();
    }
  }
});

test("an empty task leaves the other tasks in a mixed list editable and clickable", () => {
  const page = mount("- Regular\n- [ ] \n- [x] Completed\n- [ ] Open");
  try {
    const boxes = [...page.root.querySelectorAll('input[aria-label="Toggle task"]')];
    assert.equal(boxes.length, 3);
    assert.deepEqual(boxes.map((box) => box.checked), [false, true, false]);
    boxes[1].click();
    assert.match(page.text(), /- \[ \] Completed/);
    const item = page.root.querySelector("li:last-child");
    clickAt(item, item.lastChild, 3);
    assert.equal(document.activeElement.textContent.trim(), "Open");
  } finally {
    page.close();
  }
});

test("a single click switches from edited text to another block through the redraw", () => {
  const page = mount("First paragraph.\n\nSecond paragraph.");
  try {
    const first = page.root.querySelector("p");
    clickAt(first, first.firstChild, 5);
    const field = document.activeElement;
    type(field, "Changed first paragraph.");
    const second = page.root.querySelectorAll("p")[1];
    document.elementFromPoint = () => page.root.querySelector("p");
    document.caretRangeFromPoint = () => {
      const range = document.createRange();
      range.setStart(second.firstChild, 3);
      return range;
    };
    second.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    field.blur();
    document.getSelection().collapse(second.firstChild, 3);
    second.dispatchEvent(new window.MouseEvent("pointerup", { bubbles: true }));
    second.click();
    assert.equal(document.activeElement.textContent, "Second paragraph.");
    assert.equal(document.getSelection().anchorOffset, 3);
    assert.equal(page.text(), "Changed first paragraph.\n\nSecond paragraph.");
  } finally {
    delete document.elementFromPoint;
    page.close();
  }
});

test("Tab nests an entire list item and Shift+Tab restores its caret and subtree", () => {
  const original = "- One\n- Two **pieces**\n  - Child\n- Three";
  const page = mount(original);
  try {
    const word = page.root.querySelector("strong");
    clickAt(word, word.firstChild, 3);
    press(document.activeElement, "Tab");
    assert.equal(page.text(), "- One\n  - Two **pieces**\n    - Child\n- Three");
    assert.ok(page.root.querySelector("ul > li > ul > li strong"));
    assert.equal(document.getSelection().anchorOffset, 3);
    press(document.activeElement, "Tab", { shiftKey: true });
    assert.equal(page.text(), original);
    assert.equal(document.getSelection().anchorOffset, 3);
  } finally {
    page.close();
  }
});

test("Tab keeps an ordered marker other than 1 from turning into paragraph text", () => {
  const page = mount("1. One\n2. Two\n3. Three");
  try {
    const item = page.root.querySelectorAll("li")[1];
    clickAt(item, item.firstChild, 2);
    press(document.activeElement, "Tab");
    assert.equal(page.root.querySelector("ol ol").getAttribute("start"), "2");
    assert.equal(document.activeElement.textContent, "Two");
    press(document.activeElement, "Tab", { shiftKey: true });
    assert.deepEqual([...page.root.querySelectorAll("ol > li")].map((li) => li.textContent.trim()), ["One", "Two", "Three"]);
    assert.equal(document.getSelection().anchorOffset, 2);
  } finally {
    page.close();
  }
});

test("renders the fixture using the complete OpenIDEA HTML and highlights fenced JSON", async () => {
  const page = mount(fixture);
  try {
    const native = document.createElement("main");
    native.innerHTML = renderMarkdown(fixture);
    assert.equal(page.root.querySelector("h1").outerHTML, native.querySelector("h1").outerHTML);
    assert.ok(page.root.querySelector("ol > li > table"));
    assert.ok(page.root.querySelector("p a[href]"));
    assert.ok(page.root.querySelector("details > summary"));
    const json = page.root.querySelector("pre > code.language-json");
    assert.equal(json.textContent, native.querySelector("pre > code.language-json").textContent.trimEnd());
    assert.doesNotMatch(json.textContent, /```/);
    for (let i = 0; i < 30 && !json.querySelector(".tok-propertyName"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(json.querySelector(".tok-propertyName")?.textContent, '"layout"');
    assert.equal(json.querySelector(".tok-bool")?.textContent, "true");
    assert.equal(page.text(), fixture);
  } finally {
    page.close();
  }
});

test("opens a nested table cell at the clicked character and preserves adjacent Markdown", () => {
  const page = mount(fixture);
  try {
    const bold = page.root.querySelector("ol table tbody td strong");
    const cell = bold.closest("td");
    clickAt(bold, bold.firstChild, 2);
    const field = cell.querySelector("textarea");
    assert.equal(field.value, "**Жирный**");
    assert.equal(field.selectionStart, 4);
    type(field, "**Жирный | текст**");
    press(field, "Tab");
    assert.equal(page.text(), fixture.replace("**Жирный** | `x", "**Жирный \\| текст** | `x"));
    assert.equal(page.root.querySelector("ol table tbody td strong").textContent, "Жирный | текст");
    assert.equal(page.root.querySelector("ol table textarea").value, "`x\\|y`");
  } finally {
    page.close();
  }
});

test("clicking JSON edits only code content, with an exact caret and the original code element", async () => {
  const page = mount(fixture);
  try {
    const code = page.root.querySelector("code.language-json");
    const caret = code.textContent.indexOf("columns");
    clickAt(code, code.firstChild, caret);
    const field = page.root.querySelector("textarea[aria-label='Edit code block']");
    assert.equal(field.selectionStart, caret);
    assert.equal(field.wrap, "off");
    type(field, field.value.replace('"columns": 3', '"columns": 30'));
    assert.equal(page.text(), fixture.replace('"columns": 3', '"columns": 30'));
    assert.equal(page.root.querySelector("code.language-json"), code);
    press(field, "Escape");
    assert.equal(page.root.querySelector("textarea"), null);
    assert.match(page.root.querySelector("code.language-json").textContent, /"columns": 30/);
  } finally {
    page.close();
  }
});

test("selects the right occurrence of repeated formatted prose and keeps its markers", () => {
  const doc = "# Heading\n\n**same** [same](same.md) **same**.";
  const page = mount(doc);
  try {
    const word = page.root.querySelectorAll("strong")[1];
    clickAt(word, word.firstChild, 2);
    const field = word.querySelector("[contenteditable]");
    assert.equal(document.getSelection().anchorOffset, 2);
    type(field, "second");
    field.blur();
    assert.equal(page.text(), "# Heading\n\n**same** [same](same.md) **second**.");
  } finally {
    page.close();
  }
});

test("links navigate through the host while unsafe HTML stays out of the preview", () => {
  const calls = [];
  window.openidea = { postMessage: (message) => calls.push(JSON.parse(message)) };
  const page = mount('[local](next.md#heading) [web](https://example.com)\n\n<script>alert(1)</script>');
  try {
    page.root.querySelectorAll("a").forEach((link) => link.click());
    assert.deepEqual(calls, [{ kind: "file", path: "next.md", anchor: "heading" },
      { kind: "url", href: "https://example.com/" }]);
    assert.equal(page.root.querySelector("script"), null);
  } finally {
    page.close();
    delete window.openidea;
  }
});

test("adds rows and columns to a nested table and focuses each new cell", () => {
  const page = mount(fixture);
  try {
    page.root.querySelector("ol .md-table-controls button").click();
    const row = page.root.querySelector("ol tbody tr:last-child");
    assert.equal(row.cells.length, 3);
    assert.equal(document.activeElement, row.cells[0].querySelector("textarea"));
    type(document.activeElement, "Added row");
    press(document.activeElement, "Enter");
    page.root.querySelector('ol button[title="Add table column"]').click();
    const header = page.root.querySelector("ol thead tr");
    assert.equal(header.cells.length, 4);
    assert.equal(document.activeElement, header.cells[3].querySelector("textarea"));
    type(document.activeElement, "New column");
    press(document.activeElement, "Enter");
    assert.match(page.text(), /^   \| Added row \|  \|  \|  \|$/m);
    assert.match(page.text(), /^   \| Поле \| Значение \| Код \| New column \|$/m);
    assert.match(page.text(), /:--- \| :---: \| ---: \| --- \|/);
    assert.match(page.text(), /\n\n3\. Третий пункт/);
  } finally {
    page.close();
  }
});

test("a keyboard toggle preserves forward and backward selection across redraws", () => {
  const page = mount("alpha beta gamma");
  try {
    page.root.focus();
    const node = page.root.querySelector("p").firstChild;
    document.getSelection().setBaseAndExtent(node, 10, node, 6);
    press(page.root, "b", { metaKey: true });
    assert.equal(page.text(), "alpha **beta** gamma");
    assert.equal(document.getSelection().toString(), "beta");
    assert.equal(document.getSelection().anchorNode.parentElement.tagName, "STRONG");
    assert.equal(document.getSelection().anchorOffset, 4);
    assert.equal(document.getSelection().focusOffset, 0);
    press(page.root, "b", { metaKey: true });
    assert.equal(page.text(), "alpha beta gamma");
    assert.equal(document.getSelection().toString(), "beta");
    assert.equal(document.getSelection().anchorOffset, 10);
    assert.equal(document.getSelection().focusOffset, 6);
  } finally {
    page.close();
  }
});

test("bolding an already mixed paragraph keeps one strong span, other styles and the visible selection", () => {
  const original = "Plain **bold** and *italic* with `inline` text.";
  const page = mount(original);
  try {
    const paragraph = page.root.querySelector("p");
    const end = paragraph.lastChild;
    document.getSelection().setBaseAndExtent(end, end.length, paragraph.firstChild, 0);
    press(page.root, "b", { metaKey: true });
    assert.equal(page.text(), "**Plain bold and *italic* with `inline` text.**");
    const strong = page.root.querySelector("p > strong");
    assert.equal(strong.textContent, "Plain bold and italic with inline text.");
    assert.equal(strong.querySelector("em").textContent, "italic");
    assert.equal(strong.querySelector("code").textContent, "inline");
    assert.equal(document.getSelection().toString(), strong.textContent);
    assert.equal(document.getSelection().anchorOffset, strong.lastChild.length);
    press(page.root, "z", { metaKey: true });
    assert.equal(page.text(), original);
  } finally {
    page.close();
  }
});

test("emphasis extending from inside a styled span preserves text outside the selection", () => {
  const page = mount("A *styled* end.");
  try {
    const paragraph = page.root.querySelector("p");
    document.getSelection().setBaseAndExtent(paragraph.querySelector("em").firstChild, 2, paragraph.lastChild, 4);
    press(page.root, "i", { metaKey: true });
    assert.equal(page.text(), "A *styled end*.");
    assert.equal(document.getSelection().toString(), "yled end");
  } finally {
    page.close();
  }
});

test("cell formatting merges existing bold with the selected text", () => {
  const page = mount("| Header |\n| --- |\n| Some **bold** and text |");
  try {
    const cell = page.root.querySelector("td");
    clickAt(cell, cell.firstChild, 0);
    const field = document.activeElement;
    field.select();
    press(field, "b", { metaKey: true });
    assert.equal(field.value, "**Some bold and text**");
    press(field, "Enter");
    assert.equal(page.root.querySelector("td > strong").textContent, "Some bold and text");
  } finally {
    page.close();
  }
});

test("formatting a selection ending in a link or code keeps its full markup", () => {
  for (const [tail, selector, expected] of [
    ["[local link](file.md)", "a", "**First [local link](file.md)**"],
    ["`inline code`", "code", "**First `inline code`**"],
  ]) {
    const page = mount("First " + tail);
    try {
      const paragraph = page.root.querySelector("p");
      const end = paragraph.querySelector(selector).firstChild;
      document.getSelection().setBaseAndExtent(end, end.length, paragraph.firstChild, 0);
      press(page.root, "b", { metaKey: true });
      assert.equal(page.text(), expected);
      assert.ok(page.root.querySelector("strong > " + selector));
      assert.equal(document.getSelection().toString(), paragraph.textContent);
      press(page.root, "z", { metaKey: true });
      assert.equal(page.text(), "First " + tail);
    } finally {
      page.close();
    }
  }
});

test("multi-block formatting preserves link destinations, separate paragraphs, table separators and fenced code", () => {
  const original = "First [local](file.md)\n\nSecond `code`\n\n| Left | Right |\n| --- | --- |\n| One | Two |\n\n```json\n{\"keep\":true}\n```\n\nFinal.";
  const page = mount(original);
  try {
    const paragraphs = page.root.querySelectorAll("p");
    const end = paragraphs[2].lastChild;
    document.getSelection().setBaseAndExtent(paragraphs[0].firstChild, 0, end, end.length);
    press(page.root, "b", { metaKey: true });
    const expected = "**First [local](file.md)**\n\n**Second `code`**\n\n| **Left** | **Right** |\n| --- | --- |\n| **One** | **Two** |\n\n```json\n{\"keep\":true}\n```\n\n**Final.**";
    assert.equal(page.text(), expected);
    assert.ok(page.root.querySelector("p strong > a"));
    assert.equal(page.root.querySelector("pre code").textContent, '{"keep":true}');
    press(page.root, "b", { metaKey: true });
    assert.equal(page.text(), original);
    press(page.root, "z", { metaKey: true });
    assert.equal(page.text(), expected);
  } finally {
    page.close();
  }
});

test("deletion and cut across cells keep the table and Undo restores the text", () => {
  const original = "| Left | Right |\n| --- | --- |\n| Alpha | Beta |";
  for (const key of ["Backspace", "Delete", "cut", "x"]) {
    const page = mount(original);
    try {
      const [left, right] = page.root.querySelectorAll("td");
      document.getSelection().setBaseAndExtent(left.firstChild, 2, right.firstChild, 2);
      if (key === "cut") clipboard(page.root, "cut", "");
      else press(page.root, key);
      const expected = "| Left | Right |\n| --- | --- |\n| " + (key === "x" ? "Alx" : "Al") + " | ta |";
      assert.equal(page.text(), expected);
      assert.equal(page.root.querySelector("tbody tr").cells.length, 2);
      assert.ok(document.activeElement.matches(".md-cell-editor"));
      const save = press(document.activeElement, "s", { metaKey: true });
      assert.equal(save, false);
      assert.equal(document.activeElement, page.root);
      press(document.activeElement, "z", { metaKey: true });
      assert.equal(page.text(), original);
    } finally {
      page.close();
    }
  }
});

test("a selection ending inside the table cannot remove its partial structure", () => {
  const original = "Prose\n\n| Left | Right |\n| --- | --- |\n| Alpha | Beta |";
  const page = mount(original);
  try {
    const paragraph = page.root.querySelector("p");
    const cell = page.root.querySelector("td");
    document.getSelection().setBaseAndExtent(paragraph.firstChild, 0, cell.firstChild, 2);
    for (const key of ["Delete", "Backspace", "x", "Enter"]) press(page.root, key);
    assert.equal(page.text(), original);
    clickAt(cell, cell.firstChild, 0);
    press(document.activeElement, "a", { metaKey: true });
    press(document.activeElement, "a", { metaKey: true });
    press(page.root, "Delete");
    assert.equal(page.text(), "");
  } finally {
    page.close();
  }
});

test("a mouse selection across an entire table or code block removes its Markdown and can be undone", () => {
  for (const [block, first, last] of [
    ["| Left | Right |\n| --- | --- |\n| Alpha | Beta |", "th:first-child", "td:last-child"],
    ["```\nconst x = 1\n```", "pre code", "pre code"],
  ]) {
    for (const backward of [false, true]) {
      const original = `Before\n\n${block}\n\nAfter`;
      const page = mount(original);
      try {
        const start = page.root.querySelector(first).firstChild;
        const end = page.root.querySelector(last).lastChild;
        const selection = document.getSelection();
        if (backward) selection.setBaseAndExtent(end, end.length, start, 0);
        else selection.setBaseAndExtent(start, 0, end, end.length);
        page.root.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
        assert.ok(page.root.querySelector(".md-block-selected"));
        assert.ok(press(page.root, "Backspace", { altKey: true }));
        assert.equal(page.text(), "Before\n\nAfter");
        press(document.activeElement, "z", { metaKey: true });
        assert.equal(page.text(), original);
      } finally {
        page.close();
      }
    }
  }
});

test("Shift+Down extends through prose, a whole table and a code block and Shift+Up shrinks the selection", () => {
  const original = "First\n\nTarget\n\n| A | B |\n| --- | --- |\n| One | Two |\n\n```\ncode\n```\n\nLast";
  const page = mount(original);
  const rangeRects = window.Range.prototype.getClientRects;
  const elementRect = window.HTMLElement.prototype.getBoundingClientRect;
  function rect(element, left, width = 80) {
    const top = Number(element?.closest("[data-line]")?.dataset.line ?? 0) * 30;
    return { top, bottom: top + 20, height: 20, left, right: left + width };
  }
  window.Range.prototype.getClientRects = function () {
    const node = this.startContainer;
    return [rect(node.nodeType === 1 ? node : node.parentElement, this.collapsed ? this.startOffset * 8 : 0)];
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return rect(this, 0); };
  try {
    const first = page.root.querySelector("p");
    clickAt(first, first.firstChild, 5);
    assert.ok(press(document.activeElement, "ArrowDown", { shiftKey: true }));
    assert.match(document.getSelection().toString(), /Targe/);
    assert.ok(press(page.root, "ArrowDown", { shiftKey: true }));
    assert.ok(page.root.querySelector("table.md-block-selected"));
    assert.ok(press(page.root, "ArrowDown", { shiftKey: true }));
    assert.ok(page.root.querySelector("pre.md-block-selected"));
    assert.ok(press(page.root, "ArrowUp", { shiftKey: true }));
    assert.ok(!page.root.querySelector("pre.md-block-selected"));
    assert.ok(page.root.querySelector("table.md-block-selected"));
    assert.ok(press(page.root, "Delete"));
    assert.equal(page.text(), "First\n\n```\ncode\n```\n\nLast");
    press(document.activeElement, "z", { metaKey: true });
    assert.equal(page.text(), original);
  } finally {
    if (rangeRects) window.Range.prototype.getClientRects = rangeRects;
    else delete window.Range.prototype.getClientRects;
    window.HTMLElement.prototype.getBoundingClientRect = elementRect;
    page.close();
  }
});

test("a new table mirrors the input size before commit and its delete control removes the whole table", () => {
  const page = mount("Previous");
  try {
    const paragraph = page.root.querySelector("p");
    clickAt(paragraph, paragraph.firstChild, 8);
    press(document.activeElement, "Enter");
    type(document.activeElement, "/table");
    press(document.activeElement, "Enter");
    const field = document.activeElement;
    type(field, "Alpha\nBeta");
    assert.equal(page.root.querySelector(".md-cell-mirror").textContent, "Alpha\nBeta\u200b");
    assert.ok(!page.text().includes("Alpha"));
    const button = [...page.root.querySelectorAll(".md-table-controls button")].find((button) => button.textContent === "Delete Table");
    button.click();
    assert.equal(page.text(), "Previous");
    assert.equal(page.root.querySelector("table"), null);
    press(document.activeElement, "z", { metaKey: true });
    assert.match(page.text(), /Alpha<br>Beta/);
    assert.ok(page.root.querySelector("table"));
  } finally {
    page.close();
  }
});

test("edits a linked destination and label, keeping existing title and neighbouring reference", () => {
  const page = mount('[**one**](old "title") and [two][ref]\n\n[ref]: previous "reference"');
  try {
    const first = page.root.querySelector("a");
    first.dispatchEvent(new window.MouseEvent("click", { altKey: true, bubbles: true }));
    const form = page.root.querySelector("form");
    assert.equal(form.elements.href.value, "old");
    assert.equal(form.elements.label.value, "one");
    form.elements.href.value = "new.md#part";
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(page.text(), '[**one**](new.md#part "title") and [two][ref]\n\n[ref]: previous "reference"');
    page.root.querySelectorAll("a")[1].dispatchEvent(new window.MouseEvent("click", { altKey: true, bubbles: true }));
    const refForm = page.root.querySelector("form");
    refForm.elements.label.value = "renamed";
    refForm.elements.href.value = "another.md";
    refForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(page.text(), '[**one**](new.md#part "title") and [renamed](another.md "reference")\n\n[ref]: previous "reference"');
  } finally {
    page.close();
  }
});

test("Enter splits a paragraph and Shift+Enter creates a visible line break", () => {
  for (const shiftKey of [false, true]) {
    const page = mount("left right");
    try {
      const paragraph = page.root.querySelector("p");
      clickAt(paragraph, paragraph.firstChild, 5);
      press(document.activeElement, "Enter", { shiftKey });
      assert.equal(page.text(), shiftKey ? "left \\\nright" : "left \n\nright");
      assert.equal(page.root.querySelectorAll("p").length, shiftKey ? 1 : 2);
      assert.equal(page.root.querySelectorAll("br").length, Number(shiftKey));
      assert.equal(document.activeElement.textContent, "right");
      assert.equal(document.getSelection().anchorOffset, 0);
    } finally {
      page.close();
    }
  }
});

test("Enter at the end opens a new paragraph for typing and continues list items", () => {
  for (const [start, expected] of [["First", "First\n\nNext"], ["1. First", "1. First\n2. Next"]]) {
    const page = mount(start);
    try {
      const node = page.root.querySelector("p, li");
      clickAt(node, node.firstChild, 5);
      press(document.activeElement, "Enter");
      assert.equal(document.activeElement.getAttribute("contenteditable"), "plaintext-only");
      type(document.activeElement, "Next");
      document.activeElement.blur();
      assert.equal(page.text(), expected);
    } finally {
      page.close();
    }
  }
});

function clipboard(target, type, text) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  const data = new Map([["text/plain", text]]);
  Object.defineProperty(event, "clipboardData", { value: {
    getData: data.get.bind(data), setData: data.set.bind(data),
  } });
  target.dispatchEvent(event);
  assert.ok(event.defaultPrevented);
  return data.get("text/plain");
}

test("cuts across formatting runs, pastes multiple paragraphs, and supports undo and redo", () => {
  const page = mount("**alpha** and *beta* remain");
  try {
    const start = page.root.querySelector("strong").firstChild;
    const end = page.root.querySelector("em").firstChild;
    page.root.focus();
    document.getSelection().setBaseAndExtent(start, 2, end, 2);
    assert.equal(clipboard(page.root, "cut", ""), "pha and be");
    assert.equal(page.text(), "**al***ta* remain");
    document.activeElement.blur();
    const tail = page.root.querySelector("p").lastChild;
    clickAt(page.root.querySelector("p"), tail, tail.data.length);
    clipboard(document.activeElement, "paste", "\n\nPasted paragraph\n\nLast");
    assert.equal(page.text(), "**al***ta* remain\n\nPasted paragraph\n\nLast");
    press(document.activeElement, "z", { metaKey: true });
    assert.equal(page.text(), "**al***ta* remain");
    press(document.activeElement, "z", { metaKey: true, shiftKey: true });
    assert.match(page.text(), /Pasted paragraph/);
  } finally {
    page.close();
  }
});

test("Backspace at the start of a paragraph joins it with the previous one", () => {
  const page = mount("one\n\ntwo");
  try {
    const paragraph = page.root.querySelectorAll("p")[1];
    clickAt(paragraph, paragraph.firstChild, 0);
    press(document.activeElement, "Backspace");
    assert.equal(page.text(), "one two");
    assert.equal(document.getSelection().anchorOffset, 4);
  } finally {
    page.close();
  }
});

test("both delete keys remove an emptied code block and return the caret to the end of the previous paragraph", () => {
  for (const key of ["Backspace", "Delete"]) {
    for (const fence of ["```json\n{}\n```", "~~~~js\n\n~~~~", "```\n```"]) {
      const page = mount(`Previous **text**\n\n${fence}\n\n## Next`);
      try {
        const pre = page.root.querySelector("pre");
        press(pre, "Enter");
        const field = document.activeElement;
        if (field.value) type(field, "");
        const emptied = page.text();
        assert.ok(press(field, key));
        assert.equal(page.text(), "Previous **text**\n\n## Next");
        assert.equal(page.root.querySelector("pre"), null);
        assert.equal(document.activeElement.textContent, "text");
        assert.equal(document.getSelection().anchorOffset, 4);
        press(document.activeElement, "z", { metaKey: true });
        assert.equal(page.text(), emptied);
        assert.equal(document.activeElement.getAttribute("aria-label"), "Edit code block");
        press(document.activeElement, "z", { metaKey: true, shiftKey: true });
        assert.equal(page.text(), "Previous **text**\n\n## Next");
      } finally {
        page.close();
      }
    }
  }
});

test("deleting an empty fenced block preserves its neighbors and enclosing list", () => {
  for (const [initial, remaining, target, offset] of [
    ["```\n```\n\nFollowing", "Following", "Following", 0],
    ["Previous\n\n```", "Previous", "Previous", 8],
    ["Previous\n\n```\n```\n", "Previous\n", "Previous", 8],
    ["```\n```", "", "", 0],
    ["Previous\n\n> ```\n> ```\n\nNext", "Previous\n\n\nNext", "Previous", 8],
    ["- First\n- ```\n  ```\n- Next", "- First\n- \n- Next", "First", 5],
  ]) {
    const page = mount(initial);
    try {
      const pre = page.root.querySelector("pre");
      assert.ok(press(pre, "Backspace"));
      assert.equal(page.text(), remaining);
      assert.equal(document.activeElement.textContent, target);
      assert.equal(document.getSelection().anchorOffset, offset);
    } finally {
      page.close();
    }
  }
});

test("a second delete after clearing a paragraph or heading removes the empty block and moves to the previous end", () => {
  for (const [key, altKey] of [["Backspace", false], ["Delete", false], ["Backspace", true], ["Delete", true]]) {
    for (const block of ["Temporary", "## Temporary", "`Temporary`", "> Temporary"]) {
      const page = mount(`Previous\n\n${block}\n\nNext`);
      try {
        const nodes = page.root.querySelectorAll("p, h2");
        const element = nodes[1].querySelector("code") ?? nodes[1];
        clickAt(element, element.firstChild, 2);
        press(document.activeElement, "a", { metaKey: true });
        assert.ok(press(document.activeElement, key, { altKey }));
        const emptied = page.text();
        assert.match(emptied, /^Previous\n\n/);
        assert.ok(!emptied.includes("Temporary"));
        assert.ok(press(document.activeElement, key, { altKey }));
        assert.equal(page.text(), "Previous\n\nNext");
        assert.equal(document.activeElement.textContent, "Previous");
        assert.equal(document.getSelection().anchorOffset, 8);
        press(document.activeElement, "z", { metaKey: true });
        assert.equal(page.text(), emptied);
      } finally {
        page.close();
      }
    }
  }
});

test("Backspace from a fresh paragraph after code returns to the end of the code", () => {
  const initial = "```json\n{}\n```";
  const page = mount(initial);
  try {
    press(page.root.querySelector("pre"), "Enter");
    press(document.activeElement, "Enter", { metaKey: true });
    assert.equal(document.activeElement.getAttribute("aria-label"), "Edit Markdown text");
    assert.ok(press(document.activeElement, "Backspace"));
    assert.equal(page.text(), initial);
    assert.equal(document.activeElement.getAttribute("aria-label"), "Edit code block");
    assert.equal(document.activeElement.selectionStart, 2);
  } finally {
    page.close();
  }
});

test("Backspace on a pending inline format leaves the caret inside the same paragraph", () => {
  const page = mount("Previous\n\nSome text");
  try {
    const paragraph = page.root.querySelectorAll("p")[1];
    clickAt(paragraph, paragraph.firstChild, 4);
    press(document.activeElement, "C", { metaKey: true, shiftKey: true });
    assert.ok(press(document.activeElement, "Backspace"));
    assert.equal(page.text(), "Previous\n\nSome text");
    assert.equal(document.activeElement.textContent, "Some text");
    assert.equal(document.getSelection().anchorOffset, 4);
  } finally {
    page.close();
  }
});

test("typing replaces a visible non-editing selection, including mixed formatting", () => {
  const page = mount("one **two** three");
  try {
    const paragraph = page.root.querySelector("p");
    page.root.focus();
    document.getSelection().setBaseAndExtent(paragraph.firstChild, 1, paragraph.querySelector("strong").firstChild, 3);
    press(page.root, "x");
    assert.equal(page.text(), "ox three");
  } finally {
    page.close();
  }
});

test("edits code inside a quote and an initially empty fence without changing their markers", () => {
  for (const [before, after, value, expected] of [
    ["> ```\n>   a\n>   b\n> ```", "  a\n  b", "  a\n  B\n  C", "> ```\n>   a\n>   B\n>   C\n> ```"],
    ["```json\n```", "", "{}", "```json\n{}\n```"],
  ]) {
    const page = mount(before);
    try {
      const code = page.root.querySelector("pre > code");
      if (code.firstChild) clickAt(code, code.firstChild, 0);
      else press(code.parentElement, "Enter");
      const field = page.root.querySelector("textarea");
      assert.equal(field.value, after);
      type(field, value);
      press(field, "Escape");
      assert.equal(page.text(), expected);
    } finally {
      page.close();
    }
  }
});

test("modifier arrows stay in the code field and select the expected text ranges", () => {
  const page = mount('```json\n{\n  "columns": 3\n}\n```');
  try {
    const code = page.root.querySelector("code");
    clickAt(code, code.firstChild, 6);
    const field = page.root.querySelector("textarea");
    press(field, "ArrowUp", { metaKey: true });
    assert.equal(field.selectionStart, 0);
    press(field, "ArrowDown", { metaKey: true, shiftKey: true });
    assert.equal(field.selectionEnd, field.value.length);
    assert.equal(document.activeElement, field);
  } finally {
    page.close();
  }
});

test("task toggles affect only the selected list marker", () => {
  const page = mount("- [ ] First\n- [x] Done\n  - [ ] Nested");
  try {
    page.root.querySelectorAll('input[type="checkbox"]')[2].click();
    assert.equal(page.text(), "- [ ] First\n- [x] Done\n  - [x] Nested");
    page.root.querySelectorAll('input[type="checkbox"]')[1].click();
    assert.equal(page.text(), "- [ ] First\n- [ ] Done\n  - [x] Nested");
  } finally {
    page.close();
  }
});

test("Undo groups continuous typing and breaks the group after the native typing delay", () => {
  const page = mount("Text ");
  const oldNow = Date.now;
  let time = 1000;
  Date.now = () => time;
  try {
    const paragraph = page.root.querySelector("p");
    clickAt(paragraph, paragraph.firstChild, paragraph.firstChild.data.length);
    const field = document.activeElement;
    for (const character of "first") {
      time += 40;
      type(field, field.textContent + character);
    }
    time += 650;
    for (const character of " second") {
      time += 40;
      type(field, field.textContent + character);
    }
    press(field, "z", { metaKey: true });
    assert.equal(page.text(), "Text first");
    press(page.root, "z", { metaKey: true });
    assert.equal(page.text(), "Text ");
    press(page.root, "z", { metaKey: true, shiftKey: true });
    assert.equal(page.text(), "Text first");
  } finally {
    Date.now = oldNow;
    page.close();
  }
});

test("the first Select All stays in the active block, the second selects and copies the whole Markdown file", () => {
  for (const tag of ["p", "td", "code"]) {
    const doc = "# Heading\n\nFirst paragraph\n\n| Header |\n| --- |\n| cell |\n\n```text\ncode\n```";
    const page = mount(doc);
    try {
      const element = page.root.querySelector(tag);
      clickAt(element, element.firstChild, 1);
      const field = document.activeElement;
      press(field, "a", { metaKey: true });
      if (tag === "p") assert.equal(document.getSelection().toString(), "First paragraph");
      else assert.equal(field.selectionEnd - field.selectionStart, field.value.length);
      press(field, "a", { metaKey: true });
      assert.equal(document.activeElement, page.root);
      assert.match(document.getSelection().toString(), /First paragraph/);
      assert.equal(clipboard(page.root, "copy", ""), doc);
    } finally {
      page.close();
    }
  }
});

test("Undo joins typing when the final character matches the next source character", () => {
  const base = "left c right";
  const page = mount(base);
  try {
    const paragraph = page.root.querySelector("p");
    clickAt(paragraph, paragraph.firstChild, 5);
    const field = document.activeElement;
    let offset = 5;
    for (const char of "abc") {
      document.getSelection().collapse(field.firstChild, offset);
      field.dispatchEvent(new window.InputEvent("beforeinput", { inputType: "insertText", bubbles: true }));
      type(field, field.textContent.slice(0, offset) + char + field.textContent.slice(offset));
      offset++;
    }
    assert.equal(page.text(), "left abcc right");
    press(field, "z", { metaKey: true });
    assert.equal(page.text(), base);
  } finally {
    page.close();
  }
});

test("QA E09/E18: both selection directions replace only the selected text and normalize pasted CRLF", () => {
  const initial = "Alpha bravo\n\nCharlie delta";
  for (const reverse of [false, true]) {
    const page = mount(initial);
    try {
      const [a, b] = [...page.root.querySelectorAll("p")].map((p) => p.firstChild);
      const selection = document.getSelection();
      page.root.focus();
      if (reverse) selection.setBaseAndExtent(b, 7, a, 6);
      else selection.setBaseAndExtent(a, 6, b, 7);
      clipboard(page.root, "paste", "ñ ✅\r\n\r\nsecond");
      assert.equal(page.text(), "Alpha ñ ✅\n\nsecond delta");
      press(document.activeElement, "z", { metaKey: true });
      assert.equal(page.text(), initial);
    } finally {
      page.close();
    }
  }
});

test("QA E22: editing after Undo discards the old Redo branch", () => {
  const page = mount("Alpha");
  try {
    const para = page.root.querySelector("p");
    clickAt(para, para.firstChild, 5);
    type(document.activeElement, "Alpha bravo");
    press(document.activeElement, "z", { metaKey: true });
    assert.equal(page.text(), "Alpha");
    type(document.activeElement, "Alpha charlie");
    press(document.activeElement, "z", { metaKey: true, shiftKey: true });
    assert.equal(page.text(), "Alpha charlie");
  } finally {
    page.close();
  }
});

test("QA T07: pasted pipes, newlines, inline code and a link remain one GFM cell", () => {
  const page = mount("| Title | Keep |\n| --- | --- |\n| Old | Adjacent |");
  try {
    const cell = page.root.querySelector("td");
    clickAt(cell, cell.firstChild, 0);
    type(document.activeElement, "one | two\n`a|b` [link](next.md)");
    press(document.activeElement, "Enter");
    assert.equal(page.text(), "| Title | Keep |\n| --- | --- |\n| one \\| two<br>`a\\|b` [link](next.md) | Adjacent |");
    assert.equal(page.root.querySelectorAll("td").length, 2);
    assert.equal(page.root.querySelector("td code").textContent, "a|b");
    assert.equal(page.root.querySelector("td a").getAttribute("href"), "next.md");
  } finally {
    page.close();
  }
});

test("QA F10: read-only preview never opens editors or dispatches a deletion", () => {
  const initial = "Text\n\n- [ ] Task\n\n| A |\n| --- |\n| B |\n\n```\ncode\n```";
  const page = mount(initial, [EditorState.readOnly.of(true)]);
  try {
    for (const element of page.root.querySelectorAll("p,td,pre")) {
      element.click();
      press(element, "Enter");
    }
    page.root.focus();
    press(page.root, "a", { metaKey: true });
    press(page.root, "Backspace");
    assert.equal(page.text(), initial);
    assert.equal(page.root.querySelector("[contenteditable], textarea, .md-table-controls"), null);
    assert.ok(page.root.querySelector('input[type="checkbox"]').disabled);
  } finally {
    page.close();
  }
});

test("QA N06/N13/N19: document-edge shortcuts preserve the selection until Escape", () => {
  const value = "First line\n\nMiddle line\n\n| A |\n| --- |\n| B |\n\n```\ncode\n```\n\nLast line\n";
  const page = mount(value);
  try {
    const middle = page.root.querySelectorAll("p")[1];
    clickAt(middle, middle.firstChild, 3);
    assert.ok(press(document.activeElement, "ArrowDown", { metaKey: true, shiftKey: true }));
    const selected = document.getSelection().toString();
    assert.match(selected, /^dle line/);
    assert.match(selected, /code/);
    assert.match(selected, /Last line/);
    assert.ok(press(document.activeElement, "Escape"));
    assert.ok(document.getSelection().isCollapsed);
    assert.equal(document.activeElement.textContent, "Last line");
    assert.ok(press(document.activeElement, "ArrowUp", { metaKey: true }));
    assert.equal(document.activeElement.textContent, "First line");
    assert.equal(document.getSelection().focusOffset, 0);
    assert.equal(page.text(), value);
  } finally {
    page.close();
  }
});

test("QA N10/N11: horizontal selection stays in the paragraph and respects a separate whitespace run", () => {
  const page = mount("Above\n\nplain **bold** *italic* tail");
  try {
    const paragraph = page.root.querySelectorAll("p")[1];
    clickAt(paragraph, paragraph.firstChild, 6);
    assert.ok(press(document.activeElement, "ArrowRight", { altKey: true, shiftKey: true }));
    assert.equal(document.getSelection().toString(), "bold");
    assert.ok(press(document.activeElement, "Escape"));
    assert.equal(document.activeElement.textContent, "bold");
    const field = document.activeElement;
    document.getSelection().collapse(field.firstChild, 0);
    for (let step = 0; step < 10; step++) assert.ok(press(document.activeElement, "ArrowLeft", { shiftKey: true }));
    assert.equal(document.getSelection().toString(), "plain ");
    assert.equal(page.text(), "Above\n\nplain **bold** *italic* tail");
  } finally {
    page.close();
  }
});

test("QA N17: extending a click selection takes the target in the next paragraph", () => {
  const page = mount("First paragraph\n\nSecond paragraph");
  try {
    const [first, second] = page.root.querySelectorAll("p");
    clickAt(first, first.firstChild, 6);
    document.caretRangeFromPoint = () => {
      const range = document.createRange();
      range.setStart(second.firstChild, 6);
      return range;
    };
    second.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, shiftKey: true }));
    assert.equal(document.getSelection().toString(), "paragraph\nSecond");
  } finally {
    page.close();
  }
});

test("QA E03/E14/E16: line deletion, Enter at the start, and Cut/Paste preserve ordinary spaces", () => {
  const original = "Above\n\nAlpha bravo charlie\n\nBelow";
  const page = mount(original);
  try {
    const para = page.root.querySelectorAll("p")[1];
    clickAt(para, para.firstChild, 5);
    press(document.activeElement, "Delete", { metaKey: true });
    assert.equal(page.text(), "Above\n\nAlpha\n\nBelow");
    press(document.activeElement, "z", { metaKey: true });
    const field = document.activeElement;
    document.getSelection().setBaseAndExtent(field.firstChild, 6, field.firstChild, 11);
    assert.equal(clipboard(field, "cut"), "bravo");
    clipboard(document.activeElement, "paste", "bravo");
    assert.equal(page.text(), original);
    document.getSelection().collapse(document.activeElement.firstChild, 0);
    press(document.activeElement, "Enter");
    clipboard(document.activeElement, "paste", "Inserted");
    assert.equal(page.text(), "Above\n\nInserted\n\nAlpha bravo charlie\n\nBelow");
  } finally {
    page.close();
  }
});

test("QA B11/B12: escaping inline formatting keeps the caret; escaped backticks can become code", () => {
  const page = mount("Plain text\n\nEscaped \\`backticks\\` here.");
  try {
    const [para, escaped] = page.root.querySelectorAll("p");
    clickAt(para, para.firstChild, 10);
    press(document.activeElement, "i", { metaKey: true });
    press(document.activeElement, "Escape");
    clipboard(document.activeElement, "paste", " at end");
    assert.match(page.text(), /^Plain text at end\n/);
    const label = page.root.querySelectorAll("p")[1].firstChild;
    page.root.focus();
    document.getSelection().setBaseAndExtent(label, 0, label, label.length);
    assert.ok(press(page.root, "C", { metaKey: true, shiftKey: true }));
    assert.equal(page.text(), "Plain text at end\n\n``Escaped `backticks` here.``");
    assert.equal(document.getSelection().toString(), escaped.textContent);
  } finally {
    page.close();
  }
});

test("vertical selection takes the current paragraph and then adjacent whole paragraphs in both directions", () => {
  const original = "One\n\nMiddle **formatted** and `code`\n\nEnd";
  const rangeRects = window.Range.prototype.getClientRects;
  const elementRect = window.HTMLElement.prototype.getBoundingClientRect;
  const rect = (element, left) => {
    const top = Number(element.closest("[data-line]")?.dataset.line ?? 0) * 30;
    return { top, bottom: top + 20, height: 20, left, right: left + 80 };
  };
  window.Range.prototype.getClientRects = function () {
    const node = this.startContainer;
    return [rect(node.nodeType === 1 ? node : node.parentElement, this.collapsed ? this.startOffset * 8 : 0)];
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return rect(this, 0); };
  try {
    for (const upwards of [true, false]) {
      const page = mount(original);
      try {
        const paragraphs = page.root.querySelectorAll("p");
        const start = upwards ? paragraphs[2].firstChild : paragraphs[0].firstChild;
        const offset = upwards ? start.length : 0;
        clickAt(start.parentElement, start, offset);
        const select = (up) => assert.ok(press(document.activeElement, up ? "ArrowUp" : "ArrowDown", { shiftKey: true }));
        const selected = () => document.getSelection().toString();
        const own = upwards ? "End" : "One";
        select(upwards);
        assert.equal(selected(), own);
        select(upwards);
        assert.deepEqual(selected().split(/\n+/), upwards ? ["Middle formatted and code", own] : [own, "Middle formatted and code"]);
        select(!upwards);
        assert.equal(selected(), own);
        select(!upwards);
        assert.ok(document.getSelection().isCollapsed);
        assert.equal(document.getSelection().focusOffset, offset);
        assert.equal(page.text(), original);
      } finally {
        page.close();
      }
    }
  } finally {
    if (rangeRects) window.Range.prototype.getClientRects = rangeRects;
    else delete window.Range.prototype.getClientRects;
    window.HTMLElement.prototype.getBoundingClientRect = elementRect;
  }
});

test("Shift+Up selects by visual line inside a wrapped paragraph before crossing its edge", () => {
  const page = mount("Previous\n\nabcdefghijkl");
  const rangeRects = window.Range.prototype.getClientRects;
  const rect = (line, left, right) => ({ top: line * 20, bottom: line * 20 + 15, height: 15, left, right });
  window.Range.prototype.getClientRects = function () {
    const node = this.startContainer;
    if (node.textContent.includes("Previous")) return [rect(0, 0, 64)];
    if (!this.collapsed) return [rect(3, 0, 48), rect(4, 0, 48)];
    const offset = this.startOffset;
    return [rect(offset < 6 ? 3 : 4, (offset % 6) * 8, (offset % 6) * 8)];
  };
  try {
    const paragraph = page.root.querySelectorAll("p")[1];
    clickAt(paragraph, paragraph.firstChild, 9);
    document.caretRangeFromPoint = (x, y) => {
      const text = page.root.querySelectorAll("p")[y < 20 ? 0 : 1].querySelector("[contenteditable]")?.firstChild ??
        page.root.querySelectorAll("p")[y < 20 ? 0 : 1].firstChild;
      const range = document.createRange();
      range.setStart(text, Math.min(text.length, Math.round(x / 8)));
      return range;
    };
    press(document.activeElement, "ArrowUp", { shiftKey: true });
    assert.equal(document.getSelection().toString(), "defghi");
    press(document.activeElement, "ArrowUp", { shiftKey: true });
    assert.equal(document.getSelection().toString(), "abcdefghi");
    press(document.activeElement, "ArrowUp", { shiftKey: true });
    assert.match(document.getSelection().toString(), /^Previous\n+abcdefghi$/);
  } finally {
    if (rangeRects) window.Range.prototype.getClientRects = rangeRects;
    else delete window.Range.prototype.getClientRects;
    page.close();
  }
});

test("plain arrows exit a rendered selection and resume caret movement in both directions", () => {
  const original = "First\n\nAbove\n\nSelected\n\nBelow\n\nLast";
  const rangeRects = window.Range.prototype.getClientRects;
  const elementRect = window.HTMLElement.prototype.getBoundingClientRect;
  const rect = (element, left) => {
    const top = Number(element.closest("[data-line]")?.dataset.line ?? 0) * 30;
    return { top, bottom: top + 20, height: 20, left, right: left + 80 };
  };
  window.Range.prototype.getClientRects = function () {
    const node = this.startContainer;
    return [rect(node.nodeType === 1 ? node : node.parentElement, this.collapsed ? this.startOffset * 8 : 0)];
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return rect(this, 0); };
  try {
    for (const [key, expected, caret] of [
      ["ArrowLeft", "Selected", 0], ["ArrowRight", "Selected", 8],
      ["ArrowUp", "Above"], ["ArrowDown", "Below"],
    ]) {
      const page = mount(original);
      try {
        const paragraph = page.root.querySelectorAll("p")[2];
        clickAt(paragraph, paragraph.firstChild, 8);
        assert.ok(press(document.activeElement, "ArrowUp", { shiftKey: true }));
        assert.equal(document.getSelection().toString(), "Selected");
        assert.ok(press(document.activeElement, key));
        assert.ok(document.getSelection().isCollapsed, key);
        assert.equal(document.activeElement.textContent, expected, key);
        if (caret !== undefined) assert.equal(document.getSelection().focusOffset, caret, key);
        else {
          assert.ok(press(document.activeElement, key));
          assert.equal(document.activeElement.textContent, key === "ArrowUp" ? "First" : "Last");
        }
        assert.equal(page.text(), original);
      } finally {
        page.close();
      }
    }
  } finally {
    if (rangeRects) window.Range.prototype.getClientRects = rangeRects;
    else delete window.Range.prototype.getClientRects;
    window.HTMLElement.prototype.getBoundingClientRect = elementRect;
  }
});

test("horizontal collapse of a whole code block places the caret on the corresponding code edge", () => {
  for (const [key, caret] of [["ArrowLeft", 0], ["ArrowRight", 8]]) {
    const page = mount("Before\n\n```\nlet x = 1\n```\n\nAfter");
    try {
      const pre = page.root.querySelector("pre");
      page.root.focus();
      document.getSelection().setBaseAndExtent(pre, 0, pre, pre.childNodes.length);
      page.root.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      assert.ok(pre.classList.contains("md-block-selected"));
      assert.ok(press(page.root, key));
      assert.ok(document.getSelection().isCollapsed);
      assert.ok(!pre.classList.contains("md-block-selected"));
      assert.match(document.activeElement.getAttribute("aria-label"), /^Edit code block/);
      assert.equal(document.activeElement.selectionStart, caret === 0 ? 0 : document.activeElement.value.length);
    } finally {
      page.close();
    }
  }
});
