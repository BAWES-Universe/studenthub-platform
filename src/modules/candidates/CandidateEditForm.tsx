"use client";

import { useActionState, useEffect } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProfileState, EducationState, LanguageState } from "@/modules/candidates/actions";
import {
  updateCandidateProfile,
  uploadDocument,
  addCandidateSkill,
  removeCandidateSkill,
  addCandidateExperience,
  removeCandidateExperience,
  addCandidateCertificate,
  removeCandidateCertificate,
  addCandidateEducation,
  removeCandidateEducation,
  addCandidateLanguage,
  removeCandidateLanguage,
} from "@/modules/candidates/actions";

type Option = { id: number; label: string };
type UuidOption = { id: string; label: string };

type Skill = { id: number; title: string };
type Experience = { id: number; title: string; subtitle: string };
type Certificate = { id: string; title: string; subtitle: string };
type Language = { id: number; title: string; subtitle: string };
type EducationEntry = {
  id: string;
  universityId: number;
  degreeUuid: string | null;
  majorUuid: string | null;
  graduationYear: number | null;
  isCurrentlyStudying: boolean;
  universityLabel: string;
  degreeLabel?: string;
  majorLabel?: string;
};

type Props = {
  candidate: {
    name: string;
    nameAr: string;
    email: string;
    phone: string;
    objective: string;
    intro: string;
    civilId: string;
    profileUrl: string;
    birthDate: string;
    address: string;
    countryId: number | null;
    universityId: number | null;
    bankId: number | null;
    bankAccountName: string;
    iban: string;
    personalPhoto: string | null;
    resume: string | null;
    video: string | null;
    civilPhotoFront: string | null;
    civilPhotoBack: string | null;
  };
  countries: Option[];
  universities: Option[];
  banks: Option[];
  skills: Skill[];
  experiences: Experience[];
  certificates: Certificate[];
  languages: Language[];
  educationEntries: EducationEntry[];
  degrees: UuidOption[];
  majors: UuidOption[];
};

export function CandidateEditForm({
  candidate,
  countries,
  universities,
  banks,
  skills,
  experiences,
  certificates,
  languages,
  educationEntries,
  degrees,
  majors,
}: Props) {
  const [profileState, profileAction, profilePending] = useActionState(
    updateCandidateProfile,
    { success: false } as ProfileState,
  );

  useEffect(() => {
    if (profileState.success) {
      toast.success("Profile saved", { description: "Your profile has been updated successfully." });
    }
  }, [profileState]);
  const [uploadState, uploadAction, uploadPending] = useActionState(uploadDocument, { error: "" });
  const [, addSkillAction, addSkillPending] = useActionState(addCandidateSkill, { error: "" });
  const [, removeSkillAction, removeSkillPending] = useActionState(removeCandidateSkill, { error: "" });
  const [, addExpAction, addExpPending] = useActionState(addCandidateExperience, { error: "" });
  const [, removeExpAction, removeExpPending] = useActionState(removeCandidateExperience, { error: "" });
  const [certState, addCertAction, addCertPending] = useActionState(addCandidateCertificate, { error: "" });
  const [, removeCertAction, removeCertPending] = useActionState(removeCandidateCertificate, { error: "" });
  const [addEduState, addEduAction, addEduPending] = useActionState(addCandidateEducation, { success: false } as EducationState);
  const [removeEduState, removeEduAction, removeEduPending] = useActionState(removeCandidateEducation, { success: false } as EducationState);
  const [addLangState, addLangAction, addLangPending] = useActionState<LanguageState, FormData>(addCandidateLanguage, { success: false } as LanguageState);
  const [removeLangState, removeLangAction, removeLangPending] = useActionState<LanguageState, FormData>(removeCandidateLanguage, { success: false } as LanguageState);

  useEffect(() => {
    if (addEduState.success) { toast.success("Education added", { description: "Your education entry has been added." }); }
  }, [addEduState]);
  useEffect(() => {
    if (removeEduState.success) { toast.success("Education removed", { description: "The education entry has been removed." }); }
  }, [removeEduState]);
  useEffect(() => {
    if (addLangState.success) { toast.success("Language added", { description: "Your language has been added." }); }
  }, [addLangState]);
  useEffect(() => {
    if (removeLangState.success) { toast.success("Language removed", { description: "The language entry has been removed." }); }
  }, [removeLangState]);

  return (
    <div className="space-y-6">
      {/* ── Personal Info ── */}
      <Card>
        <CardHeader>
          <CardTitle>Personal info</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={profileAction} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Name (English)</Label>
                <Input id="name" name="name" defaultValue={candidate.name} required />
                <FieldError errors={profileState.fieldErrors?.name} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="nameAr">Name (Arabic)</Label>
                <Input id="nameAr" name="nameAr" defaultValue={candidate.nameAr} />
                <FieldError errors={profileState.fieldErrors?.nameAr} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" name="email" type="email" defaultValue={candidate.email} />
                <FieldError errors={profileState.fieldErrors?.email} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone">Phone</Label>
                <Input id="phone" name="phone" type="tel" defaultValue={candidate.phone} />
                <FieldError errors={profileState.fieldErrors?.phone} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="birthDate">Birth date</Label>
                <Input id="birthDate" name="birthDate" type="date" defaultValue={candidate.birthDate} />
                <FieldError errors={profileState.fieldErrors?.birthDate} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="countryId">Country / Nationality</Label>
                <Select name="countryId" defaultValue={candidate.countryId?.toString() ?? ""}>
                  <SelectTrigger id="countryId" className="w-full">
                    <SelectValue placeholder="— Not set —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— Not set —</SelectItem>
                    {countries.map((c) => (
                      <SelectItem key={c.id} value={c.id.toString()}>{c.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={profileState.fieldErrors?.countryId} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="universityId">University</Label>
                <Select name="universityId" defaultValue={candidate.universityId?.toString() ?? ""}>
                  <SelectTrigger id="universityId" className="w-full">
                    <SelectValue placeholder="— Not set —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— Not set —</SelectItem>
                    {universities.map((u) => (
                      <SelectItem key={u.id} value={u.id.toString()}>{u.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={profileState.fieldErrors?.universityId} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="address">Address</Label>
                <Textarea id="address" name="address" rows={2} defaultValue={candidate.address} />
                <FieldError errors={profileState.fieldErrors?.address} />
              </div>
            </div>

            <Separator />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="bankId">Bank</Label>
                <Select name="bankId" defaultValue={candidate.bankId?.toString() ?? ""}>
                  <SelectTrigger id="bankId" className="w-full">
                    <SelectValue placeholder="— Not set —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— Not set —</SelectItem>
                    {banks.map((b) => (
                      <SelectItem key={b.id} value={b.id.toString()}>{b.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError errors={profileState.fieldErrors?.bankId} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bankAccountName">Account holder name</Label>
                <Input id="bankAccountName" name="bankAccountName" defaultValue={candidate.bankAccountName} />
                <FieldError errors={profileState.fieldErrors?.bankAccountName} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="iban">IBAN</Label>
                <Input id="iban" name="iban" defaultValue={candidate.iban} />
                <FieldError errors={profileState.fieldErrors?.iban} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="civilId">Civil ID</Label>
                <Input id="civilId" name="civilId" defaultValue={candidate.civilId} />
                <FieldError errors={profileState.fieldErrors?.civilId} />
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label htmlFor="objective">Objective / Headline</Label>
              <Input id="objective" name="objective" defaultValue={candidate.objective} />
              <FieldError errors={profileState.fieldErrors?.objective} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profileUrl">Profile URL</Label>
              <Input id="profileUrl" name="profileUrl" type="url" defaultValue={candidate.profileUrl} />
              <FieldError errors={profileState.fieldErrors?.profileUrl} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="intro">About / Intro</Label>
              <Textarea id="intro" name="intro" rows={5} defaultValue={candidate.intro} />
              <FieldError errors={profileState.fieldErrors?.intro} />
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={profilePending}>
                {profilePending ? "Saving..." : "Save profile"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* ── Documents ── */}
      <Card>
        <CardHeader>
          <CardTitle>Documents</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={uploadAction} className="space-y-4">
            {uploadState.error ? (
              <p className="text-sm font-bold text-destructive">{uploadState.error}</p>
            ) : null}
            <DocumentUpload label="Profile photo" type="photo" current={candidate.personalPhoto} />
            <DocumentUpload label="CV / Resume" type="cv" current={candidate.resume} />
            <DocumentUpload label="Video" type="video" current={candidate.video} />
            <DocumentUpload label="Civil ID (front)" type="civilFront" current={candidate.civilPhotoFront} />
            <DocumentUpload label="Civil ID (back)" type="civilBack" current={candidate.civilPhotoBack} />
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={uploadPending}>
                {uploadPending ? "Uploading..." : "Upload document"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* ── Skills ── */}
      <Card>
        <CardHeader>
          <CardTitle>Skills</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addSkillAction} className="space-y-4">
            {skills.length ? (
              <ul className="space-y-2">
                {skills.map((s) => (
                  <li key={s.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <span>{s.title}</span>
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      form={`remove-skill-${s.id}`}
                      disabled={removeSkillPending}
                      className="text-destructive hover:text-destructive/80"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No skills added yet.</p>
            )}
            <div className="space-y-2">
              <Label htmlFor="skill">Add skill</Label>
              <Input id="skill" name="skill" placeholder="e.g. Cashier, Barista, Driver..." />
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={addSkillPending}>
                {addSkillPending ? "Adding..." : "Add skill"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {skills.map((s) => (
        <form key={s.id} id={`remove-skill-${s.id}`} action={removeSkillAction} hidden>
          <input type="hidden" name="skillId" value={s.id} />
        </form>
      ))}

      {/* ── Work Experience ── */}
      <Card>
        <CardHeader>
          <CardTitle>Work experience</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addExpAction} className="space-y-4">
            {experiences.length ? (
              <ul className="space-y-2">
                {experiences.map((e) => (
                  <li key={e.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <span>{e.title}{e.subtitle ? ` at ${e.subtitle}` : ""}</span>
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      form={`remove-exp-${e.id}`}
                      disabled={removeExpPending}
                      className="text-destructive hover:text-destructive/80"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No work experience added yet.</p>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="experience">Job title / Role</Label>
                <Input id="experience" name="experience" placeholder="e.g. Sales Associate" required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="employer">Employer / Company</Label>
                <Input id="employer" name="employer" placeholder="e.g. Alshaya" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="startYear">Start year</Label>
                <Input id="startYear" name="startYear" type="number" min="1950" max="2035" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endYear">End year</Label>
                <Input id="endYear" name="endYear" type="number" min="1950" max="2035" />
              </div>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={addExpPending}>
                {addExpPending ? "Adding..." : "Add experience"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {experiences.map((e) => (
        <form key={e.id} id={`remove-exp-${e.id}`} action={removeExpAction} hidden>
          <input type="hidden" name="experienceId" value={e.id} />
        </form>
      ))}

      {/* ── Certificates ── */}
      <Card>
        <CardHeader>
          <CardTitle>Certificates</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addCertAction} className="space-y-4">
            {certificates.length ? (
              <ul className="space-y-2">
                {certificates.map((c) => (
                  <li key={c.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <span>{c.title}{c.subtitle ? ` — ${c.subtitle}` : ""}</span>
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      form={`remove-cert-${c.id}`}
                      disabled={removeCertPending}
                      className="text-destructive hover:text-destructive/80"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No certificates added yet.</p>
            )}
            <div className="space-y-2">
              <Label htmlFor="certificate_type">Certificate type</Label>
              <Select name="certificate_type" defaultValue="false">
                <SelectTrigger id="certificate_type" className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">Training Certificate</SelectItem>
                  <SelectItem value="true">Experience Certificate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="certificate_title">Certificate title</Label>
              <Input id="certificate_title" name="certificate_title" placeholder="e.g. AWS Cloud Practitioner" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="certificate_issuer">Issuer / Organization</Label>
              <Input id="certificate_issuer" name="certificate_issuer" placeholder="e.g. Amazon Web Services" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="start_date">Date obtained</Label>
                <Input id="start_date" name="start_date" type="date" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end_date">Expiry date</Label>
                <Input id="end_date" name="end_date" type="date" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="certificate_url">Certificate URL</Label>
              <Input id="certificate_url" name="certificate_url" type="url" placeholder="https://example.com/cert/123" />
            </div>
            {certState.error ? (
              <p className="text-sm font-bold text-destructive">{certState.error}</p>
            ) : null}
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={addCertPending}>
                {addCertPending ? "Adding..." : "Add certificate"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {certificates.map((c) => (
        <form key={c.id} id={`remove-cert-${c.id}`} action={removeCertAction} hidden>
          <input type="hidden" name="certificateUuid" value={c.id} />
        </form>
      ))}

      {/* ── Languages ── */}
      <Card>
        <CardHeader>
          <CardTitle>Languages</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addLangAction} className="space-y-4">
            {languages.length ? (
              <ul className="space-y-2">
                {languages.map((l) => (
                  <li key={l.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <span>
                      {l.title}{" "}
                      <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {l.subtitle}
                      </span>
                    </span>
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      form={`remove-lang-${l.id}`}
                      disabled={removeLangPending}
                      className="text-destructive hover:text-destructive/80"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No languages added yet.</p>
            )}
            <div className="space-y-2">
              <Label htmlFor="language">Language</Label>
              <Select name="language" required defaultValue="">
                <SelectTrigger id="language" className="w-full">
                  <SelectValue placeholder="— Select language —" />
                </SelectTrigger>
                <SelectContent>
                  {["Arabic","English","French","Spanish","Portuguese","German","Italian","Dutch","Russian","Turkish","Persian","Urdu","Hindi","Bengali","Punjabi","Japanese","Korean","Chinese","Tagalog","Vietnamese","Thai","Malay","Indonesian","Swahili","Amharic","Somali","Greek"].map((lang) => (
                    <SelectItem key={lang} value={lang}>{lang}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="proficiency">Proficiency</Label>
              <Select name="proficiency" required defaultValue="">
                <SelectTrigger id="proficiency" className="w-full">
                  <SelectValue placeholder="— Select level —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="basic">Basic</SelectItem>
                  <SelectItem value="intermediate">Intermediate</SelectItem>
                  <SelectItem value="advanced">Advanced</SelectItem>
                  <SelectItem value="native">Native</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {addLangState.error ? (
              <p className="text-sm font-bold text-destructive">{addLangState.error}</p>
            ) : null}
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={addLangPending}>
                {addLangPending ? "Adding..." : "Add language"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {languages.map((l) => (
        <form key={l.id} id={`remove-lang-${l.id}`} action={removeLangAction} hidden>
          <input type="hidden" name="languageId" value={l.id} />
        </form>
      ))}

      {/* ── Education ── */}
      <Card>
        <CardHeader>
          <CardTitle>Education</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={addEduAction} className="space-y-4">
            {educationEntries.length ? (
              <ul className="space-y-2">
                {educationEntries.map((e) => (
                  <li key={e.id} className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm">
                    <span>
                      {e.universityLabel}
                      {e.degreeLabel ? ` · ${e.degreeLabel}` : ""}
                      {e.majorLabel ? ` · ${e.majorLabel}` : ""}
                      {e.graduationYear ? ` (${e.graduationYear})` : ""}
                      {e.isCurrentlyStudying ? " · Currently studying" : ""}
                    </span>
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      form={`remove-edu-${e.id}`}
                      disabled={removeEduPending}
                      className="text-destructive hover:text-destructive/80"
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No education entries added yet.</p>
            )}
            <div className="space-y-2">
              <Label htmlFor="eduUniversityId">University</Label>
              <Select name="universityId" required defaultValue="">
                <SelectTrigger id="eduUniversityId" className="w-full">
                  <SelectValue placeholder="— Select university —" />
                </SelectTrigger>
                <SelectContent>
                  {universities.map((u) => (
                    <SelectItem key={u.id} value={u.id.toString()}>{u.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="degreeUuid">Degree</Label>
                <Select name="degreeUuid" defaultValue="">
                  <SelectTrigger id="degreeUuid" className="w-full">
                    <SelectValue placeholder="— None —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— None —</SelectItem>
                    {degrees.map((d) => (
                      <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="majorUuid">Major</Label>
                <Select name="majorUuid" defaultValue="">
                  <SelectTrigger id="majorUuid" className="w-full">
                    <SelectValue placeholder="— None —" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">— None —</SelectItem>
                    {majors.map((m) => (
                      <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="graduationYear">Graduation year</Label>
                <Input id="graduationYear" name="graduationYear" type="number" min="1950" max="2035" />
              </div>
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm text-foreground cursor-pointer">
                  <input
                    name="isCurrentlyStudying"
                    type="checkbox"
                    value="1"
                    className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  />
                  Currently studying
                </label>
              </div>
            </div>
            {addEduState.error ? (
              <p className="text-sm font-bold text-destructive">{addEduState.error}</p>
            ) : null}
            <div className="flex items-center gap-3 pt-2">
              <Button type="submit" disabled={addEduPending}>
                {addEduPending ? "Adding..." : "Add education"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {educationEntries.map((e) => (
        <form key={e.id} id={`remove-edu-${e.id}`} action={removeEduAction} hidden>
          <input type="hidden" name="educationUuid" value={e.id} />
        </form>
      ))}
    </div>
  );
}

function DocumentUpload({ label, type, current }: { label: string; type: string; current: string | null }) {
  return (
    <fieldset className="rounded-md border border-border p-3">
      <legend className="text-sm font-medium text-muted-foreground px-1">{label}</legend>
      <input type="hidden" name="type" value={type} />
      <input
        type="file"
        name={`file_${type}`}
        accept={acceptFor(type)}
        className="block w-full text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/20"
      />
      {current ? (
        <small className="mt-1 block text-xs text-muted-foreground">
          Current: <a href={current} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{current.split("/").pop()}</a>
        </small>
      ) : (
        <small className="mt-1 block text-xs text-muted-foreground">No file uploaded yet.</small>
      )}
    </fieldset>
  );
}

function acceptFor(type: string): string {
  switch (type) {
    case "photo": case "civilFront": case "civilBack": return "image/*";
    case "cv": return ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "video": return "video/*";
    default: return "*/*";
  }
}

function FieldError({ errors }: { errors?: string[] }) {
  return errors?.[0] ? <p className="text-sm font-bold text-destructive mt-1">{errors[0]}</p> : null;
}
