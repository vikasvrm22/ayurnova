/**
 * Phase 7 - the one allowlist every piece of admin-authored rich-text HTML
 * (currently: legal_pages.content_html) passes through before it is
 * either stored or rendered on a public page. Two call sites use this
 * (legalAdmin.js on save, pages.js again on render) deliberately - never
 * trusting the browser's contenteditable DOM state alone to have produced
 * only safe markup, the same "never trust the client" principle checkout
 * validation and payment verification already apply elsewhere in this
 * codebase.
 */
import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p", "br", "h2", "h3", "h4", "ul", "ol", "li",
  "strong", "b", "em", "i", "u", "a", "blockquote", "span",
];

export function sanitizeRichText(html) {
  return sanitizeHtml(html || "", {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ["href", "title", "target", "rel"] },
    allowedSchemes: ["http", "https", "mailto"],
    // Strip disallowed tags but keep their text content (e.g. a stray
    // <div> around a paragraph loses the wrapper, not the words) -
    // matches how a plain-text editor's output degrades, never silently
    // drops customer-facing policy text.
    disallowedTagsMode: "discard",
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
    },
  });
}
