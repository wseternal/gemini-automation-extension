/**
 * utils/dom-to-markdown.ts — convert Gemini's response DOM to Markdown.
 *
 * Gemini renders responses inside a `<message-content>` container with custom
 * Angular elements (e.g. `<code-block>`, `<response-element>`) alongside
 * standard HTML (tables, headings, lists). This converter walks the DOM tree
 * and produces a Markdown string that preserves structure for rendering
 * with `marked.parse()` in the history view.
 */

/**
 * Convert a Gemini response container element to Markdown.
 * Accepts the root element returned by the response-container selector.
 */
export function convertDomToMarkdown(root: Element): string {
  const parts: string[] = [];
  walkChildren(root, parts, 0);
  return cleanOutput(parts.join(''));
}

/** Recursively walk child nodes, appending Markdown to `out`. */
function walkChildren(node: Node, out: string[], listDepth: number): void {
  for (const child of Array.from(node.childNodes)) {
    walkNode(child, out, listDepth);
  }
}

/** Dispatch a single node to the appropriate handler. */
function walkNode(node: Node, out: string[], listDepth: number): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? '';
    out.push(escapeMarkdown(text));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as Element;
  const tag = el.tagName.toLowerCase();

  // Skip hidden / decorative elements.
  if (isHidden(el)) return;

  // --- Gemini custom elements ---
  if (tag === 'code-block') {
    handleCodeBlock(el, out);
    return;
  }
  if (tag === 'response-element') {
    walkChildren(el, out, listDepth);
    return;
  }

  // --- Standard HTML elements ---
  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag[1]);
      out.push('\n\n' + '#'.repeat(level) + ' ');
      walkChildren(el, out, listDepth);
      out.push('\n\n');
      break;
    }

    case 'p': {
      // Suppress extra newlines for <p> inside <li> to keep bullet and text on same line.
      const isInsideListItem = el.parentElement?.tagName.toLowerCase() === 'li';
      if (!isInsideListItem) {
        out.push('\n\n');
      }
      walkChildren(el, out, listDepth);
      if (!isInsideListItem) {
        out.push('\n\n');
      }
      break;
    }

    case 'br':
      out.push('  \n');
      break;

    case 'hr':
      out.push('\n\n---\n\n');
      break;

    case 'strong':
    case 'b':
      out.push('**');
      walkChildren(el, out, listDepth);
      out.push('**');
      break;

    case 'em':
    case 'i':
      out.push('*');
      walkChildren(el, out, listDepth);
      out.push('*');
      break;

    case 'del':
    case 's':
      out.push('~~');
      walkChildren(el, out, listDepth);
      out.push('~~');
      break;

    case 'code':
      // Inline code (not inside a code-block, which is handled above).
      if (!el.closest('code-block')) {
        const code = el.textContent ?? '';
        out.push('`' + code + '`');
      }
      break;

    case 'pre':
      // Standalone <pre> not inside a code-block.
      if (!el.closest('code-block')) {
        out.push('\n\n```\n');
        out.push(el.textContent ?? '');
        out.push('\n```\n\n');
      }
      break;

    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const text = el.textContent ?? '';
      if (href && text) {
        // Only allow safe URI schemes to prevent javascript: injection.
        const safeHref = /^(https?:|mailto:|#)/i.test(href) ? href : '';
        if (safeHref) {
          out.push(`[${escapeMarkdown(text)}](${safeHref})`);
        } else {
          out.push(escapeMarkdown(text));
        }
      } else {
        walkChildren(el, out, listDepth);
      }
      break;
    }

    case 'blockquote':
      out.push('\n\n');
      for (const line of (el.textContent ?? '').split('\n')) {
        out.push('> ' + escapeMarkdown(line) + '\n');
      }
      out.push('\n');
      break;

    case 'ul':
      out.push('\n\n');
      for (const li of el.querySelectorAll(':scope > li')) {
        out.push('  '.repeat(listDepth) + '- ');
        walkChildren(li, out, listDepth + 1);
        out.push('\n');
      }
      out.push('\n');
      break;

    case 'ol':
      out.push('\n\n');
      let idx = 1;
      for (const li of el.querySelectorAll(':scope > li')) {
        out.push('  '.repeat(listDepth) + `${idx}. `);
        walkChildren(li, out, listDepth + 1);
        out.push('\n');
        idx++;
      }
      out.push('\n');
      break;

    case 'table':
      handleTable(el, out);
      break;

    // Transparent containers — recurse into children.
    case 'div':
    case 'span':
    case 'section':
    case 'article':
    case 'main':
    case 'message-content':
      walkChildren(el, out, listDepth);
      break;

    // Fallback: recurse.
    default:
      walkChildren(el, out, listDepth);
      break;
  }
}

/**
 * Handle a Gemini `<code-block>` custom element.
 *
 * Structure:
 *   <code-block>
 *     <div class="code-block ...">
 *       <div class="formatted-code-block-internal-container">
 *         <div class="code-block-decoration header-formatted ...">
 *           <span>Python</span>
 *         </div>
 *         <pre><code class="code-container">...code...</code></pre>
 *         <div class="code-block-decoration header ...">
 *           Code output
 *         </div>
 *         <pre><code class="code-result-container">...output...</code></pre>
 *       </div>
 *     </div>
 *   </code-block>
 */
function handleCodeBlock(el: Element, out: string[]): void {
  // Extract language from the header.
  const header = el.querySelector('.code-block-decoration.header-formatted span');
  const lang = header?.textContent?.trim().toLowerCase() ?? '';

  // Extract source code from the code container.
  const codeEl = el.querySelector('code.code-container, code.formatted');
  const code = codeEl?.textContent ?? '';

  out.push('\n\n```' + lang + '\n');
  out.push(code);
  out.push('\n```\n\n');

  // Extract code output if present.
  const outputHeader = el.querySelector('.code-block-decoration.header');
  if (outputHeader && /output/i.test(outputHeader.textContent ?? '')) {
    const outputEl = el.querySelector('code.code-result-container');
    const output = outputEl?.textContent ?? '';
    if (output.trim().length > 0) {
      out.push('\n\n```\n');
      out.push(output);
      out.push('\n```\n\n');
    }
  }
}

/**
 * Convert an HTML table to a Markdown table.
 */
function handleTable(el: Element, out: string[]): void {
  const rows = el.querySelectorAll('tr');
  if (rows.length === 0) return;

  out.push('\n\n');

  // Detect whether the first row contains <th> elements (explicit header).
  const firstRowCells = rows[0].querySelectorAll('th, td');
  const hasHeader = firstRowCells.length > 0 && firstRowCells[0].tagName.toLowerCase() === 'th';

  if (!hasHeader) {
    // No explicit header — generate an empty placeholder row + separator.
    const colCount = firstRowCells.length;
    out.push('| ' + Array(colCount).fill(' ').join(' | ') + ' |\n');
    out.push('| ' + Array(colCount).fill('---').join(' | ') + ' |\n');
  }

  let headerDone = false;
  for (const row of rows) {
    const cells = row.querySelectorAll('th, td');
    const cellTexts = Array.from(cells).map((c) => {
      const text = c.textContent?.trim() ?? '';
      // Escape pipes within cell content.
      return escapeMarkdown(text).replace(/\|/g, '\\|');
    });

    out.push('| ' + cellTexts.join(' | ') + ' |\n');

    // Add separator after the first row only when it contains <th>.
    if (hasHeader && !headerDone) {
      out.push('| ' + cellTexts.map(() => '---').join(' | ') + ' |\n');
      headerDone = true;
    }
  }

  out.push('\n');
}

/** Check if an element is visually hidden. */
function isHidden(el: Element): boolean {
  if (el instanceof HTMLElement) {
    if (el.hidden) return true;
    const style = el.style;
    if (style.display === 'none' || style.visibility === 'hidden') return true;
  }
  return false;
}

/**
 * Escape characters that have special meaning in Markdown.
 * Also escapes HTML angle brackets to prevent raw HTML from leaking
 * into the output (marked v18+ does not sanitize HTML by default).
 * Exported for contract testing.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`');
}

/** Clean up excessive blank lines, trim, and strip UI attribution. Exported for contract testing. */
export function cleanOutput(text: string): string {
  return text
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ newlines to 2
    .replace(/^(?:Gemini|DeepSeek|ChatGPT|Claude)\s+said\s*\n*/i, '') // strip UI attribution
    .trim();
}
