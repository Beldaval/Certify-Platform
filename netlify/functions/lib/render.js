// Turns a template SVG + a single field_values map into a rendered PDF buffer.
// field_values is keyed by the template's own field ids (from templates.json)
// and holds three kinds of values depending on that field's declared type:
//   text          -> a string, replaces the element's text content
//   image         -> a data: URI, set as the element's href
//   block-toggle  -> a boolean; false blanks the block, true/absent leaves
//                     the template's own default content untouched
//
// An image field can also declare "hide_container": "<some-group-id>" in
// templates.json. When that field is left blank, the whole named <g>
// wrapper (placeholder box, label, caption/title text, etc.) is removed
// from the SVG entirely, instead of just clearing the image href and
// leaving an empty frame behind. Used for optional signature/seal slots
// whose surrounding UI shouldn't render at all if unused.
//
// An image field can also declare "image_target_id": "<some-element-id>" in
// templates.json. Some templates put the field's own id on a wrapping <g>
// (for layout/placeholder purposes) rather than on the actual <image>
// element that needs the href written to it. When present, image_target_id
// names the real element to write to; render.js falls back to field.id
// when it's absent, which is correct for templates where the field id and
// the <image> id are the same. Getting this wrong doesn't throw — it
// silently writes href onto the wrong (non-image) element, and the
// uploaded logo/signature just never appears. See baby-dedication in
// templates.json for a template that needs this.
//
// FIX (see incident: baby-dedication batch failures, Aug 2026): every
// uploaded image is now normalized through sharp -> PNG before it's
// base64-embedded into the SVG. resvg-js's native image decoder only
// reliably handles PNG/baseline JPEG; a phone-uploaded HEIC, a
// progressive/CMYK JPEG, or a WebP can make it panic with an opaque
// 'GenericFailure' and no further detail. Running everything through
// sharp first means anything we accept is guaranteed to be something
// resvg can parse, and anything sharp itself can't decode fails with a
// real, actionable error at upload-normalization time instead of a bare
// crash deep inside the renderer.
//
// Uses @resvg/resvg-js (a small native SVG rasterizer — no headless browser
// needed, keeping the function bundle light) and pdf-lib to wrap the raster
// into a print-ready single-page PDF sized to the template's canvas.
//
// FONT NOTE: resvg has no fonts of its own and Netlify's function
// containers don't have Georgia/Palatino/Helvetica Neue (or any fonts)
// installed. Every template's font-family list ends in a generic
// "serif" or "sans-serif" keyword, so we bundle Gelasio (an open,
// metric-compatible Georgia substitute) and Arimo (same, for
// Arial/Helvetica) and tell resvg to use them for those generic
// fallbacks via serifFamily/sansSerifFamily below.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');

// FIX (deploy incident, Aug 2026): this used to be computed as
// path.join(__dirname, '..', '..', '..', 'public', 'assets', 'templates'),
// assuming render.js always lives at netlify/functions/lib/render.js on
// disk at runtime. That broke the moment esbuild started bundling this
// file normally (once sharp/resvg were marked external, esbuild inlined
// lib/render.js's code directly into generate-batch-background.js instead
// of keeping it as a separate required file) — __dirname then pointed at
// netlify/functions instead of netlify/functions/lib, one level shallower
// than the old math assumed, so '../../../' overshot past the deploy root
// entirely (resulting in ENOENT for /var/public/assets/templates/...).
//
// Netlify Functions run on AWS Lambda, which always sets
// LAMBDA_TASK_ROOT=/var/task as the deploy root regardless of how the
// bundler flattens or inlines files inside it. included_files in
// netlify.toml preserve their original repo-relative path under that
// root, so anchoring to LAMBDA_TASK_ROOT instead of __dirname is stable
// no matter how the function bundle's internal file layout changes.
const TASK_ROOT = process.env.LAMBDA_TASK_ROOT || path.join(__dirname, '..', '..', '..');
const TEMPLATES_DIR = path.join(TASK_ROOT, 'public', 'assets', 'templates');
const FONTS_DIR = path.join(TASK_ROOT, 'netlify', 'functions', 'lib'); // matches included_files entry in netlify.toml

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Parses a "data:<mime>;base64,<payload>" string into its raw Buffer + mime.
// Returns null if str isn't a data URI (e.g. empty string on a blank
// optional slot) so callers can tell "no image" apart from "bad image".
function parseDataUri(str) {
  if (!str) return null;
  const m = /^data:([^;]+);base64,(.*)$/s.exec(str);
  if (!m) return null;
  return { mime: m[1], buffer: Buffer.from(m[2], 'base64') };
}

// Re-encodes an uploaded image to PNG via sharp so resvg's native decoder
// never has to deal with a format/variant it can't handle. Throws a
// descriptive error (instead of letting a bad image reach resvg and crash
// with an opaque GenericFailure) if sharp itself can't decode the input.
async function normalizeImageDataUri(dataUri, fieldId) {
  const parsed = parseDataUri(dataUri);
  if (!parsed) {
    // FIX (incident: "expected 'g' tag, not 'tspan'" parse corruption):
    // a non-empty value that ISN'T a well-formed data URI used to be
    // passed straight through and written unescaped into an href
    // attribute in buildSvg. If that value contained a literal `"`, it
    // silently terminated the attribute early and everything after it
    // (however that string happened to be shaped) was parsed as real SVG
    // markup — corrupting document structure in a way that only surfaces
    // as a confusing mismatched-tag error dozens of lines later, nowhere
    // near the actual image field. Whatever upstream reason produced a
    // non-data-URI value here (failed upload, a stray error string, etc.)
    // it must never reach the SVG. Treat it as blank instead of trusting
    // it, and log loudly so the upstream bug that produced it is visible.
    if (dataUri) {
      console.error(
        `[render] Field "${fieldId}" had a non-data-URI image value and was dropped instead of embedded: ` +
        `${JSON.stringify(String(dataUri).slice(0, 120))}`
      );
    }
    return '';
  }
  try {
    const pngBuffer = await sharp(parsed.buffer).rotate().png().toBuffer();
    return `data:image/png;base64,${pngBuffer.toString('base64')}`;
  } catch (err) {
    throw new Error(
      `Image for field "${fieldId}" could not be decoded (${parsed.mime}, ${parsed.buffer.length} bytes): ${err.message}`
    );
  }
}

async function normalizeFieldValues(templateDef, fieldValues) {
  const values = { ...(fieldValues || {}) };
  for (const field of templateDef.fields) {
    if (field.type === 'image' && values[field.id]) {
      values[field.id] = await normalizeImageDataUri(values[field.id], field.id);
    }
  }
  return values;
}

// FIX (Aug 2026 — Baby Dedication removal follow-up: Signature 2 / Seal
// placeholders surviving in output): both hide_container removal and
// block-toggle removal used to match "<tag ... id="X">[\s\S]*?</tag>" —
// a lazy match that stops at the FIRST closing tag of that name it finds.
// Every signature/seal container nests its own inner <g> (placeholder box,
// label, caption/title text), so the lazy match closed on that inner </g>
// instead of the container's own, leaving the outer wrapper's remainder —
// including the literal "Signature (PNG)" / "Seal" placeholder text —
// still in the document. This walks the tag stream counting open/close
// pairs of the same tag name (ignoring self-closing tags) to find the
// container's true matching close tag, however deeply it's nested, and
// removes exactly that span. Returns the svg unchanged if the id isn't
// found, so a bad/missing id in templates.json fails silently (same as
// before) rather than corrupting the document.
function removeElementById(svg, tagName, elementId) {
  const openTagRe = new RegExp(`<${tagName}\\b[^>]*\\bid="${elementId}"[^>]*>`);
  const openMatch = openTagRe.exec(svg);
  if (!openMatch || openMatch[0].endsWith('/>')) return svg; // not found, or self-closing (nothing to remove)

  const startIdx = openMatch.index;
  const tagStreamRe = new RegExp(`<\\/?${tagName}\\b[^>]*?>`, 'g');
  tagStreamRe.lastIndex = startIdx + openMatch[0].length;

  let depth = 1;
  let m;
  while ((m = tagStreamRe.exec(svg)) !== null) {
    const tag = m[0];
    if (tag.startsWith('</')) {
      depth--;
      if (depth === 0) {
        const endIdx = m.index + tag.length;
        return svg.slice(0, startIdx) + svg.slice(endIdx);
      }
    } else if (!tag.endsWith('/>')) {
      depth++;
    }
    // self-closing opening tags (<tag ... />) don't change depth
  }
  return svg; // unbalanced/malformed — leave untouched rather than guess
}

function buildSvg(templateDef, fieldValues) {
  const svgPath = path.join(TEMPLATES_DIR, templateDef.svg_file || templateDef.file);
  let svg;
  try {
    svg = fs.readFileSync(svgPath, 'utf8');
  } catch (err) {
    // FIX: if the path is ever wrong again (bundler changes, moved files,
    // etc.), list what's actually there instead of a bare ENOENT so it's
    // a one-log-line fix instead of another guess-and-redeploy cycle.
    let dirListing = '(could not read parent directory)';
    try {
      dirListing = fs.readdirSync(path.dirname(svgPath)).join(', ');
    } catch (_) { /* parent directory itself missing — leave default message */ }
    console.error(
      `[render] Could not read template SVG at "${svgPath}" (TEMPLATES_DIR="${TEMPLATES_DIR}", ` +
      `TASK_ROOT="${TASK_ROOT}", __dirname="${__dirname}"). Directory contents: ${dirListing}`
    );
    throw err;
  }
  const values = fieldValues || {};

  for (const field of templateDef.fields) {
    const raw = values[field.id];

    if (field.type === 'text') {
      const safe = escapeXml(raw ?? '');
      const re = new RegExp(`(<[^>]+id="${field.id}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z]+>)`);
      svg = svg.replace(re, (m, open, _old, close) => `${open}${safe}${close}`);

    } else if (field.type === 'image') {
      // FIX: write to field.image_target_id when the template declares one
      // (field id is on a wrapping <g>, not the <image> itself); otherwise
      // fall back to field.id, which is correct for templates where the
      // <image> element carries the field id directly.
      const targetId = field.image_target_id || field.id;
      const reHref = new RegExp(`(<[^>]+id="${targetId}"[^>]*?)(?:xlink:href|href)="[^"]*"`);
      // FIX: belt-and-suspenders on top of normalizeFieldValues dropping
      // non-data-URI values upstream — never write a raw value into an
      // attribute. escapeXml neutralizes a stray `"` (or `<`/`>`) that
      // would otherwise terminate the href attribute early and get the
      // remainder of the string parsed as real markup, corrupting the
      // document structure well past this point.
      const dataUri = escapeXml(raw || '');
      if (reHref.test(svg)) {
        svg = svg.replace(reHref, `$1href="${dataUri}"`);
      } else if (dataUri) {
        const reOpen = new RegExp(`(<[^>]+id="${targetId}")`);
        svg = svg.replace(reOpen, `$1 href="${dataUri}"`);
      }
      // no upload on an optional slot -> href left empty, slot renders blank

      if (!dataUri && field.hide_container) {
        // Optional slot left blank -> remove the whole wrapper block
        // (dashed placeholder box, label, caption/title text) so nothing
        // is left dangling, instead of just clearing the image href.
        // Uses removeElementById (balanced-tag scan) so containers with
        // their own nested <g> children are removed in full, not just up
        // to their first inner close tag — see fix note above.
        svg = removeElementById(svg, 'g', field.hide_container);
      }

    } else if (field.type === 'block-toggle') {
      if (raw === false) {
        // Find the actual tag name the id sits on (usually <g>, could be
        // any element) and remove that element's full span via
        // removeElementById's balanced-tag scan — correct for blocks
        // wrapping more than one child element (e.g. two <text> lines),
        // where a naive "stop at the first closing tag" match would clip
        // off after the first child instead of the block's own close tag.
        const tagMatch = svg.match(new RegExp(`<([a-zA-Z]+)[^>]+id="${field.id}"`));
        if (tagMatch) {
          svg = removeElementById(svg, tagMatch[1], field.id);
        }
      }
      // true/undefined -> leave the template's own default content as-is
    }
  }

  return svg;
}

async function renderCertificate({ templateDef, fieldValues, recipientLabel }) {
  // FIX: normalize every uploaded image to PNG via sharp before it's
  // embedded, so resvg never has to decode a format/variant it can't
  // handle. Errors here are descriptive (which field, what was wrong)
  // instead of an opaque native crash later.
  const normalizedValues = await normalizeFieldValues(templateDef, fieldValues);
  const svg = buildSvg(templateDef, normalizedValues);
  const pxW = templateDef.canvas_width || templateDef.canvas.width;
  const pxH = templateDef.canvas_height || templateDef.canvas.height;

  let resvg;
  try {
    resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: pxW },
      background: 'white',
      font: {
        fontFiles: [
          path.join(FONTS_DIR, 'Gelasio-Regular.ttf'),
          path.join(FONTS_DIR, 'Gelasio-Bold.ttf'),
          path.join(FONTS_DIR, 'Gelasio-Italic.ttf'),
          path.join(FONTS_DIR, 'Gelasio-BoldItalic.ttf'),
          path.join(FONTS_DIR, 'Arimo-Regular.ttf'),
          path.join(FONTS_DIR, 'Arimo-Bold.ttf'),
        ],
        loadSystemFonts: false, // none exist in this container — skip the scan
        defaultFontFamily: 'Gelasio',
        serifFamily: 'Gelasio',
        sansSerifFamily: 'Arimo',
      },
    });
  } catch (err) {
    // FIX: a bare Resvg constructor failure gives no context beyond a
    // native stack trace. Log enough to actually debug it — which
    // template/recipient, how big the final SVG was, and which image
    // fields carried data — before rethrowing.
    const imageFieldSizes = templateDef.fields
      .filter((f) => f.type === 'image')
      .map((f) => `${f.id}=${normalizedValues[f.id] ? normalizedValues[f.id].length + 'b' : 'blank'}`)
      .join(', ');
    console.error(
      `[render] Resvg parse/construct failed for template="${templateDef.id}" recipient="${recipientLabel || 'unknown'}" ` +
      `svgLength=${svg.length} imageFields={${imageFieldSizes}}: ${err.message}`
    );
    // FIX: resvg's parse errors report a line:col INTO THE FINAL SVG
    // (e.g. "expected 'g' tag, not 'tspan' at 113:27"), which the svg head
    // alone can't show for anything past the first ~10 lines. Extract that
    // position from the error message and print the surrounding lines
    // instead, so the actual offending markup is in the log directly.
    const posMatch = /at (\d+):(\d+)/.exec(err.message);
    if (posMatch) {
      const line = parseInt(posMatch[1], 10);
      const lines = svg.split('\n');
      const from = Math.max(0, line - 4);
      const to = Math.min(lines.length, line + 3);
      const context = lines.slice(from, to)
        .map((l, i) => `${from + i + 1}: ${l}`)
        .join('\n');
      console.error(`[render] svg around reported error (line ${line}):\n${context}`);
    } else {
      console.error(`[render] svg head: ${svg.slice(0, 500)}`);
    }
    throw err;
  }

  const pngBuffer = resvg.render().asPng();

  // Wrap into a single-page PDF, scaled down from the high-res px canvas to a
  // reasonable point size so the PDF stays a manageable print size.
  const scale = 792 / pxW;
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([pxW * scale, pxH * scale]);
  const pngImage = await pdfDoc.embedPng(pngBuffer);
  page.drawImage(pngImage, { x: 0, y: 0, width: pxW * scale, height: pxH * scale });
  const pdfBytes = await pdfDoc.save();

  return { pngBuffer, pdfBytes };
}

module.exports = { renderCertificate, buildSvg };
