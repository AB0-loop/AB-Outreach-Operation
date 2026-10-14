import PDFDocument from "pdfkit";

/**
 * Minimal, dependency-light PDF builder for Aurum Bespoke operational
 * reports. Handles paginated tables with repeated headers, page numbers,
 * long-URL wrapping and explicit "not available" markers.
 *
 * Only the PDF standard fonts are used, so no font files need shipping.
 */

export type Column = { key: string; label: string; width: number };
export type Row = Record<string, string | null | undefined>;

export type DetailBlock = { heading: string; fields: [string, string][] };

const GOLD = "#8A6A1F";
const INK = "#1A1A1A";
const MUTED = "#6B6B6B";
const RULE = "#D8D2C4";
const ZEBRA = "#F7F4EC";

const MARGIN = 36;
const PAGE_W = 842; // A4 landscape
const PAGE_H = 595;
const CONTENT_W = PAGE_W - MARGIN * 2;

export type ReportMeta = {
  serial: string;
  title: string;
  subtitle?: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  timezone: string;
};

function fmt(d: Date, tz: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

/** Explicit marker so a reader can never mistake a gap for a real value. */
export function orNA(v: string | null | undefined): string {
  const s = (v ?? "").toString().trim();
  return s.length > 0 ? s : "—";
}

type Doc = InstanceType<typeof PDFDocument>;

export class ReportBuilder {
  private doc: Doc;
  private chunks: Buffer[] = [];
  private meta: ReportMeta;
  private pageNo = 0;

  constructor(meta: ReportMeta) {
    this.meta = meta;
    this.doc = new PDFDocument({
      size: [PAGE_W, PAGE_H],
      margins: { top: MARGIN, bottom: MARGIN + 16, left: MARGIN, right: MARGIN },
      bufferPages: true,
      info: {
        Title: `${meta.serial} · ${meta.title}`,
        Author: "Aurum Bespoke Outreach",
        Subject: `Serial ${meta.serial} · ${meta.title}`,
        Keywords: `aurum-bespoke,report,serial-${meta.serial}`,
      },
    });
    this.doc.on("data", (c: Buffer) => this.chunks.push(c));
    this.drawCover();
  }

  private get y() {
    return this.doc.y;
  }

  private drawCover() {
    const d = this.doc;
    this.pageNo = 1;
    d.rect(0, 0, PAGE_W, 86).fill("#111111");
    d.fillColor(GOLD).font("Helvetica-Bold").fontSize(9)
      .text("A U R U M   B E S P O K E", MARGIN, 24, { characterSpacing: 2 });
    d.fillColor("#FFFFFF").font("Helvetica").fontSize(17)
      .text(this.meta.title, MARGIN, 42);
    d.fillColor(GOLD).font("Helvetica-Bold").fontSize(22)
      .text(this.meta.serial, PAGE_W - MARGIN - 90, 34, { width: 90, align: "right" });

    d.fillColor(MUTED).font("Helvetica").fontSize(8);
    const line = [
      `Reporting period: ${fmt(this.meta.periodStart, this.meta.timezone)} → ${fmt(this.meta.periodEnd, this.meta.timezone)} (${this.meta.timezone})`,
      `Generated: ${fmt(this.meta.generatedAt, this.meta.timezone)}`,
      this.meta.subtitle ?? "",
    ].filter(Boolean);
    d.text(line.join("    ·    "), MARGIN, 96, { width: CONTENT_W });
    d.moveTo(MARGIN, 112).lineTo(PAGE_W - MARGIN, 112).strokeColor(RULE).lineWidth(0.7).stroke();
    d.y = 122;
    d.fillColor(INK);
  }

  private newPage() {
    this.doc.addPage();
    this.pageNo += 1;
    const d = this.doc;
    d.fillColor(GOLD).font("Helvetica-Bold").fontSize(7.5)
      .text(`AURUM BESPOKE  ·  ${this.meta.serial}  ·  ${this.meta.title}`, MARGIN, 20, {
        width: CONTENT_W,
        characterSpacing: 1,
      });
    d.moveTo(MARGIN, 34).lineTo(PAGE_W - MARGIN, 34).strokeColor(RULE).lineWidth(0.5).stroke();
    d.y = 44;
    d.fillColor(INK);
  }

  private ensure(space: number) {
    if (this.y + space > PAGE_H - MARGIN - 16) this.newPage();
  }

  heading(text: string) {
    this.ensure(34);
    this.doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(10.5)
      .text(text.toUpperCase(), MARGIN, this.y, { characterSpacing: 0.8 });
    this.doc.moveTo(MARGIN, this.doc.y + 2).lineTo(PAGE_W - MARGIN, this.doc.y + 2)
      .strokeColor(RULE).lineWidth(0.5).stroke();
    this.doc.y += 8;
    this.doc.fillColor(INK);
  }

  paragraph(text: string) {
    this.ensure(26);
    this.doc.fillColor(MUTED).font("Helvetica").fontSize(8.5)
      .text(text, MARGIN, this.y, { width: CONTENT_W });
    this.doc.y += 6;
    this.doc.fillColor(INK);
  }

  /** Key figures grid. */
  summary(pairs: [string, string | number][]) {
    this.ensure(60);
    const perRow = 4;
    const boxW = CONTENT_W / perRow;
    let row = 0;
    pairs.forEach((p, i) => {
      const col = i % perRow;
      if (col === 0 && i > 0) row += 1;
      const x = MARGIN + col * boxW;
      const y = this.y + row * 34;
      this.doc.fillColor(MUTED).font("Helvetica").fontSize(6.8)
        .text(p[0].toUpperCase(), x, y, { width: boxW - 8, characterSpacing: 0.6 });
      this.doc.fillColor(INK).font("Helvetica-Bold").fontSize(13)
        .text(String(p[1]), x, y + 10, { width: boxW - 8 });
    });
    this.doc.y = this.y + (row + 1) * 34 + 6;
    this.doc.fillColor(INK);
  }

  /**
   * Paginated table. The header repeats on every page and long values wrap
   * inside their column rather than overflowing.
   */
  table(columns: Column[], rows: Row[], opts?: { emptyText?: string }) {
    if (rows.length === 0) {
      this.paragraph(opts?.emptyText ?? "No records in this reporting period.");
      return;
    }
    const total = columns.reduce((a, c) => a + c.width, 0);
    const scale = CONTENT_W / total;
    const widths = columns.map((c) => c.width * scale);

    const drawHeader = () => {
      const h = 16;
      this.ensure(h + 14);
      const y = this.y;
      this.doc.rect(MARGIN, y, CONTENT_W, h).fill("#111111");
      let x = MARGIN;
      columns.forEach((c, i) => {
        this.doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(6.4)
          .text(c.label.toUpperCase(), x + 3, y + 5, {
            width: widths[i] - 6,
            ellipsis: true,
            lineBreak: false,
          });
        x += widths[i];
      });
      this.doc.y = y + h;
      this.doc.fillColor(INK);
    };

    drawHeader();

    rows.forEach((r, idx) => {
      const cells = columns.map((c) => orNA(r[c.key]));
      // Measure the tallest cell so wrapped text never overlaps the next row.
      this.doc.font("Helvetica").fontSize(6.8);
      const heights = cells.map((text, i) =>
        this.doc.heightOfString(text, { width: widths[i] - 6 }),
      );
      const rowH = Math.max(13, Math.ceil(Math.max(...heights)) + 6);

      if (this.y + rowH > PAGE_H - MARGIN - 16) {
        this.newPage();
        drawHeader();
      }

      const y = this.y;
      if (idx % 2 === 1) this.doc.rect(MARGIN, y, CONTENT_W, rowH).fill(ZEBRA);

      let x = MARGIN;
      cells.forEach((text, i) => {
        this.doc.fillColor(text === "—" ? MUTED : INK).font("Helvetica").fontSize(6.8)
          .text(text, x + 3, y + 3, { width: widths[i] - 6, height: rowH - 4, ellipsis: true });
        x += widths[i];
      });
      this.doc.moveTo(MARGIN, y + rowH).lineTo(PAGE_W - MARGIN, y + rowH)
        .strokeColor(RULE).lineWidth(0.3).stroke();
      this.doc.y = y + rowH;
      this.doc.fillColor(INK);
    });
    this.doc.y += 10;
  }

  /** Per-record detail blocks for data too wide for a readable table. */
  details(blocks: DetailBlock[]) {
    for (const b of blocks) {
      this.ensure(46);
      this.doc.fillColor(INK).font("Helvetica-Bold").fontSize(8.4)
        .text(b.heading, MARGIN, this.y, { width: CONTENT_W });
      this.doc.y += 2;
      const colW = CONTENT_W / 2 - 10;
      let col = 0;
      let rowTop = this.doc.y;
      let maxBottom = rowTop;
      for (const [k, v] of b.fields) {
        const x = MARGIN + col * (colW + 20);
        if (rowTop + 20 > PAGE_H - MARGIN - 16) {
          this.newPage();
          rowTop = this.doc.y;
          maxBottom = rowTop;
        }
        this.doc.fillColor(MUTED).font("Helvetica").fontSize(6.2)
          .text(k.toUpperCase(), x, rowTop, { width: colW, characterSpacing: 0.4 });
        const vy = this.doc.y;
        this.doc.fillColor(v ? INK : MUTED).font("Helvetica").fontSize(7.4)
          .text(orNA(v), x, vy, { width: colW });
        maxBottom = Math.max(maxBottom, this.doc.y);
        col = (col + 1) % 2;
        if (col === 0) {
          rowTop = maxBottom + 4;
          this.doc.y = rowTop;
        } else {
          this.doc.y = rowTop;
        }
      }
      this.doc.y = maxBottom + 8;
      this.doc.moveTo(MARGIN, this.doc.y).lineTo(PAGE_W - MARGIN, this.doc.y)
        .strokeColor(RULE).lineWidth(0.3).stroke();
      this.doc.y += 8;
    }
  }

  /** Stamps page numbers on every page, then flushes the buffer. */
  async finish(): Promise<Buffer> {
    const d = this.doc;
    const range = d.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      d.switchToPage(i);
      d.fillColor(MUTED).font("Helvetica").fontSize(6.8)
        .text(
          `Aurum Bespoke · Confidential · Serial ${this.meta.serial}`,
          MARGIN,
          PAGE_H - MARGIN,
          { width: CONTENT_W / 2, lineBreak: false },
        );
      d.text(
        `Page ${i - range.start + 1} of ${range.count}`,
        MARGIN + CONTENT_W / 2,
        PAGE_H - MARGIN,
        { width: CONTENT_W / 2, align: "right", lineBreak: false },
      );
    }
    const done = new Promise<Buffer>((resolve) => {
      d.on("end", () => resolve(Buffer.concat(this.chunks)));
    });
    d.end();
    return done;
  }
}
