## 2026-11-05 - Client season follows the Chicago date (KI-18, pre-harvest warning)

The app's season and "today" for the season now use the America/Chicago date, like the database. A phone or
laptop set to another timezone could pick next season on the evening of Sept 30 and silently hide the
pre-harvest-interval warning on a job. Changed `src/utils/season.ts` and its callers, the new-job default date and
the pre-harvest check's fallback date. Boundary tests added; KI-18 updated.
