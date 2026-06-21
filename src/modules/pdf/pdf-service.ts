import pdfmake from "pdfmake";

// ---------------------------------------------------------------------------
// Font configuration — pdfmake requires at least one font to embed
// ---------------------------------------------------------------------------
const fonts: TFontDictionary = {
  Helvetica: {
    normal: "Helvetica",
    bold: "Helvetica-Bold",
    italics: "Helvetica-Oblique",
    bolditalics: "Helvetica-BoldOblique",
  },
};

// pdfmake is a singleton — configure fonts once
pdfmake.fonts = fonts;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------
function headerRow(text: string): Record<string, unknown> {
  return {
    text,
    style: "tableHeader",
    fillColor: "#1f73b7",
    color: "#ffffff",
    bold: true,
    fontSize: 10,
    margin: [4, 4],
  };
}

function cell(text: string): Record<string, unknown> {
  return { text: text || "—", fontSize: 9, margin: [4, 4] };
}

const defaultStyles: TDocumentDefinitions["styles"] = {
  header: { fontSize: 18, bold: true, color: "#1f73b7", margin: [0, 0, 0, 8] },
  subheader: { fontSize: 13, bold: true, color: "#333333", margin: [0, 12, 0, 4] },
  body: { fontSize: 10, lineHeight: 1.4 },
  sectionLabel: { fontSize: 10, bold: true, color: "#555555" },
  sectionValue: { fontSize: 10, margin: [0, 0, 0, 4] },
  tableHeader: { fontSize: 10, bold: true, fillColor: "#1f73b7", color: "#ffffff" },
};

function branding(): Record<string, unknown>[] {
  return [
    {
      columns: [
        { text: "StudentHub", fontSize: 12, bold: true, color: "#1f73b7" },
        {
          text: new Date().toISOString().split("T")[0],
          fontSize: 8,
          color: "#999999",
          alignment: "right",
        },
      ],
      margin: [0, 0, 0, 12],
    },
  ];
}

function section(title: string, content: Record<string, unknown>[]): Record<string, unknown> {
  return {
    stack: [
      { text: title, style: "subheader" },
      ...content,
    ],
  };
}

function keyValue(key: string, value: string): Record<string, unknown> {
  return {
    columns: [
      { text: key, style: "sectionLabel", width: 140 },
      { text: value || "—", style: "sectionValue", width: "*" },
    ],
    columnGap: 8,
    margin: [0, 0, 0, 2],
  };
}

async function buildPdf(dd: TDocumentDefinitions): Promise<Buffer> {
  const doc = pdfmake.createPdf(dd);
  return doc.getBuffer();
}

// ---------------------------------------------------------------------------
// 1. Candidate CV PDF
// ---------------------------------------------------------------------------
export interface CandidateCvData {
  candidate_name: string;
  candidate_name_ar?: string;
  candidate_email?: string;
  candidate_phone?: string;
  candidate_objective?: string;
  candidate_intro?: string;
  candidate_education?: Array<{
    degree?: string;
    institution?: string;
    year?: number | string;
  }>;
  candidate_experience?: Array<{
    employer?: string;
    role?: string;
    start_year?: number | string;
    end_year?: number | string;
  }>;
  candidate_skills?: string[];
  candidate_languages?: string[];
  [key: string]: unknown;
}

export async function generateCandidateCvPdf(data: CandidateCvData): Promise<Buffer> {
  const educationRows = (data.candidate_education ?? []).map((e) => [
    cell(e.degree ?? ""),
    cell(e.institution ?? ""),
    cell(String(e.year ?? "")),
  ]);

  const experienceRows = (data.candidate_experience ?? []).map((e) => [
    cell(e.employer ?? ""),
    cell(e.role ?? ""),
    cell(e.start_year ? `${e.start_year}–${e.end_year ?? "Present"}` : ""),
  ]);

  const content: Record<string, unknown>[] = [
    ...branding(),
    { text: data.candidate_name, style: "header" },
  ];

  if (data.candidate_name_ar) {
    content.push({ text: data.candidate_name_ar, fontSize: 14, color: "#666666", margin: [0, 0, 0, 12] });
  }

  content.push({
    columns: [
      { text: data.candidate_email ?? "", fontSize: 9, color: "#555555" },
      { text: data.candidate_phone ?? "", fontSize: 9, color: "#555555", alignment: "right" },
    ],
    margin: [0, 0, 0, 16],
  });

  if (data.candidate_objective) {
    content.push(section("Objective", [{ text: data.candidate_objective, style: "body" }]));
  }

  if (data.candidate_intro) {
    content.push(section("Summary", [{ text: data.candidate_intro, style: "body" }]));
  }

  if (educationRows.length > 0) {
    content.push(
      section("Education", [
        {
          table: {
            headerRows: 1,
            widths: ["*", "*", 70],
            body: [
              [headerRow("Degree"), headerRow("Institution"), headerRow("Year")],
              ...educationRows,
            ],
          },
          layout: "lightHorizontalLines",
          margin: [0, 4, 0, 8],
        },
      ])
    );
  }

  if (experienceRows.length > 0) {
    content.push(
      section("Experience", [
        {
          table: {
            headerRows: 1,
            widths: ["*", "*", 90],
            body: [
              [headerRow("Employer"), headerRow("Role"), headerRow("Period")],
              ...experienceRows,
            ],
          },
          layout: "lightHorizontalLines",
          margin: [0, 4, 0, 8],
        },
      ])
    );
  }

  if (data.candidate_skills && data.candidate_skills.length > 0) {
    content.push(
      section("Skills", [
        {
          text: data.candidate_skills.join("  •  "),
          style: "body",
          margin: [0, 4, 0, 8],
        },
      ])
    );
  }

  if (data.candidate_languages && data.candidate_languages.length > 0) {
    content.push(
      section("Languages", [
        {
          text: data.candidate_languages.join("  •  "),
          style: "body",
          margin: [0, 4, 0, 8],
        },
      ])
    );
  }

  return buildPdf({
    pageSize: "A4",
    pageMargins: [48, 48, 48, 48],
    styles: defaultStyles,
    content,
    defaultStyle: { font: "Helvetica" },
  });
}

// ---------------------------------------------------------------------------
// 2. Evaluation Report PDF
// ---------------------------------------------------------------------------
export interface EvaluationData {
  candidate_name: string;
  staff_name?: string;
  department?: string;
  start_date?: string;
  end_date?: string;
  score?: number;
  answers?: Array<{
    question?: string;
    answer?: string;
    rating?: number;
  }>;
  [key: string]: unknown;
}

export async function generateEvaluationPdf(data: EvaluationData): Promise<Buffer> {
  const answerRows = (data.answers ?? []).map((a) => [
    cell(a.question ?? ""),
    cell(a.answer ?? ""),
    cell(a.rating != null ? `${a.rating}/5` : "—"),
  ]);

  const content: Record<string, unknown>[] = [
    ...branding(),
    { text: "Evaluation Report", style: "header" },
    keyValue("Candidate", data.candidate_name),
    keyValue("Evaluated by", data.staff_name ?? "—"),
    keyValue("Department", data.department ?? "—"),
    keyValue("Period", data.start_date && data.end_date ? `${data.start_date} – ${data.end_date}` : "—"),
  ];

  if (data.score != null) {
    content.push({
      text: `Overall Score: ${data.score}/100`,
      style: "subheader",
      color: data.score >= 70 ? "#16a34a" : "#dc2626",
    });
  }

  if (answerRows.length > 0) {
    content.push(
      section("Evaluation Details", [
        {
          table: {
            headerRows: 1,
            widths: ["*", "*", 50],
            body: [
              [headerRow("Criteria"), headerRow("Comment"), headerRow("Rating")],
              ...answerRows,
            ],
          },
          layout: "lightHorizontalLines",
          margin: [0, 4, 0, 8],
        },
      ])
    );
  }

  return buildPdf({
    pageSize: "A4",
    pageMargins: [48, 48, 48, 48],
    styles: defaultStyles,
    content,
    defaultStyle: { font: "Helvetica" },
  });
}

// ---------------------------------------------------------------------------
// 3. Offer Letter PDF
// ---------------------------------------------------------------------------
export interface OfferLetterData {
  fulltimer_name: string;
  fulltimer_email?: string;
  fulltimer_phone?: string;
  position?: string;
  start_date?: string;
  salary?: string;
  [key: string]: unknown;
}

export async function generateOfferLetterPdf(data: OfferLetterData): Promise<Buffer> {
  const content: Record<string, unknown>[] = [
    ...branding(),
    { text: "Offer Letter", style: "header" },
    {
      text: "Date: " + new Date().toISOString().split("T")[0],
      fontSize: 9,
      color: "#999999",
      margin: [0, 0, 0, 20],
    },
    { text: "Dear " + data.fulltimer_name + ",", fontSize: 11, margin: [0, 0, 0, 12] },
    {
      text:
        "We are pleased to offer you the position of " +
        (data.position ?? "the role") +
        " at StudentHub. We believe your skills and experience will be a valuable addition to our team.",
      style: "body",
      margin: [0, 0, 0, 16],
    },
    section("Employment Details", [
      keyValue("Name", data.fulltimer_name),
      keyValue("Email", data.fulltimer_email ?? "—"),
      keyValue("Phone", data.fulltimer_phone ?? "—"),
      keyValue("Position", data.position ?? "—"),
      keyValue("Start Date", data.start_date ?? "—"),
      keyValue("Salary", data.salary ?? "—"),
    ]),
    {
      text: "Please sign and return this letter to confirm your acceptance of this offer.",
      style: "body",
      margin: [0, 20, 0, 8],
    },
    { text: "\n\n________________________", fontSize: 10, margin: [0, 20, 0, 2] },
    { text: "Signature", fontSize: 9, color: "#999999" },
    { text: "\n\n________________________", fontSize: 10, margin: [0, 12, 0, 2] },
    { text: "Date", fontSize: 9, color: "#999999" },
  ];

  return buildPdf({
    pageSize: "A4",
    pageMargins: [48, 48, 48, 48],
    styles: defaultStyles,
    content,
    defaultStyle: { font: "Helvetica" },
  });
}

// ---------------------------------------------------------------------------
// 4. Bank Advice PDF
// ---------------------------------------------------------------------------
export interface BankAdviceData {
  serial_no?: number | string;
  beneficiary_name?: string;
  beneficiary_iban?: string;
  amount?: string;
  transfer_date?: string;
  company_name?: string;
  [key: string]: unknown;
}

export async function generateBankAdvicePdf(data: BankAdviceData): Promise<Buffer> {
  const content: Record<string, unknown>[] = [
    ...branding(),
    { text: "Bank Advice Document", style: "header" },
    { text: `Serial No: ${data.serial_no ?? "—"}`, fontSize: 10, color: "#666666", margin: [0, 0, 0, 16] },
    section("Transfer Details", [
      keyValue("Company", data.company_name ?? "—"),
      keyValue("Beneficiary", data.beneficiary_name ?? "—"),
      keyValue("IBAN", data.beneficiary_iban ?? "—"),
      keyValue("Amount", data.amount ?? "—"),
      keyValue("Transfer Date", data.transfer_date ?? "—"),
    ]),
    {
      text: "This document serves as official confirmation of the bank transfer referenced above.",
      style: "body",
      margin: [0, 20, 0, 8],
      italics: true,
      color: "#666666",
    },
  ];

  return buildPdf({
    pageSize: "A4",
    pageMargins: [48, 48, 48, 48],
    styles: defaultStyles,
    content,
    defaultStyle: { font: "Helvetica" },
  });
}
