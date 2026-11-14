'use strict';

// Seam context of partition scheme clouseau-partition/2 (docs/local-review.md, chunked review). Pure and model-free, so
// CI recomputes it from the signed snapshot and the protected parameters alone.
//
// Under /1 a unit sees its own sources only, so a unit whose owned file imports, is imported by, or tests a changed file
// of another unit can only record that file as missing. Under /2 the controller fills each unit's `context_ids` with the
// other end of every seam the unit is an end of (review-seams.cjs), most relevant seam first (integration-plan.cjs), as
// long as the unit's view still fits its evidence cap:
//
//   * only CHANGED files of the same snapshot are ever added (seams join changed files only), never an unchanged source,
//     so no unit's shared context moves and no unit gets a source the snapshot does not contain;
//   * the other end is read at head, or at base when the change removes it (the file the importer still names);
//   * a source the view already holds (its own, or a derived lockfile summary every view holds) is not added twice;
//   * an end that does not fit is skipped and smaller ones are still tried; nothing is truncated, and a unit that still
//     lacks evidence records it as missing, as under /1.
//
// A unit's view does not depend on the context of other units for changed sources (review-units.cjs names only
// unchanged sources as shared), so each unit is decided on its own, in plan order.

const {relevance} = require('./integration-plan.cjs');

const fileSources = file => [file.base_source, file.head_source].filter(Boolean);
const measured = view => {const {digest: _, ...value} = view; return JSON.stringify(value).length;};

// `specs`: the context-free unit specs of the plan, in plan order. `seams`: seamsOf over that plan. `view(spec, units)`:
// the unit view of `spec` among `units`, which throws code `unit_exceeds_budget` when it does not fit `cap`.
// Returns the specs with their `context_ids`.
function seamContext({snapshot, specs, seams, view, cap}) {
  const byPath = new Map(snapshot.files.map(file => [file.path, file]));
  const ranked = [...seams].sort(relevance);
  const units = specs.map(spec => ({...spec, context_ids: []}));
  return units.map((spec, index) => {
    const owned = new Set(spec.owned);
    const own = new Set(spec.owned.flatMap(name => fileSources(byPath.get(name))));
    const chosen = [];
    let current = view(spec, units);
    let used = measured(current);
    for (const seam of ranked) {
      for (const [mine, other] of [[seam.a, seam.b], [seam.b, seam.a]]) {
        if (!owned.has(mine.path) || owned.has(other.path)) continue;
        const file = byPath.get(other.path);
        const id = file?.head_source ?? file?.base_source;
        if (!id || own.has(id) || chosen.includes(id) || Object.hasOwn(current.sources, id)) continue;
        // The source's own characters are a lower bound of what it adds, so this only skips views that cannot fit.
        if (used + snapshot.sources[id].content.length > cap) continue;
        const candidate = {...spec, context_ids: [...chosen, id]};
        try {
          current = view(candidate, units.map((item, at) => (at === index ? candidate : item)));
        } catch (error) {
          if (error.code !== 'unit_exceeds_budget') throw error;
          continue;
        }
        used = measured(current);
        chosen.push(id);
      }
    }
    return {...spec, context_ids: chosen};
  });
}

module.exports = {seamContext};
