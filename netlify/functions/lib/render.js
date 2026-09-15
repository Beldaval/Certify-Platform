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
// An image field can also declare "reposition_sibling_if_empty":
// { "id": "<some-element-id>", "transform": "<svg transform value>" } in
// templates.json. When that field is left blank, the named sibling element
// gets that transform written onto it (replacing any existing transform on
// that element) — e.g. sliding a lone remaining signature block over to
// where a centered signature would sit, once its counterpart is confirmed
// absent via hide_container. Purely additive: templates that don't declare
// this behave exactly as before.
//
// An image field can also declare "hide_placeholder": "<some-element-id>"
// in templates.json — the reverse condition of hide_container. When this
// field DOES have a value, the named element is removed from the document.
// Used for a template's decorative "drop your signature/logo here" box and
// label that sit underneath the real <image> element in paint order: since
// an uploaded signature/logo/seal PNG is almost always transparent outside
// the actual ink/artwork, sitting "on top" doesn't visually hide anything
// underneath it — the placeholder box and label show straight through the
// transparent gaps unless they're actually removed from the document once
// a real image is present.
//
// A text field can also declare "fit_width": <number> in templates.json —
// FIX (Sep 2026, Global Spec date-field overflow): some templates have
// fields whose blank space is narrow relative to what real data can be
// (e.g. a full month name vs. the "Month" placeholder the template was
// visually designed around). The old approach was to hand-pick one static
// font-size small enough to survive the worst case we'd seen so far — which
// (a) made every value render at that same small size even when it was
// short enough to look fine much bigger, and (b) needed re-tuning by hand
// every time real production data turned out longer than whatever we'd
// tested with (this happened twice on Global Spec: "September" vs "Sep",
// then "DECEMBER" still slightly overlapping "2026" even after a first
// shrink, because the shrink was sized by eye, not measured).
// fit_width fixes both: it's the true available width for that field, in
// the same canvas units as the SVG itself, MEASURED from the template's own
// artwork (e.g. the pixel width of the blank-line polygon a field's value
// sits on) — not guessed. At render time, buildSvg loads the actual bundled
// font (matching that element's font-family/weight/style) via fontkit and
// measures the REAL glyph width of the specific value being written. Only
// if that's wider than fit_width does it shrink the font-size, by just
// enough to fit — never more, and never for values that already fit at the
// template's natural size. Short values (e.g. "Jan") keep the design's
// original, larger font-size; only long ones (e.g. "September") shrink, and
// only as much as they individually need. Optional "fit_min_font" (default
// 40px) is a floor: if even the smallest legible size wouldn't fit, we stop
// shrinking there and log a warning rather than render illegibly tiny text
// — generation still succeeds, but it's visible in the logs so a genuinely
// too-long value (a data-entry mistake, not a template gap) gets noticed.
// Fields with no fit_width behave exactly as before — this is opt-in per
// field, zero cost/behavior change for every other field on every template.
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
// fallbacks via serifFamily/sansSerifFamily below. fit_width measurement
// (below) uses these exact same font files via fontkit, so what gets
// MEASURED and what actually gets RENDERED are guaranteed to agree —
// there's no separate "estimate" that can drift out of sync with reality.
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const { PDFDocument } = require('pdf-lib');
const sharp = require('sharp');
const fontkit = require('fontkit');

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
async function normalizeImageDataUri(dataUri, fieldId, trimToInk) {
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
    let pipeline = sharp(parsed.buffer).rotate();
    if (trimToInk) {
      // FIX (Sep 2026 — signature sitting high above its line): a
      // signature upload is very often a phone photo or scan with a lot of
      // blank (or, for a transparent PNG, fully transparent) margin around
      // the actual pen strokes — the org photographed a whole signature
      // box, not just the ink. Positioning tricks in the SVG itself
      // (preserveAspectRatio="xMidYMax meet", bottom-aligning the image to
      // its box) can only anchor the IMAGE's own edge to the line; if the
      // ink sits well inside that edge with padding of its own, the visual
      // gap remains no matter how the box is aligned. sharp's trim() crops
      // away uniform-colour/transparent borders before we ever embed the
      // image, so whatever margin the org's own photo has is gone before
      // positioning even comes into play — the box (and therefore the
      // line) hugs the actual ink, regardless of how loosely it was
      // photographed or scanned. Only opted into for fields that declare
      // it (see templates.json's "trim_image": true) — logo and seal
      // artwork often has intentional breathing room as part of the mark
      // itself, which trimming would wrongly strip.
      pipeline = pipeline.trim();
    }
    const pngBuffer = await pipeline.png().toBuffer();
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
      values[field.id] = await normalizeImageDataUri(values[field.id], field.id, field.trim_image);
    }
  }
  return values;
}

// --- fit_width support (text auto-shrink) -----------------------------

// Fontkit is a pure measurement tool (no rendering) — we open each bundled
// font file once and reuse it, since the same handful of font files back
// every template and every field on every certificate in a batch.
const _fontKitCache = new Map();
function loadFontKit(filePath) {
  if (!_fontKitCache.has(filePath)) {
    _fontKitCache.set(filePath, fontkit.openSync(filePath));
  }
  return _fontKitCache.get(filePath);
}

// Picks the exact bundled font file matching a text element's own
// font-family/weight/style, so measurement uses the identical glyphs resvg
// will actually render — not a generic guess. Mirrors the serif/sans-serif
// substitution resvg itself does (see FONT NOTE above): anything not
// explicitly "sans-serif" measures as Gelasio, matching defaultFontFamily/
// serifFamily in the Resvg font config below. Arimo has no bundled italic
// variant (see fontFiles list below) — bold-italic sans-serif measures with
// the closest available file (Arimo-Bold) rather than throwing, since a
// slightly-off italic measurement is a much smaller problem than failing
// the whole field.
function pickFontFile(fontFamily, fontWeight, fontStyle) {
  const isSans = /sans-serif/i.test(fontFamily || '');
  const isBold = /bold/i.test(fontWeight || '');
  const isItalic = /italic|oblique/i.test(fontStyle || '');
  if (isSans) {
    return path.join(FONTS_DIR, isBold ? 'Arimo-Bold.ttf' : 'Arimo-Regular.ttf');
  }
  if (isBold && isItalic) return path.join(FONTS_DIR, 'Gelasio-BoldItalic.ttf');
  if (isBold) return path.join(FONTS_DIR, 'Gelasio-Bold.ttf');
  if (isItalic) return path.join(FONTS_DIR, 'Gelasio-Italic.ttf');
  return path.join(FONTS_DIR, 'Gelasio-Regular.ttf');
}

// Real glyph-advance measurement of `text` set in `fontFile` at
// `fontSizePx`, in the same units as the SVG canvas — not a character-count
// estimate. advanceWidth is in the font's own unitsPerEm; scaling by
// fontSizePx / unitsPerEm matches how any renderer converts font units to
// the requested point size.
function measureTextWidth(text, fontFile, fontSizePx) {
  if (!text) return 0;
  const font = loadFontKit(fontFile);
  const run = font.layout(text);
  return (run.advanceWidth / font.unitsPerEm) * fontSizePx;
}

// Returns the font-size to actually render `text` at: `naturalFontSizePx`
// unchanged if it already fits within `fitWidth`, otherwise the largest
// size that does fit, floored at `minFontPx` (default 40px). Only ever
// shrinks, never grows — a short value never gets rendered larger than the
// template's own design intended.
function fitFontSize(text, fontFile, naturalFontSizePx, fitWidth, minFontPx) {
  const naturalWidth = measureTextWidth(text, fontFile, naturalFontSizePx);
  if (naturalWidth <= fitWidth) return { size: naturalFontSizePx, fits: true };
  const floor = minFontPx || 40;
  const scaled = naturalFontSizePx * (fitWidth / naturalWidth);
  if (scaled >= floor) {
    // Scaling down hits fitWidth by construction (width scales linearly with
    // font-size), so this always fits. Re-measuring here would occasionally
    // fail on floating-point noise a hair's width off fitWidth (the
    // scale-then-remeasure round trip doesn't land on exactly the same
    // float fitWidth started as) and log a false-positive warning for a
    // value that renders fine -- so we trust the math instead of
    // re-checking a boundary that's only ever off by rounding error.
    return { size: scaled, fits: true };
  }
  // Scaling down as far as the floor allows still isn't enough -- this is
  // the one case genuinely worth re-measuring and reporting honestly.
  const flooredWidth = measureTextWidth(text, fontFile, floor);
  return { size: floor, fits: flooredWidth <= fitWidth };
}

// --- fit_group support (matching sizes across related fields) ----------
//
// Fields that visually belong to one phrase (e.g. award-day/award-month/
// award-year forming "Day day of Month, Year") can declare the same
// "fit_group" string in templates.json. Rather than each field shrinking
// independently to fit its OWN blank — which can leave a long month
// rendering visibly smaller than the short day right next to it, in the
// same sentence — every field in a group renders at ONE shared size: the
// smallest size any member of the group actually needs. A field that could
// have stayed larger on its own gives up that extra size so the whole
// phrase reads as one consistent piece of text, the way a person would
// write it by hand, rather than three independently-sized fragments. This
// also tends to close up awkward gaps between a field and the static text
// right after it, since the harmonized size is never larger than what was
// independently required — never smaller room, only ever equal or more.
// Fields with no fit_group behave exactly as before (sized independently).
// Computed in one pass before the main field loop, since it needs to see
// every group member's natural size and content before any of them get
// written into the SVG.
function computeFitSizes(templateDef, svg, values) {
  const sizes = {}; // field.id -> { field, size, fits, naturalSize }
  const groups = {}; // fit_group -> [entry, ...]

  for (const field of templateDef.fields) {
    if (field.type !== 'text' || !field.fit_width) continue;
    const safe = escapeXml(values[field.id] ?? '');
    const openTagRe = new RegExp(`<[^>]+id="${field.id}"[^>]*>`);
    const openTag = (openTagRe.exec(svg) || [''])[0];
    const famMatch = /font-family="([^"]*)"/.exec(openTag);
    const weightMatch = /font-weight="([^"]*)"/.exec(openTag);
    const styleMatch = /font-style="([^"]*)"/.exec(openTag);
    const sizeMatch = /font-size="([\d.]+)px"/.exec(openTag);
    if (!sizeMatch) continue; // no parsable font-size -- leave to the plain-substitution fallback below

    const naturalSize = parseFloat(sizeMatch[1]);
    const fontFile = pickFontFile(
      famMatch ? famMatch[1] : '', weightMatch ? weightMatch[1] : '', styleMatch ? styleMatch[1] : ''
    );
    const { size, fits } = fitFontSize(safe, fontFile, naturalSize, field.fit_width, field.fit_min_font);
    const entry = { field, size, fits, naturalSize };
    sizes[field.id] = entry;
    if (field.fit_group) {
      (groups[field.fit_group] = groups[field.fit_group] || []).push(entry);
    }
  }

  // Harmonize each group to its smallest member's size. Shrinking a field
  // further than it strictly needed to fit can only ever fit MORE easily,
  // never less -- so no re-check of `fits` is needed after this.
  for (const groupFields of Object.values(groups)) {
    const minSize = Math.min(...groupFields.map((e) => e.size));
    for (const entry of groupFields) entry.size = minSize;
  }

  return sizes;
}

// -----------------------------------------------------------------------

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

// Adds or overwrites a transform="..." attribute on the element with the
// given id. Used by reposition_sibling_if_empty (see field-loop comment
// below) — if the element already carries a transform, it's replaced, not
// stacked, since the intent is always "put this exactly here now."
// Silently no-ops if the id isn't found in the document, matching
// removeElementById's same fail-quiet philosophy for a bad/missing id in
// templates.json.
function setTransformById(svg, elementId, transform) {
  const reWithTransform = new RegExp(`(<[^>]+id="${elementId}"[^>]*?)\\stransform="[^"]*"`);
  if (reWithTransform.test(svg)) {
    return svg.replace(reWithTransform, `$1 transform="${escapeXml(transform)}"`);
  }
  const reOpen = new RegExp(`(<[^>]+id="${elementId}")`);
  return svg.replace(reOpen, `$1 transform="${escapeXml(transform)}"`);
}

function buildSvg(templateDef, fieldValues, recipientLabel) {
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
  const fitSizes = computeFitSizes(templateDef, svg, values);

  for (const field of templateDef.fields) {
    const raw = values[field.id];

    if (field.type === 'text') {
      const safe = escapeXml(raw ?? '');
      const re = new RegExp(`(<[^>]+id="${field.id}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z]+>)`);

      const fitEntry = fitSizes[field.id];
      if (fitEntry) {
        // Size was already resolved by computeFitSizes above -- including
        // harmonizing it against any fit_group siblings -- so this just
        // applies it. See the fit_width/fit_group doc comments up top for
        // why sizing happens in that separate pass instead of inline here.
        if (!fitEntry.fits) {
          // Even the smallest legible size doesn't fit — this is very
          // likely a data-entry issue (an unusually long value), not a
          // template bug. Generation still proceeds; this just makes the
          // overflow visible in logs instead of only on the PDF.
          console.warn(
            `[render] Field "${field.id}" value ${JSON.stringify(safe)} still exceeds its ` +
            `fit_width (${field.fit_width}px) even at the font floor (${field.fit_min_font || 40}px). ` +
            `Recipient/label: ${recipientLabel || 'unknown'}.`
          );
        }
        const match = re.exec(svg);
        if (match) {
          const newOpenTag = fitEntry.size !== fitEntry.naturalSize
            ? match[1].replace(/font-size="[\d.]+px"/, `font-size="${fitEntry.size.toFixed(2)}px"`)
            : match[1];
          svg = svg.slice(0, match.index) + newOpenTag + safe + match[3] + svg.slice(match.index + match[0].length);
        } else {
          // Field declared fit_width but its element wasn't found by the
          // time we get here (shouldn't happen — computeFitSizes only adds
          // an entry when it found the same element) — fail safe rather
          // than throw.
          svg = svg.replace(re, (m, open, _old, close) => `${open}${safe}${close}`);
        }
      } else {
        svg = svg.replace(re, (m, open, _old, close) => `${open}${safe}${close}`);
      }

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

      if (dataUri && field.hide_placeholder) {
        // Real image was uploaded -> remove the decorative "drop your
        // signature/logo here" box + label that would otherwise show
        // through any transparent areas of the uploaded image. Detects
        // the placeholder's actual tag (usually <g>, but not assumed)
        // the same way the block-toggle branch below does, rather than
        // hardcoding one.
        const tagMatch = svg.match(new RegExp(`<([a-zA-Z]+)[^>]+id="${field.hide_placeholder}"`));
        if (tagMatch) {
          svg = removeElementById(svg, tagMatch[1], field.hide_placeholder);
        }
      }

      if (!dataUri && field.reposition_sibling_if_empty) {
        // Optional slot left blank -> also nudge a named sibling element
        // into an alternate position (e.g. sliding a lone signature block
        // to center once its counterpart's hide_container has removed it
        // above). Applied after hide_container's removal, so the sibling
        // being repositioned is never accidentally matched by the removal
        // scan even if their ids happened to collide in some future template.
        const { id: siblingId, transform } = field.reposition_sibling_if_empty;
        svg = setTransformById(svg, siblingId, transform);
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
  const svg = buildSvg(templateDef, normalizedValues, recipientLabel);
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
