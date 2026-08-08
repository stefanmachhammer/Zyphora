/**
 * HTML sanitizer for every piece of user-authored markup before storage.
 *
 * The allowlist is deliberately narrow — just what the TipTap toolbar produces.
 * Each added tag widens the security boundary, so prefer matching an existing
 * tag over opening an exotic one.
 *
 * IMPORTANT: every rich-HTML field must pass through this before insert/update.
 * The public site renders post HTML raw (`set:html` / Eta `<%~ %>`), which is
 * safe ONLY because of this. Bypassing it is stored XSS.
 *
 * Excluded on purpose: `<script>`, `<iframe>`, inline event handlers (DOMPurify
 * defaults), and `data-*` (unused, common CSS/script smuggling vector).
 */
import DOMPurify from 'isomorphic-dompurify';

/** Run untrusted HTML through DOMPurify with the project allowlist. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li',
      'a', 'img', 'figure', 'figcaption',
      'hr', 'span', 'div',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
}