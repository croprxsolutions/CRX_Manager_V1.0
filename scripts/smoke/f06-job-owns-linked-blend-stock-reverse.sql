-- Rollback for 20270225200000_f06_job_owns_linked_blend_stock.sql: removes both guards. No data changes.
DROP TRIGGER IF EXISTS application_record_one_deduction_f06 ON public.application_records;
DROP TRIGGER IF EXISTS blend_ticket_link_keeps_stock_once_f06 ON public.blend_tickets;
DROP FUNCTION IF EXISTS public._f06_application_record_one_deduction();
DROP FUNCTION IF EXISTS public._f06_blend_ticket_link_keeps_stock_once();
