import { readFileSync, writeFileSync } from 'node:fs';
const [src, out] = process.argv.slice(2);
const s = readFileSync(src, 'utf8').replaceAll('\r\n', '\n');
const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
if (s.split(needle).length !== 2) throw new Error('ambiguous definition');
const start = s.indexOf(needle);
const tag = /\$([A-Za-z_]*)\$/.exec(s.slice(start));
const bodyStart = start + tag.index + tag[0].length;
const body = s.slice(bodyStart, s.indexOf(tag[0], bodyStart)).replace(/\n/g, '\r\n');
if (body.length !== 15910) throw new Error('length drift ' + body.length);
writeFileSync(out, `CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
  RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
  AS $live_crlf_close$${body}$live_crlf_close$;\n`);
