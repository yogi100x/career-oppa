import React from 'react';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import type { ResumeContent } from '@career-workspace/contracts';

export type ResumePageSize = 'A4' | 'LETTER';
export const pdfPackageName = '@career-workspace/pdf';

// Bundled Noto fonts (SIL OFL 1.1, see fonts/OFL.txt) so ₹, ā, Ł and
// Devanagari survive. Nothing is fetched at runtime.
// Each path must be a string literal inside `new URL(...)`: the Next bundler
// resolves a template literal there to one file, so every font became
// NotoSans-Bold and Devanagari came out garbled.
const fontFile = (url: URL, name: string) => {
  const path = fileURLToPath(url);
  // The bundler may add a hash (NotoSans-Bold.<hash>.ttf), never a new name.
  if (!basename(path).startsWith(`${name}.`))
    throw new Error(`CV font ${name} resolved to ${basename(path)}`);
  return path;
};
const resumeFontFiles = {
  regular: fontFile(
    new URL('../fonts/NotoSans-Regular.ttf', import.meta.url),
    'NotoSans-Regular',
  ),
  bold: fontFile(
    new URL('../fonts/NotoSans-Bold.ttf', import.meta.url),
    'NotoSans-Bold',
  ),
  devanagariRegular: fontFile(
    new URL('../fonts/NotoSansDevanagari-Regular.ttf', import.meta.url),
    'NotoSansDevanagari-Regular',
  ),
  devanagariBold: fontFile(
    new URL('../fonts/NotoSansDevanagari-Bold.ttf', import.meta.url),
    'NotoSansDevanagari-Bold',
  ),
};
const bodyFont = ['NotoSans', 'NotoSansDevanagari'];

function registerStandardFonts() {
  Font.register({
    family: 'Helvetica',
    fonts: [
      { src: 'Helvetica', fontWeight: 400 },
      { src: 'Helvetica-Bold', fontWeight: 700 },
      { src: 'Helvetica-Oblique', fontStyle: 'italic', fontWeight: 400 },
      { src: 'Helvetica-BoldOblique', fontStyle: 'italic', fontWeight: 700 },
    ],
  });
  Font.register({
    family: 'Courier',
    fonts: [
      { src: 'Courier', fontWeight: 400 },
      { src: 'Courier-Bold', fontWeight: 700 },
      { src: 'Courier-Oblique', fontStyle: 'italic', fontWeight: 400 },
      { src: 'Courier-BoldOblique', fontStyle: 'italic', fontWeight: 700 },
    ],
  });
  Font.register({
    family: 'Times-Roman',
    fonts: [
      { src: 'Times-Roman', fontWeight: 400 },
      { src: 'Times-Bold', fontWeight: 700 },
      { src: 'Times-Italic', fontStyle: 'italic', fontWeight: 400 },
      { src: 'Times-BoldItalic', fontStyle: 'italic', fontWeight: 700 },
    ],
  });
  for (const name of [
    'Helvetica-Bold',
    'Helvetica-Oblique',
    'Helvetica-BoldOblique',
    'Courier-Bold',
    'Courier-Oblique',
    'Courier-BoldOblique',
    'Times-Bold',
    'Times-Italic',
    'Times-BoldItalic',
  ])
    Font.register({ family: name, src: name });
}

function registerResumeFonts() {
  registerStandardFonts();
  Font.register({
    family: 'NotoSans',
    fonts: [
      { src: resumeFontFiles.regular },
      { src: resumeFontFiles.bold, fontWeight: 'bold' },
    ],
  });
  Font.register({
    family: 'NotoSansDevanagari',
    fonts: [
      { src: resumeFontFiles.devanagariRegular },
      { src: resumeFontFiles.devanagariBold, fontWeight: 'bold' },
    ],
  });
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 48,
    paddingBottom: 48,
    paddingHorizontal: 52,
    fontFamily: bodyFont,
    fontSize: 10,
    lineHeight: 1.45,
    color: '#26332f',
  },
  name: {
    fontSize: 24,
    lineHeight: 1.15,
    fontWeight: 'bold',
    color: '#153d34',
  },
  contact: {
    marginTop: 7,
    fontSize: 9,
    color: '#596b65',
  },
  divider: {
    marginTop: 16,
    marginBottom: 17,
    borderBottomColor: '#cad8d2',
    borderBottomWidth: 1,
  },
  section: {
    marginBottom: 14,
  },
  sectionTitle: {
    marginBottom: 6,
    fontSize: 11,
    fontWeight: 'bold',
    color: '#153d34',
  },
  bulletRow: {
    flexDirection: 'row',
    marginBottom: 4,
    paddingLeft: 2,
  },
  bulletMark: {
    width: 12,
    fontSize: 10,
    color: '#38745f',
  },
  bulletText: {
    flexGrow: 1,
    flexShrink: 1,
  },
  entry: {
    marginBottom: 6,
  },
  entryHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  entryTitle: {
    fontWeight: 'bold',
    flexShrink: 1,
  },
  entryDates: {
    color: '#596b65',
    marginLeft: 8,
  },
});

function Bullets({
  bullets,
  plain,
  keyPrefix,
}: {
  bullets: ResumeContent['sections'][number]['bullets'];
  plain: boolean;
  keyPrefix: string;
}) {
  return bullets.map((bullet, bulletIndex) => (
    <View
      key={`${keyPrefix}-${bulletIndex}`}
      style={styles.bulletRow}
      wrap={false}
    >
      {plain ? null : <Text style={styles.bulletMark}>•</Text>}
      <Text style={styles.bulletText}>{bullet.text}</Text>
    </View>
  ));
}

function ResumeDocument({
  content,
  pageSize,
}: {
  content: ResumeContent;
  pageSize: ResumePageSize;
}) {
  return (
    <Document title={`${content.name || 'Resume'} - CV`}>
      <Page size={pageSize} style={styles.page}>
        <Text style={styles.name}>{content.name || 'Resume'}</Text>
        {content.contact ? (
          <Text style={styles.contact}>{content.contact}</Text>
        ) : null}
        <View style={styles.divider} />
        {content.sections.map((section, sectionIndex) => (
          <View key={`${section.title}-${sectionIndex}`} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            {(section.entries ?? []).map((entry, entryIndex) => (
              <View
                key={`${sectionIndex}-entry-${entryIndex}`}
                style={styles.entry}
              >
                {/* One header line per role: title, organisation, then dates. */}
                <View style={styles.entryHeader} wrap={false}>
                  <Text style={styles.entryTitle}>
                    {[entry.title, entry.organisation]
                      .filter(Boolean)
                      .join(', ')}
                  </Text>
                  <Text style={styles.entryDates}>
                    {[entry.start, entry.end].filter(Boolean).join(' – ')}
                  </Text>
                </View>
                <Bullets
                  bullets={entry.bullets}
                  plain={false}
                  keyPrefix={`${sectionIndex}-${entryIndex}`}
                />
              </View>
            ))}
            <Bullets
              bullets={section.bullets}
              plain={section.title === 'Skills'}
              keyPrefix={`${sectionIndex}`}
            />
          </View>
        ))}
      </Page>
    </Document>
  );
}

/** Counts page objects in a PDF made by renderResumePdf (uncompressed object headers). */
export function countPdfPages(bytes: Uint8Array): number {
  // ponytail: regex over react-pdf's own output; use a PDF parser if the
  // renderer ever starts compressing object streams.
  return (
    new TextDecoder('latin1').decode(bytes).match(/\/Type\s*\/Page(?![a-z])/g)
      ?.length ?? 0
  );
}

/** Renders a private resume PDF buffer for the preview or approval flow. */
export async function renderResumePdf(
  content: ResumeContent,
  pageSize: ResumePageSize = 'A4',
): Promise<Uint8Array> {
  const render = renderQueue.then(async () => {
    // React-PDF's shared font store retains subset state between documents.
    // Clear and re-register standard and bundled fonts for each render so
    // glyph subset mappings from one document cannot affect the next PDF.
    Font.clear();
    registerResumeFonts();
    const buffer = await renderToBuffer(
      <ResumeDocument content={content} pageSize={pageSize} />,
    );
    return new Uint8Array(buffer);
  });
  renderQueue = render.then(
    () => undefined,
    () => undefined,
  );
  return render;
}

let renderQueue: Promise<void> = Promise.resolve();
