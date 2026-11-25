## 2026-11-24 — MOA-1: the 12-ingredient top-up list is approved

**Decision (Mason, in chat, 2026-11-24: "Yes, approve the 12"):** the 12 ingredients the live EPA batch fill added after the MOA-1 list v2 (approved 2026-11-18) get these groups: 2,4-D 2-ethylhexyl ester HRAC 4; Chlorpyrifos IRAC 1B; Dicamba dimethylamine salt HRAC 4; Glyphosate potassium salt HRAC 9; Halosulfuron-methyl HRAC 2; Imazamox HRAC 2; Imazethapyr ammonium salt HRAC 2; MCPP-P DMA salt HRAC 4; Metolachlor HRAC 15; Paraquat dichloride HRAC 22; Sodium acifluorfen HRAC 14; Trifluralin HRAC 3.
**Why:** a read-only dry run of the approved load on live (2026-11-24, 145 active ingredients) fills 119; these 12 have a published group but are not on list v2. Mason spot-checks labels; the source is the HRAC 2026 master list and IRAC v11.5.
**What this forbids/implies:**
- Written by its own reviewed migration, `20270305120000_ingredient_modes_of_action_load_topup.sql`, with the load's rules unchanged; never by hand on live.
- Still left without a group, by design: the 5 with no resistance group (nitrapyrin, trinexapac-ethyl, three growth regulators) and the 6 Bacillus rows (not approved). Zeta-Cypermethrin is 3 active rows with no CAS, so neither load can match it: a data cleanup, then the per-ingredient editor.
