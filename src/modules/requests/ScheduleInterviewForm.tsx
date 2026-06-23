"use client";

import { useState } from "react";
import { CalendarPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FormSelect } from "./FormSelect";
import { scheduleInterviewAction } from "@/modules/requests/interview-actions";

interface MatchCandidate {
  id: number;
  name: string;
}

interface ScheduleInterviewFormProps {
  requestUuid: string;
  matchedCandidates: MatchCandidate[];
}

export function ScheduleInterviewForm({
  requestUuid,
  matchedCandidates,
}: ScheduleInterviewFormProps) {
  const [showForm, setShowForm] = useState(false);

  if (!showForm) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setShowForm(true)}
      >
        <CalendarPlus aria-hidden="true" />
        Schedule interview
      </Button>
    );
  }

  return (
    <form action={scheduleInterviewAction} className="grid gap-4 rounded-lg border p-4">
      <input name="request_uuid" type="hidden" value={requestUuid} />

      <div className="grid gap-2">
        <Label htmlFor="interview_candidate">Candidate</Label>
        {matchedCandidates.length > 0 ? (
          <FormSelect
            name="candidate_id"
            options={[
              { value: "", label: "Select candidate…" },
              ...matchedCandidates.map((c) => ({ value: String(c.id), label: c.name })),
            ]}
            placeholder="Select candidate…"
            required
          />
        ) : (
          <Input
            name="candidate_id"
            type="number"
            placeholder="Candidate ID"
            required
            min={1}
          />
        )}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="interview_at">Date & time</Label>
        <Input
          id="interview_at"
          name="interview_at"
          type="datetime-local"
          required
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="internal_note">Note (optional)</Label>
        <Textarea
          id="internal_note"
          name="internal_note"
          placeholder="Any details about this interview…"
          rows={2}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" variant="default" size="sm">
          Schedule
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowForm(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
