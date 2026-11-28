import { useState } from 'react';
import { FileText } from 'lucide-react';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { fetchBlendTicketWeights, matchesPageRead, resolveTicketLines, totalWeightText } from '../../lib/blendTicketWeights';
import { downloadReportPdf } from '../../lib/reportPdf';
import { Sentry } from '../../lib/sentry';
import { toSentryError } from '../../lib/sentryError';

interface BlendTicketPrintButtonProps {
  ticketId: string;
  pageRead: { header: Record<string, unknown>; lines: ReadonlyArray<Record<string, unknown>> } | null;
  disabled: boolean;
}

export function BlendTicketPrintButton({ ticketId, pageRead, disabled }: BlendTicketPrintButtonProps) {
  const { toast } = useToast();
  const [printing, setPrinting] = useState(false);

  async function download() {
    if (disabled || printing || !pageRead) return;
    setPrinting(true);
    try {
      const saved = await fetchBlendTicketWeights(ticketId);
      const number = saved.ticket?.ticket_number;
      const date = saved.ticket?.ticket_date;
      if (saved.ticket?.id !== ticketId || typeof number !== 'string' ||
          number !== pageRead.header.ticket_number || date !== pageRead.header.ticket_date ||
          !matchesPageRead(saved, pageRead.header, pageRead.lines)) {
        toast('error', 'The saved ticket could not be matched to this page. Reopen the ticket before downloading.');
        return;
      }
      if (saved.ticket.source === 'ocr' && saved.ticket.review_status !== 'approved') {
        toast('error', 'Approve this OCR ticket before downloading its PDF.');
        return;
      }
      if (saved.lines.length === 0) {
        toast('error', 'This ticket has no saved product lines to print.');
        return;
      }

      const lines = resolveTicketLines(saved.lines.map(({ line_id, product_id, line, weight }) => {
        const ticketName = typeof line.product_name === 'string' ? line.product_name : '';
        return {
          id: line_id,
          product_id,
          product_name: 'captured_name' in weight ? weight.captured_name : ticketName,
          quantity: line.quantity,
          unit: typeof line.unit === 'string' ? line.unit : null,
          catalogForm: null,
        };
      }), { saved, current: null });

      await downloadReportPdf({
        title: 'Blend Ticket',
        fileName: `Blend Ticket ${number}`,
        subtitle: [number, date].filter(Boolean).join(' · '),
        orientation: 'portrait',
        columns: [
          { key: 'product', header: 'Product' },
          { key: 'amount', header: 'Amount' },
          { key: 'weight', header: 'Saved product weight' },
        ],
        data: lines.map(({ mapped, text }, index) => {
          const ticketName = saved.lines[index].line.product_name;
          const differs = typeof ticketName === 'string' && ticketName.trim() !== '' && ticketName !== mapped.product_name;
          return {
            product: differs ? mapped.product_name + '\nTicket text: ' + ticketName : mapped.product_name,
            amount: [mapped.quantity, mapped.unit].filter((value) => value != null).join(' '),
            weight: text,
          };
        }),
        totalsRow: ['', '', totalWeightText(lines)],
      });
    } catch (error: unknown) {
      Sentry.captureException(toSentryError(error), { tags: { action: 'download_blend_ticket_pdf' } });
      toast('error', 'Could not download the ticket PDF. Try again.');
    } finally {
      setPrinting(false);
    }
  }

  return (
    <Button type="button" variant="secondary" icon={<FileText className="h-4 w-4" />}
      disabled={disabled || !pageRead} loading={printing} onClick={download}>
      Download ticket PDF
    </Button>
  );
}
