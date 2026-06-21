"use client";

import { Ban, CheckCircle, Clock, Lock, Unlock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toggleCandidatePaidAction, toggleTransferStatusAction, markPaymentReceivedAction, deleteTransferAction } from "@/modules/finance/actions";

type TransferDetail = {
  transfer: {
    transfer_id: number;
    total: any;
    company_total: any;
    transfer_cost: any;
    transfer_status: number;
    start_date: Date | null;
    end_date: Date | null;
    payment_received_on: Date | null;
    transfer_created_at: Date;
    transfer_updated_at: Date;
    currency_code: string | null;
    company: { company_name: string | null; company_email: string | null } | null;
  } | null;
  candidates: { id: number; title: string; subtitle: string; meta: string }[];
  invoices: { id: number; title: string; subtitle: string; meta: string }[];
};

export function TransferActionBar({ data }: { data: TransferDetail }) {
  if (!data.transfer) return null;

  const isLocked = data.transfer.transfer_status !== 10;

  return (
    <section className="grid gap-6 mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <form action={toggleTransferStatusAction}>
          <input name="transfer_id" type="hidden" value={data.transfer.transfer_id} />
          <Button type="submit" variant={isLocked ? "secondary" : "outline"}>
            {isLocked ? <Unlock aria-hidden="true" /> : <Lock aria-hidden="true" />}
            {isLocked ? "Unlock transfer" : "Lock transfer"}
          </Button>
        </form>

        <PaymentReceivedForm transferId={data.transfer.transfer_id} currentDate={data.transfer.payment_received_on} />

        <form action={deleteTransferAction}>
          <input name="transfer_id" type="hidden" value={data.transfer.transfer_id} />
          <Button type="submit" variant="destructive">
            <Ban aria-hidden="true" />
            Delete
          </Button>
        </form>
      </div>

      {data.candidates.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Candidate Payouts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {data.candidates.map((candidate) => (
                <CandidatePayoutRow key={candidate.id} candidate={candidate} transferId={data.transfer!.transfer_id} />
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function CandidatePayoutRow({ candidate, transferId }: { candidate: TransferDetail["candidates"][number]; transferId: number }) {
  const isPaid = candidate.meta?.includes("Paid");

  return (
    <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 grid gap-0.5">
        <strong className="text-sm font-semibold text-foreground">{candidate.title}</strong>
        <span className="text-sm text-muted-foreground">{candidate.subtitle}</span>
        <small className="text-xs text-muted-foreground">{candidate.meta}</small>
      </div>
      <form action={toggleCandidatePaidAction}>
        <input name="transfer_id" type="hidden" value={transferId} />
        <input name="tc_id" type="hidden" value={candidate.id} />
        <Button type="submit" variant={isPaid ? "secondary" : "outline"} size="sm">
          {isPaid ? <CheckCircle aria-hidden="true" /> : <Clock aria-hidden="true" />}
          {isPaid ? "Mark unpaid" : "Mark paid"}
        </Button>
      </form>
    </div>
  );
}

function PaymentReceivedForm({ transferId, currentDate }: { transferId: number; currentDate: Date | null }) {
  return (
    <form action={markPaymentReceivedAction} className="flex items-end gap-2">
      <input name="transfer_id" type="hidden" value={transferId} />
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="received_on">Payment received on</label>
        <Input
          id="received_on"
          name="received_on"
          type="date"
          className="w-[160px]"
          defaultValue={currentDate ? new Date(currentDate).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)}
        />
      </div>
      <Button type="submit" variant="secondary">
        <CheckCircle aria-hidden="true" />
        Payment received
      </Button>
    </form>
  );
}
