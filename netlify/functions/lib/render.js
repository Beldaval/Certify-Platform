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

const TEMPLATES_DIR = path.join(__dirname, '..', '..', '..', 'public', 'assets', 'templates');
const FONTS_DIR = __dirname; // font .ttf files sit alongside render.js in lib/

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSvg(templateDef, fieldValues) {
  const svgPath = path.join(TEMPLATES_DIR, templateDef.svg_file || templateDef.file);
  let svg = fs.readFileSync(svgPath, 'utf8');
  const values = fieldValues || {};

  for (const field of templateDef.fields) {
    const raw = values[field.id];

    if (field.type === 'text') {
      const safe = escapeXml(raw ?? '');
      const re = new RegExp(`(<[^>]+id="${field.id}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z]+>)`);
      svg = svg.replace(re, (m, open, _old, close) => `${open}${safe}${close}`);

    } else if (field.type === 'image') {
      const reHref = new RegExp(`(<[^>]+id="${field.id}"[^>]*?)(?:xlink:href|href)="[^"]*"`);
      const dataUri = raw || '';
      if (reHref.test(svg)) {
        svg = svg.replace(reHref, `$1href="${dataUri}"`);
      } else if (dataUri) {
        const reOpen = new RegExp(`(<[^>]+id="${field.id}")`);
        svg = svg.replace(reOpen, `$1 href="${dataUri}"`);
      }
      // no upload on an optional slot -> href left empty, slot renders blank

      if (!dataUri && field.hide_container) {
        // Optional slot left blank -> remove the whole wrapper block
        // (dashed placeholder box, label, caption/title text) so nothing
        // is left dangling, instead of just clearing the image href.
        // NOTE: assumes the container has no nested <g> elements of its
        // own — true for every template's signature/seal blocks today,
        // but if a future template nests a <g> inside one, this regex
        // would stop at the first inner </g> instead of the outer one.
        const reContainer = new RegExp(`<g id="${field.hide_container}"[^>]*>[\\s\\S]*?<\\/g>`);
        svg = svg.replace(reContainer, '');
      }

    } else if (field.type === 'block-toggle') {
      if (raw === false) {
        const re = new RegExp(`(<[^>]+id="${field.id}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z]+>)`);
        svg = svg.replace(re, (m, open, _old, close) => `${open}${close}`);
      }
      // true/undefined -> leave the template's own default content as-is
    }
  }

  return svg;
}

async function renderCertificate({ templateDef, fieldValues }) {
  const svg = buildSvg(templateDef, fieldValues);
  const pxW = templateDef.canvas_width || templateDef.canvas.width;
  const pxH = templateDef.canvas_height || templateDef.canvas.height;

  const resvg = new Resvg(svg, {
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
