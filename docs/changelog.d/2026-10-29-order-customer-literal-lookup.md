## 2026-10-29 - Match order import customer names literally

- Use an escaped, anchored case-insensitive regular-expression filter for the order import customer lookup, so asterisks and other pattern characters in a name stay literal.
- Extend the import regression case to cover asterisk, percent, underscore, backslash and regular-expression punctuation.
