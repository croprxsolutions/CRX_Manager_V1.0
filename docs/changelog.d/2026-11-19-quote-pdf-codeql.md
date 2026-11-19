## 2026-11-19 - Quote PDF footer test compares the website exactly

CodeQL (js/incomplete-url-substring-sanitization) still flagged `src/lib/quotePdf.test.ts` on the v0.1.0 release PR #1990 after #1992, because its rule matches any `.includes` on a URL-like literal, `Array.prototype.includes` included. The footer test now finds the footer line by an exact word comparison (`w === site`). The test is unchanged in meaning: the footer joins its parts with `  •  `, so the website is always a whole word. It's a test-only change and the alert was a false positive; it is fixed, not dismissed.
