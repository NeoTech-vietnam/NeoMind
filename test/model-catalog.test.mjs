import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCatalogModel } from '../dist/model-catalog.js';

const provider = 'Endpoint group';
const vendor = 'customendpoint';
const entry = { id: 'canonical-id', name: 'Display Name' };
const group = { name: provider, vendor, models: [entry] };
const resolved = { ...entry, vendor };

test('catalog resolves raw and decorated IDs and display names in provider name or vendor scope', () => {
  const catalog = [group, { name: 'Other group', vendor: 'other-vendor', models: [entry] }];
  for (const scope of [provider, vendor]) {
    for (const requested of [entry.id, entry.name, `${entry.id} (${vendor})`, `${entry.name} (${vendor})`]) {
      assert.deepEqual(resolveCatalogModel(catalog, requested, scope), resolved, `${scope}: ${requested}`);
    }
  }
  assert.equal(resolveCatalogModel(catalog, entry.id, 'missing-provider'), undefined);
  assert.equal(resolveCatalogModel(catalog, `${entry.id} (other-vendor)`, provider), undefined);
  assert.equal(resolveCatalogModel(catalog, `${entry.name} (other-vendor)`, provider), undefined);
  assert.equal(resolveCatalogModel(catalog, `${entry.id} (${provider})`, provider), undefined);
});

test('literal IDs containing parentheses take precedence over display names and decorated aliases', () => {
  const literal = { id: `${entry.id} (${vendor})`, name: 'Literal ID Winner' };
  const catalog = [{ ...group, models: [entry, literal, { id: 'display-collision', name: literal.id }] }];
  assert.deepEqual(resolveCatalogModel(catalog, literal.id, provider), { ...literal, vendor });
  // Qualified aliases with two matching entries remain ambiguous, unlike an exact ID.
  assert.equal(resolveCatalogModel(catalog, `${literal.id} (${vendor})`, provider), undefined);
  assert.deepEqual(resolveCatalogModel([{ ...group, models: [entry, literal] }],
    `${literal.id} (${vendor})`, provider), { ...literal, vendor });
  const displayLiteral = { id: `${entry.name} (${vendor})`, name: 'Another Literal Winner' };
  assert.deepEqual(resolveCatalogModel([{ ...group, models: [entry, displayLiteral] }], displayLiteral.id, provider),
    { ...displayLiteral, vendor });
  const parentheses = { id: 'model (preview)', name: 'Display (preview)' };
  for (const requested of [parentheses.id, parentheses.name, `${parentheses.id} (${vendor})`, `${parentheses.name} (${vendor})`]) {
    assert.deepEqual(resolveCatalogModel([{ ...group, models: [parentheses] }], requested, provider),
      { ...parentheses, vendor });
  }
});

test('settings-shaped catalogs resolve keys without exposing endpoint settings or credentials', () => {
  const catalog = [{ name: provider, vendor, apiKey: 'private-key', settings: {
    'settings-id': { url: 'https://private.invalid', apiKey: 'private-key', name: 'Not a catalog display name' },
    'settings (preview)': {},
  } }];
  for (const id of ['settings-id', 'settings (preview)']) {
    for (const requested of [id, `${id} (${vendor})`]) {
      assert.deepEqual(resolveCatalogModel(catalog, requested, provider), { id, name: id, vendor });
    }
  }
  assert.equal(resolveCatalogModel(catalog, 'Not a catalog display name', provider), undefined);
  assert.equal(resolveCatalogModel(catalog, 'settings-id (wrong-vendor)', provider), undefined);
});

test('duplicate catalog entries remain ambiguous within and across provider-scoped groups', () => {
  const catalogs = [
    [{ ...group, models: [entry, { ...entry }] }],
    [group, { ...group, models: [{ ...entry }] }],
    [group, { name: provider, vendor, settings: { [entry.id]: {} } }],
    [{ ...group, settings: { [entry.id]: {} } }],
  ];
  for (const catalog of catalogs) {
    for (const scope of [undefined, provider, vendor]) {
      for (const requested of [entry.id, `${entry.id} (${vendor})`]) {
        assert.equal(resolveCatalogModel(catalog, requested, scope), undefined,
          `${scope ?? 'unscoped'}: ${requested}`);
      }
    }
  }
  for (const models of [[entry, { ...entry }], [entry, { id: 'another-id', name: entry.name }]]) {
    for (const requested of [entry.name, `${entry.name} (${vendor})`]) {
      assert.equal(resolveCatalogModel([{ ...group, models }], requested, provider), undefined);
    }
  }
  const sharedVendor = [group, { name: 'Other group', vendor, models: [{ ...entry }] }];
  assert.equal(resolveCatalogModel(sharedVendor, entry.id, vendor), undefined);
  assert.deepEqual(resolveCatalogModel(sharedVendor, `${entry.id} (${vendor})`, provider), resolved);
});

test('malformed catalog entries are ignored and missing vendor never creates a decorated alias', () => {
  const catalog = [null, [], 'invalid', { ...group, models: [null, [], 'invalid', entry] }];
  assert.deepEqual(resolveCatalogModel(catalog, entry.id, provider), resolved);
  const noVendor = [{ name: provider, models: [entry] }];
  assert.deepEqual(resolveCatalogModel(noVendor, entry.id, provider), { ...entry, vendor: undefined });
  assert.equal(resolveCatalogModel(noVendor, `${entry.id} (${vendor})`, provider), undefined);
});
