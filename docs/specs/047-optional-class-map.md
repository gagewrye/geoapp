# 047: Labels import first; the class map is optional and never blocks

**Status:** Approved by Gage 2026-11-01, with the recommended answers. **ADRs:** none (no dependency, no architecture change; the base's saved `lut` already links raw values to classes). **Amends:** spec 004 (Classes rule, *Class map* and *Strings* in Settled in build, criteria 3 and 12's class-map clauses), spec 014's "use a class map that leaves 0 out", spec 017's "Cancel keeps the chosen class map", spec 021/024's "too many before the pass with a class map", spec 035 scope 2's order, spec 044 scope 5 (draft: Use labels imports, then calls `applyClassMap` with the item's classes).

**Request** (Gage, 2026-11-01): "why does the app require a class map? that should be optional and the labels should import even if it is wrong. Label import first".

## Settled (Gage, 2026-11-01)
1. **Values a class map doesn't list** keep their class. The old import-time map left them unlabelled, which was spec 014's way to drop an untagged file's "Class 0"; unlabelling after the import would need a larger spec.
2. **Values the file's own table doesn't name** (unlisted, or their entry skipped) import as "Class v". App exports list every class, so round trips are unchanged.
3. **Strict match by value, no offset option.** The pseudo-label `classes.json` (values 0-7, mangrove 0) is meant only for the pseudo-label rasters, not for app exports such as `labels-last.tif` (1-8, nodata 0).
4. **Spec 044** calls `applyClassMap` with the item's classes after the import, instead of using them as an import-time class map.

## Scope
1. **Import takes no class map.** Classes come from the file's `GEOAPP_CLASSES`, read leniently (`readClassTable`), then "Class v" for every other value seen (`importEntries`). A bad table never refuses an import:
   - bad JSON, a non-array or an empty array: the whole table is ignored and every value gets "Class v";
   - an entry that isn't an object, has a bad value or name, a value already listed, a name already listed, or the file's nodata value is skipped;
   - a bad colour keeps the entry, with the palette colour.
   - The success message gains ` Ignored part of the file's class table: <field> <why>.`, the first skip, with ` (+M more)` before the full stop when there are more.
2. **Apply class map** (after the import). `#class-map` keeps its id, is labelled "Apply class map", sits after Import labels, and is enabled only while a base is loaded and the labels are unlocked. It renames and recolours classes, matching each entry's `value` to the class `base.lut[value]`. Painted tiles, the mask and history are untouched; no file or imagery is read. In entry order, an entry is skipped when it:
   - is not an object, or its value isn't an integer 0..255;
   - has a value that maps to no class (`lut[value]` is 0, so nodata or not in the file);
   - targets a class an earlier entry already changed;
   - has a name that fails spec 003's rule against the list as it stands (the target excluded).
   The `why` texts are, in that order: `must be an object`, `must be an integer 0..255`, `has no class in these labels`, `targets a class an earlier entry changed`, `must be a unique, non-empty string`. A bad colour keeps the class's colour. The result is a class edit: it repaints like a recolour and marks the record dirty (spec 031). Messages: `Class map applied to K classes.`, or `Class map matched no class.` as an error when K = 0, each followed by ` Skipped: <field> <why>.` (with ` (+M more)`) when entries were skipped. Bad JSON is the skip `JSON is not valid JSON`.
3. Removed: `parseClasses`, `ClassTableError`, `MESSAGES.classTable`, and the class map argument of `importTable`.

**Out of scope:** unlabelling values from a map (question 1), matching by name, saving or exporting the map itself, undoing an apply.

## Interfaces (`core/classTable.ts`)
```ts
type Skip = { field: string; why: string };   // field as before: "JSON", "table", "[i]", "[i].value", "[i].name", "[i].colour"
readClassTable(json: unknown, nodata: number | null): { entries: ClassEntry[]; skipped: Skip[] }   // never throws
importEntries(table: ClassEntry[], seen: Uint8Array, nodata: number | null): ClassEntry[]   // table, then "Class v" for seen values it lacks, ascending, nodata skipped
applyClassMap(classes: LabelClass[], lut: Uint8Array, json: unknown): { classes: LabelClass[]; applied: number; skipped: Skip[] }   // input list not mutated
```
`io/seeding.ts`: `importTable(file): { table: ClassEntry[] | null; skipped: Skip[] }`. A "Class v" name that a table entry already uses joins that class (`mergeClasses`' exact-name rule). "Too many" comes before the pass if the table alone has over 255 entries, else after it.

## Acceptance criteria
1. **Unit, `readClassTable`:** a valid table gives every entry and no skips. Bad JSON text (through `importTable`), a non-array and `[]` each give no entries and one skip. A table with one each of: a non-object, value 300, a duplicate value, a duplicate name, an empty name, the nodata value and colour "red" keeps only the valid entries (the "red" one without a colour). Each skip names its field, in entry order.
2. **Unit, `importEntries`:** table [{3, "Water"}] with seen {0, 3, 7} and nodata 255 gives Water, Class 0, Class 7. With nodata 0 it gives Water, Class 7. An empty table equals `classesFromValues`.
3. **Unit, `applyClassMap`:** classes [A, B, C] with lut 3→1, 5→2, 7→3 and map [{5, "Mangrove", "#00ff00"}, {0, "X"}, {7, "A"}, {3, "Q"}, {3, "R"}, {9, "Z"}] gives [Q, Mangrove (#00ff00), C], applied 2. The skips are, in order, [1].value, [2].name (A is taken), [4].value (already changed) and [5].value, with scope 2's texts. The input list is unchanged.
4. **Unit, import never refused (fake sources):** a file with nodata 0, values 1-8 and a table naming values 0-8 imports. Its classes, `count` and preview equal those of the same file whose table omits value 0, and the message names `[0].value`. A file whose table is not JSON imports with "Class v" names. Neither throws.
5. **Unit:** with a valid table, classes, `count`, labelled windows and preview equal those before this spec. Spec 024 criterion 2 passes.
6. **E2E, layout:** after open, `#import-labels` comes before `#class-map` in `#topbar`. `#class-map` is disabled before any import and enabled after one.
7. **E2E, apply:** import the 0/3/7 file (nodata 255), paint a stroke, then apply a map naming 3 "Water" (#0000ff) and 0 "Sand". The list reads Sand, Water, Class 7. The mask pixel of value 3 renders in #0000ff blended at 0.6 opacity. The painted tile is byte-equal to before, and Undo still undoes the stroke. The message is `Class map applied to 2 classes.`
8. **E2E, the real case:** import a label file of nodata 0, values 1-8 and its own table, then apply the map [{0, "mangrove"}, {1, "m1"}, ..., {7, "m7"}] (names not in the file's table). The message is `Class map applied to 7 classes. Skipped: [0].value has no class in these labels.` Classes 1-7 are named m1-m7, class 8 keeps its name, and every `tile(key)` is unchanged.
9. **E2E:** applying a non-JSON file shows `Class map matched no class. Skipped: JSON is not valid JSON.` in red, and changes nothing.
10. **E2E:** during an import, during an export, and while a restore is pending, `#class-map` is disabled (spec 021 criterion 8 holds).
11. **Unit, fake store (spec 031):** an apply marks the record dirty, and the saved record holds the new names and colours. A restore shows them.
12. Spec 004 criterion 11, spec 014 criteria 9 and 14 and spec 021 criteria 1-6 pass. Tests of the removed import-time map are deleted or moved to criteria 7-9, each listed in the change. `npm run check` passes.
