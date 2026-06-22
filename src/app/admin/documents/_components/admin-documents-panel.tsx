"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertCircle, Download, FileText, UserCheck, FileSignature, Landmark } from "lucide-react";
import {
  cvDownloadSchema,
  uuidDownloadSchema,
  buildCvDownloadUrl,
  buildEvaluationDownloadUrl,
  buildOfferLetterDownloadUrl,
  buildBankAdviceDownloadUrl,
  buildIdCardDownloadUrl,
  buildCertificateDownloadUrl,
  certificateDownloadSchema,
} from "../schemas";
import { ZodError } from "zod";

type TabValue = "cv" | "id-card" | "certificate" | "evaluation" | "offer-letter" | "bank-advice";

export function AdminDocumentsPanel() {
  const [activeTab, setActiveTab] = useState<TabValue>("cv");
  const [candidateId, setCandidateId] = useState("");
  const [evalUuid, setEvalUuid] = useState("");
  const [offerUuid, setOfferUuid] = useState("");
  const [bankAdviceUuid, setBankAdviceUuid] = useState("");
  const [certCandidateId, setCertCandidateId] = useState("");
  const [certUuid, setCertUuid] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<TabValue | null>(null);

  function handleDownload(
    tab: TabValue,
    validate: () => string,
  ) {
    setError(null);
    setLoading(tab);

    try {
      const url = validate();
      // Open in new tab — the API route handles the PDF response
      window.open(url, "_blank");
    } catch (e) {
      if (e instanceof ZodError) {
        setError(e.errors.map((err) => err.message).join(". "));
      } else {
        setError("Validation failed. Please check your input.");
      }
    } finally {
      setLoading(null);
    }
  }

  function handleCvDownload() {
    handleDownload("cv", () => {
      const parsed = cvDownloadSchema.parse({ candidateId });
      return buildCvDownloadUrl(parsed.candidateId);
    });
  }

  function handleEvaluationDownload() {
    handleDownload("evaluation", () => {
      const parsed = uuidDownloadSchema.parse({ uuid: evalUuid });
      return buildEvaluationDownloadUrl(parsed.uuid);
    });
  }

  function handleOfferLetterDownload() {
    handleDownload("offer-letter", () => {
      const parsed = uuidDownloadSchema.parse({ uuid: offerUuid });
      return buildOfferLetterDownloadUrl(parsed.uuid);
    });
  }

  function handleBankAdviceDownload() {
    handleDownload("bank-advice", () => {
      const parsed = uuidDownloadSchema.parse({ uuid: bankAdviceUuid });
      return buildBankAdviceDownloadUrl(parsed.uuid);
    });
  }

  function handleIdCardDownload() {
    handleDownload("id-card", () => {
      const parsed = cvDownloadSchema.parse({ candidateId });
      return buildIdCardDownloadUrl(parsed.candidateId);
    });
  }

  function handleCertificateDownload() {
    handleDownload("certificate", () => {
      const parsed = certificateDownloadSchema.parse({ candidateId: certCandidateId, certificateUuid: certUuid });
      return buildCertificateDownloadUrl(parsed.candidateId, parsed.certificateUuid);
    });
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Document Generation</h1>
        <p className="text-muted-foreground mt-1">
          Generate and download PDF documents — CV exports, evaluation reports, and offer letters.
        </p>
      </div>

      {error && (
        <div className="border border-red-200 bg-red-50 text-red-800 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="size-4 mt-0.5 shrink-0" />
          <p className="text-sm">{error}</p>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v as TabValue); setError(null); }}>
        <TabsList className="w-full justify-start">
          <TabsTrigger value="cv" className="gap-2">
            <FileText className="size-4" />
            CV Export
          </TabsTrigger>
          <TabsTrigger value="id-card" className="gap-2">
            <FileText className="size-4" />
            ID Card
          </TabsTrigger>
          <TabsTrigger value="certificate" className="gap-2">
            <FileText className="size-4" />
            Certificate
          </TabsTrigger>
          <TabsTrigger value="evaluation" className="gap-2">
            <UserCheck className="size-4" />
            Evaluation Report
          </TabsTrigger>
          <TabsTrigger value="offer-letter" className="gap-2">
            <FileSignature className="size-4" />
            Offer Letter
          </TabsTrigger>
          <TabsTrigger value="bank-advice" className="gap-2">
            <Landmark className="size-4" />
            Bank Advice
          </TabsTrigger>
        </TabsList>

        {/* ─── CV Export Tab ─────────────────────────────── */}
        <TabsContent value="cv" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="size-5 text-primary" />
                Candidate CV / Resume Export
              </CardTitle>
              <CardDescription>
                Generate a PDF of a candidate&apos;s CV or resume by entering their candidate ID.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="candidate-id">Candidate ID</Label>
                <Input
                  id="candidate-id"
                  type="number"
                  min={1}
                  placeholder="e.g. 12345"
                  value={candidateId}
                  onChange={(e) => setCandidateId(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCvDownload(); }}
                />
                <p className="text-xs text-muted-foreground">
                  The numeric ID of the candidate whose CV you want to export.
                </p>
              </div>
            </CardContent>
            <div className="p-6 pt-0">
              <Button
                onClick={handleCvDownload}
                disabled={loading === "cv" || !candidateId.trim()}
                className="gap-2"
              >
                <Download className="size-4" />
                {loading === "cv" ? "Downloading..." : "Download CV PDF"}
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">GET</span>{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                    /api/candidates/{`{candidateId}`}/cv/pdf?format=pdf
                  </code>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── ID Card Tab ──────────────────────────────── */}
        <TabsContent value="id-card" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="size-5 text-primary" />
                Candidate Civil ID Card
              </CardTitle>
              <CardDescription>
                Generate a PDF of a candidate&apos;s civil ID card by entering their candidate ID.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="id-card-candidate-id">Candidate ID</Label>
                <Input
                  id="id-card-candidate-id"
                  type="number"
                  min={1}
                  placeholder="e.g. 12345"
                  value={candidateId}
                  onChange={(e) => setCandidateId(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleIdCardDownload(); }}
                />
                <p className="text-xs text-muted-foreground">
                  The numeric ID of the candidate whose civil ID card you want to export.
                </p>
              </div>
            </CardContent>
            <div className="p-6 pt-0">
              <Button
                onClick={handleIdCardDownload}
                disabled={loading === "id-card" || !candidateId.trim()}
                className="gap-2"
              >
                <Download className="size-4" />
                {loading === "id-card" ? "Downloading..." : "Download ID Card PDF"}
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">GET</span>{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                    /api/candidates/{`{candidateId}`}/id-card/pdf?format=pdf
                  </code>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Certificate Tab ──────────────────────────── */}
        <TabsContent value="certificate" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="size-5 text-primary" />
                Candidate Certificate
              </CardTitle>
              <CardDescription>
                Generate a PDF of a candidate&apos;s certificate by entering their candidate ID and certificate UUID.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="cert-candidate-id">Candidate ID</Label>
                <Input
                  id="cert-candidate-id"
                  type="number"
                  min={1}
                  placeholder="e.g. 12345"
                  value={certCandidateId}
                  onChange={(e) => setCertCandidateId(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCertificateDownload(); }}
                />
                <p className="text-xs text-muted-foreground">
                  The numeric ID of the candidate.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cert-uuid">Certificate UUID</Label>
                <Input
                  id="cert-uuid"
                  placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                  value={certUuid}
                  onChange={(e) => setCertUuid(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleCertificateDownload(); }}
                />
                <p className="text-xs text-muted-foreground">
                  The UUID of the certificate record.
                </p>
              </div>
            </CardContent>
            <div className="p-6 pt-0">
              <Button
                onClick={handleCertificateDownload}
                disabled={loading === "certificate" || !certCandidateId.trim() || !certUuid.trim()}
                className="gap-2"
              >
                <Download className="size-4" />
                {loading === "certificate" ? "Downloading..." : "Download Certificate PDF"}
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">GET</span>{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                    /api/candidates/{`{candidateId}`}/certificates/{`{uuid}`}/pdf?format=pdf
                  </code>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Evaluation Report Tab ─────────────────────── */}
        <TabsContent value="evaluation" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <UserCheck className="size-5 text-primary" />
                Evaluation Report
              </CardTitle>
              <CardDescription>
                Generate a PDF evaluation report for a candidate by entering the evaluation UUID.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="eval-uuid">Evaluation UUID</Label>
                <Input
                  id="eval-uuid"
                  placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                  value={evalUuid}
                  onChange={(e) => setEvalUuid(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleEvaluationDownload(); }}
                />
                <p className="text-xs text-muted-foreground">
                  The UUID of the candidate evaluation report.
                </p>
              </div>
            </CardContent>
            <div className="p-6 pt-0">
              <Button
                onClick={handleEvaluationDownload}
                disabled={loading === "evaluation" || !evalUuid.trim()}
                className="gap-2"
              >
                <Download className="size-4" />
                {loading === "evaluation" ? "Downloading..." : "Download Evaluation PDF"}
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">GET</span>{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                    /api/evaluations/{`{uuid}`}/pdf?format=pdf
                  </code>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Offer Letter Tab ─────────────────────── */}
        <TabsContent value="offer-letter" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSignature className="size-5 text-primary" />
                Offer Letter
              </CardTitle>
              <CardDescription>
                Generate a PDF offer letter for a fulltimer by entering their fulltimer UUID.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="offer-uuid">Fulltimer UUID</Label>
                <Input
                  id="offer-uuid"
                  placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                  value={offerUuid}
                  onChange={(e) => setOfferUuid(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleOfferLetterDownload(); }}
                />
                <p className="text-xs text-muted-foreground">
                  The UUID of the fulltimer record for the offer letter.
                </p>
              </div>
            </CardContent>
            <div className="p-6 pt-0">
              <Button
                onClick={handleOfferLetterDownload}
                disabled={loading === "offer-letter" || !offerUuid.trim()}
                className="gap-2"
              >
                <Download className="size-4" />
                {loading === "offer-letter" ? "Downloading..." : "Download Offer Letter PDF"}
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">GET</span>{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                    /api/fulltimers/{`{uuid}`}/offer-letter/pdf?format=pdf
                  </code>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── Bank Advice Tab ─────────────────────── */}
        <TabsContent value="bank-advice" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Landmark className="size-5 text-primary" />
                Bank Advice Document
              </CardTitle>
              <CardDescription>
                Generate a PDF bank advice document for a transfer by entering the bank advice UUID.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="bank-advice-uuid">Bank Advice UUID</Label>
                <Input
                  id="bank-advice-uuid"
                  placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
                  value={bankAdviceUuid}
                  onChange={(e) => setBankAdviceUuid(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleBankAdviceDownload(); }}
                />
                <p className="text-xs text-muted-foreground">
                  The UUID of the bank advice record you want to generate a PDF for.
                </p>
              </div>
            </CardContent>
            <div className="p-6 pt-0">
              <Button
                onClick={handleBankAdviceDownload}
                disabled={loading === "bank-advice" || !bankAdviceUuid.trim()}
                className="gap-2"
              >
                <Download className="size-4" />
                {loading === "bank-advice" ? "Downloading..." : "Download Bank Advice PDF"}
              </Button>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">API Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-sm text-muted-foreground space-y-1">
                <p>
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">GET</span>{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded break-all">
                    /api/transfers/bank-advice/{`{uuid}`}/pdf?format=pdf
                  </code>
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}