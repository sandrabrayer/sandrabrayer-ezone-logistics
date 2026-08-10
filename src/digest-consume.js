// digest-consume.js — pure shaping for READ-ONLY consumption of a foreign app's digest on the
// /management screen (ezone-kitchen's FoodShortages tab). This app NEVER writes into another app's
// digest; it only reads, per DIGEST-CONTRACT.md.
//
// Discipline enforced here:
//   - columns are read BY HEADER NAME (rows are header-keyed objects), never by position;
//   - a house that does not map to a canonical HOUSE-IDS.md id is OMITTED, never guessed;
//   - a missing required header / unreadable source renders "לא זמין" (available:false), NEVER 0;
//   - no financial fields are read or emitted.
//
// The MIRROR:digestconsume block below is duplicated VERBATIM in apps-script/Code.gs; the
// mirror-drift guard test asserts they stay identical. The canonical id→name map is passed IN by the
// caller (built from each side's own house-id table), so the shaper stays generic and self-contained.

// === MIRROR:digestconsume START ===
// Header aliases for the kitchen FoodShortages tab — read by NAME so column order never matters and
// minor naming differences are tolerated. A row is an object keyed by its header.
var FOOD_HOUSE_KEYS = ['house', 'house_id', 'houseId', 'houseID'];
var FOOD_ITEM_KEYS = ['item', 'item_text', 'itemName', 'product', 'name'];

// The first candidate header actually present on the row, or '' if none are.
function pickHeader(row, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (row && Object.prototype.hasOwnProperty.call(row, candidates[i])) return candidates[i];
  }
  return '';
}

// Shape FoodShortages rows → { available, reason?, houses:[{id,house,count,items}] }.
//   rows     : array of header-keyed objects (empty array → available with no houses; NOT an error).
//   idToName : canonical house id → city-first Hebrew display name (HOUSE-IDS.md). A row whose house
//              id is not in this map is OMITTED (never guessed).
// Missing the house OR item header entirely → available:false (we will not fabricate a shape or a 0).
function summarizeFoodShortages(rows, idToName) {
  if (!rows || rows.length === 0) return { available: true, houses: [] };
  var houseKey = pickHeader(rows[0], FOOD_HOUSE_KEYS);
  var itemKey = pickHeader(rows[0], FOOD_ITEM_KEYS);
  if (!houseKey || !itemKey) return { available: false, reason: 'חסרות כותרות מזוהות בדייג׳סט המטבח' };
  var map = idToName || {};
  var byId = {};
  var order = [];
  for (var r = 0; r < rows.length; r++) {
    var id = String(rows[r][houseKey] == null ? '' : rows[r][houseKey]).replace(/^\s+|\s+$/g, '');
    if (!id || !Object.prototype.hasOwnProperty.call(map, id)) continue; // unmapped house → omit
    var item = String(rows[r][itemKey] == null ? '' : rows[r][itemKey]).replace(/^\s+|\s+$/g, '');
    if (!item) continue;
    if (!Object.prototype.hasOwnProperty.call(byId, id)) { byId[id] = { id: id, house: map[id], count: 0, items: [] }; order.push(id); }
    byId[id].count++;
    byId[id].items.push(item);
  }
  order.sort(function (a, b) { var x = byId[a].house, y = byId[b].house; return x < y ? -1 : x > y ? 1 : 0; });
  var out = [];
  for (var i = 0; i < order.length; i++) out.push(byId[order[i]]);
  return { available: true, houses: out };
}

// Turn a read context into a panel. Keeps every "unavailable" reason in ONE pure place so the Code.gs
// side only does the SpreadsheetApp read and hands the outcome here.
//   ctx: { configured, readError, missingTab, rows }
function foodShortagesPanel(ctx, idToName) {
  var c = ctx || {};
  if (!c.configured) return { available: false, reason: 'לא הוגדר מזהה דייג׳סט מטבח (Config: kitchen_digest_id)' };
  if (c.readError) return { available: false, reason: 'שגיאת קריאה מדייג׳סט המטבח — בדוק הרשאת צפייה לחשבון הלוגיסטיקה' };
  if (c.missingTab) return { available: false, reason: 'הטאב FoodShortages לא נמצא בדייג׳סט המטבח' };
  return summarizeFoodShortages(c.rows || [], idToName);
}
// === MIRROR:digestconsume END ===

export { FOOD_HOUSE_KEYS, FOOD_ITEM_KEYS, pickHeader, summarizeFoodShortages, foodShortagesPanel };
