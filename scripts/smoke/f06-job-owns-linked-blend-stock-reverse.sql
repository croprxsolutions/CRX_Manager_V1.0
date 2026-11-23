-- Rollback for 20270227150000_f06_job_owns_linked_blend_stock.sql: removes the three guards. No data changes. One transaction, so they go together.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.jobs, public.blend_tickets, public.application_records IN SHARE ROW EXCLUSIVE MODE;
DROP TRIGGER IF EXISTS application_record_one_deduction_f06 ON public.application_records;
DROP TRIGGER IF EXISTS blend_ticket_link_keeps_stock_once_f06 ON public.blend_tickets;
DROP TRIGGER IF EXISTS job_customer_keeps_linked_tickets_f06 ON public.jobs;
DROP FUNCTION IF EXISTS public._f06_application_record_one_deduction();
DROP FUNCTION IF EXISTS public._f06_blend_ticket_link_keeps_stock_once();
DROP FUNCTION IF EXISTS public._f06_job_customer_keeps_linked_tickets();
COMMIT;
