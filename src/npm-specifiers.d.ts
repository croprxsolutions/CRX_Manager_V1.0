// The PDF code in supabase/functions/_shared/pdf is shared with Deno, which imports
// packages as `npm:` specifiers (type-only there). These map them to the app's own
// packages for tsc; keep the versions equal to package.json (KNOWN_ISSUES KI-98).
declare module 'npm:jspdf@4.2.1' {
  export * from 'jspdf';
}
declare module 'npm:jspdf-autotable@5.0.9' {
  export * from 'jspdf-autotable';
}
declare module 'npm:@supabase/supabase-js@2.57.4' {
  export * from '@supabase/supabase-js';
}
