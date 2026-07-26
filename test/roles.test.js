// test/roles.test.js — locks server-side role enforcement (increment 28): the authorization
// matrix for every write action, fail-closed identity, and coordinator house-scoping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROLES, ALL_ROLES, isActive, findUser, userCoversHouse, authorizeAction,
} from '../src/roles.js';
import { SEED_USERS } from '../src/schema.js';

// Fixtures modeled on the seed roster.
const roy   = { name: 'רועי',  role: ROLES.FIELD_OPS,   house: '*', active: true };
const olga  = { name: 'אולגה', role: ROLES.OPS_MANAGER, house: '*', active: true };
const sandra = { name: 'סנדרה', role: ROLES.CEO,        house: '*', active: true };
const rami  = { name: 'רמי',   role: ROLES.MAINTENANCE, house: 'cluster:sharon', active: true };
const shira = { name: 'שירה',  role: ROLES.COORDINATOR, house: 'קיסריה עפרוני', active: true };
const inactive = { name: 'רפאים', role: ROLES.FIELD_OPS, house: '*', active: false };

const HOUSES_BY_NAME = {
  'רעננה': { name: 'רעננה', cluster: 'sharon' },
  'קיסריה עפרוני': { name: 'קיסריה עפרוני', cluster: 'caesarea' },
};

// ---- fail-closed identity ----

test('unknown user is authorized for NOTHING', () => {
  for (const action of ['create', 'approve', 'reject', 'defer', 'assign', 'inventory']) {
    assert.match(authorizeAction(null, action, { resolvedApprover: ROLES.FIELD_OPS }), /לא מוכר/);
  }
});

test('inactive user is rejected on every action', () => {
  for (const action of ['create', 'approve', 'reject', 'defer', 'assign', 'inventory']) {
    assert.match(authorizeAction(inactive, action, { resolvedApprover: ROLES.FIELD_OPS }), /אינו פעיל/);
  }
});

test('unrecognized role is rejected', () => {
  const weird = { name: 'x', role: 'wizard', house: '*', active: true };
  assert.match(authorizeAction(weird, 'create', {}), /תפקיד לא מוכר/);
});

test('isActive handles Sheet strings and real booleans; fails closed on junk', () => {
  assert.equal(isActive({ active: 'TRUE' }), true);
  assert.equal(isActive({ active: true }), true);
  assert.equal(isActive({ active: '1' }), true);
  assert.equal(isActive({ active: 'FALSE' }), false);
  assert.equal(isActive({ active: '' }), false);
  assert.equal(isActive(null), false);
});

// ---- approve / reject: only the resolved approver (plus ceo) ----

test('approve/reject: only the resolved approver role may act', () => {
  // field_ops-tier request
  assert.equal(authorizeAction(roy,  'approve', { resolvedApprover: ROLES.FIELD_OPS }), null);
  assert.match(authorizeAction(olga, 'approve', { resolvedApprover: ROLES.FIELD_OPS }), /אינו המאשר/);
  // ops_manager-tier request
  assert.equal(authorizeAction(olga, 'approve', { resolvedApprover: ROLES.OPS_MANAGER }), null);
  assert.match(authorizeAction(roy,  'reject',  { resolvedApprover: ROLES.OPS_MANAGER }), /אינו המאשר/);
  // ceo can approve/reject anything
  assert.equal(authorizeAction(sandra, 'approve', { resolvedApprover: ROLES.FIELD_OPS }), null);
  assert.equal(authorizeAction(sandra, 'reject',  { resolvedApprover: ROLES.OPS_MANAGER }), null);
  // emergency (auto): any active user may confirm
  assert.equal(authorizeAction(shira, 'approve', { resolvedApprover: 'auto' }), null);
});

test('a coordinator can never approve/reject a normal (non-auto) request', () => {
  assert.match(authorizeAction(shira, 'approve', { resolvedApprover: ROLES.FIELD_OPS }), /אינו המאשר/);
  assert.match(authorizeAction(rami,  'reject',  { resolvedApprover: ROLES.OPS_MANAGER }), /אינו המאשר/);
});

// ---- defer / assign: field_ops, ops_manager, ceo only ----

test('defer/assign allowed for field_ops, ops_manager, ceo — rejected for others', () => {
  for (const action of ['defer', 'assign']) {
    assert.equal(authorizeAction(roy,   action, {}), null);
    assert.equal(authorizeAction(olga,  action, {}), null);
    assert.equal(authorizeAction(sandra, action, {}), null);
    assert.match(authorizeAction(rami,  action, {}), /אינו מורשה/); // maintenance
    assert.match(authorizeAction(shira, action, {}), /אינו מורשה/); // coordinator
  }
});

// ---- inventory count submit ----

test('inventory: coordinator own-house only, maintenance backstop, ops roles anywhere', () => {
  // coordinator on own house → ok
  assert.equal(
    authorizeAction(shira, 'inventory', { house: 'קיסריה עפרוני', housesByName: HOUSES_BY_NAME }),
    null,
  );
  // coordinator cross-house → rejected
  assert.match(
    authorizeAction(shira, 'inventory', { house: 'רעננה', housesByName: HOUSES_BY_NAME }),
    /מוגבל/,
  );
  // maintenance backstop → allowed
  assert.equal(
    authorizeAction(rami, 'inventory', { house: 'רעננה', housesByName: HOUSES_BY_NAME }),
    null,
  );
  // ops roles anywhere
  assert.equal(authorizeAction(roy, 'inventory', { house: 'רעננה', housesByName: HOUSES_BY_NAME }), null);
});

// ---- request creation ----

test('create: any active user; coordinator own-house only', () => {
  assert.equal(authorizeAction(roy, 'create', { house: 'רעננה' }), null);
  assert.equal(authorizeAction(rami, 'create', { house: 'רעננה' }), null);
  assert.equal(authorizeAction(shira, 'create', { house: 'קיסריה עפרוני', housesByName: HOUSES_BY_NAME }), null);
  assert.match(
    authorizeAction(shira, 'create', { house: 'רעננה', housesByName: HOUSES_BY_NAME }),
    /מוגבל/,
  ); // coordinator cross-house rejection
});

// ---- house-scope resolution ----

test('userCoversHouse: all / cluster / literal', () => {
  assert.equal(userCoversHouse(roy, 'רעננה', HOUSES_BY_NAME), true);      // '*'
  assert.equal(userCoversHouse(rami, 'רעננה', HOUSES_BY_NAME), true);     // cluster sharon
  assert.equal(userCoversHouse(rami, 'קיסריה עפרוני', HOUSES_BY_NAME), false); // caesarea ≠ sharon
  assert.equal(userCoversHouse(shira, 'קיסריה עפרוני', HOUSES_BY_NAME), true); // literal
  assert.equal(userCoversHouse(shira, 'רעננה', HOUSES_BY_NAME), false);
});

test('cluster scope with multiple clusters (caesarea+north)', () => {
  const tzachi = { name: 'צחי', role: ROLES.MAINTENANCE, house: 'cluster:caesarea+north', active: true };
  const byName = {
    'ריהאב': { cluster: 'caesarea' }, 'שדה אליעזר': { cluster: 'north' }, 'רעננה': { cluster: 'sharon' },
  };
  assert.equal(userCoversHouse(tzachi, 'ריהאב', byName), true);
  assert.equal(userCoversHouse(tzachi, 'שדה אליעזר', byName), true);
  assert.equal(userCoversHouse(tzachi, 'רעננה', byName), false);
});

// ---- roster integrity ----

test('findUser locates seeded users and returns null for strangers', () => {
  assert.equal(findUser(SEED_USERS, 'רועי').role, ROLES.FIELD_OPS);
  assert.equal(findUser(SEED_USERS, 'אולגה').role, ROLES.OPS_MANAGER);
  assert.equal(findUser(SEED_USERS, 'סנדרה').role, ROLES.CEO);
  assert.equal(findUser(SEED_USERS, 'מתחזה'), null);
});

test('every seeded user has a recognized role', () => {
  for (const u of SEED_USERS) assert.ok(ALL_ROLES.includes(u.role), `bad role: ${u.role}`);
});
