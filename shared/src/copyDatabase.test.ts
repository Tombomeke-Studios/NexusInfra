import { describe, it, expect } from 'vitest';
import { copyDatabase, copyOrder, delegateName, modelsFromDmmf, type TableDelegate } from './copyDatabase.js';

// Moving an installation from SQLite to PostgreSQL (#241).

/** An in-memory table with the three calls the copy uses. */
function table(rows: Array<Record<string, unknown>> = [], onCreate?: () => void): TableDelegate & { rows: Array<Record<string, unknown>> } {
  return {
    rows,
    async count() {
      return rows.length;
    },
    async findMany(args) {
      const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return sorted.slice(args?.skip ?? 0, (args?.skip ?? 0) + (args?.take ?? sorted.length));
    },
    async createMany({ data }) {
      onCreate?.();
      rows.push(...(data as Array<Record<string, unknown>>));
      return { count: data.length };
    },
  };
}

describe('modelsFromDmmf', () => {
  it('reads foreign keys and primary keys, ignoring back-relations', () => {
    const models = modelsFromDmmf({
      datamodel: {
        models: [
          { name: 'Team', fields: [{ name: 'id', type: 'String', kind: 'scalar', isId: true }, { name: 'members', type: 'TeamMember', kind: 'object', relationFromFields: [] }] },
          { name: 'TeamMember', primaryKey: { fields: ['teamId', 'userId'] }, fields: [{ name: 'team', type: 'Team', kind: 'object', relationFromFields: ['teamId'] }] },
        ],
      },
    });
    expect(models).toEqual([
      { name: 'Team', dependsOn: [], idFields: ['id'] },
      { name: 'TeamMember', dependsOn: ['Team'], idFields: ['teamId', 'userId'] },
    ]);
  });
});

describe('copyOrder', () => {
  it('puts every table after the ones it points at', () => {
    const order = copyOrder([
      { name: 'DeploymentEvent', dependsOn: ['Deployment'], idFields: ['id'] },
      { name: 'Deployment', dependsOn: ['ServerConfig', 'Node'], idFields: ['id'] },
      { name: 'ServerConfig', dependsOn: ['Team'], idFields: ['id'] },
      { name: 'Node', dependsOn: [], idFields: ['id'] },
      { name: 'Team', dependsOn: [], idFields: ['id'] },
    ]);
    expect(order.indexOf('Team')).toBeLessThan(order.indexOf('ServerConfig'));
    expect(order.indexOf('ServerConfig')).toBeLessThan(order.indexOf('Deployment'));
    expect(order.indexOf('Node')).toBeLessThan(order.indexOf('Deployment'));
    expect(order.indexOf('Deployment')).toBeLessThan(order.indexOf('DeploymentEvent'));
  });

  it('refuses a cycle rather than guessing', () => {
    expect(() => copyOrder([{ name: 'A', dependsOn: ['B'], idFields: [] }, { name: 'B', dependsOn: ['A'], idFields: [] }])).toThrow(/relation cycle/);
  });

  it('names a delegate the way Prisma does', () => {
    expect(delegateName('ServerConfig')).toBe('serverConfig');
  });
});

describe('copyDatabase', () => {
  const models = [
    { name: 'Parent', dependsOn: [], idFields: ['id'] },
    { name: 'Child', dependsOn: ['Parent'], idFields: ['id'] },
  ];

  it('copies every row in batches, parents first, and reports the counts', async () => {
    const created: string[] = [];
    const src = { Parent: table(Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` }))), Child: table(Array.from({ length: 1201 }, (_, i) => ({ id: `c${String(i).padStart(4, '0')}` }))) };
    const dst = { Parent: table([], () => created.push('Parent')), Child: table([], () => created.push('Child')) };
    const lines: string[] = [];
    const result = await copyDatabase({ models, from: (m) => src[m as 'Parent'], to: (m) => dst[m as 'Parent'], batchSize: 500, log: (l) => lines.push(l) });

    expect(result).toEqual([{ model: 'Parent', rows: 5 }, { model: 'Child', rows: 1201 }]);
    expect(created).toEqual(['Parent', 'Child', 'Child', 'Child']);
    // No row lost or repeated across batch boundaries.
    expect(new Set(dst.Child.rows.map((r) => r.id)).size).toBe(1201);
    expect(lines).toEqual(['Parent: 5 rows', 'Child: 1201 rows']);
  });

  it('refuses a target that already has data', async () => {
    const src = { Parent: table([{ id: 'p' }]), Child: table() };
    const dst = { Parent: table(), Child: table([{ id: 'already' }]) };
    await expect(copyDatabase({ models, from: (m) => src[m as 'Parent'], to: (m) => dst[m as 'Parent'] })).rejects.toThrow(/already has rows in Child/);
    expect(dst.Parent.rows).toEqual([]);
  });

  it('notices a source that changed during the copy', async () => {
    const parent = table([{ id: 'p1' }]);
    const grow = { ...parent, count: async () => parent.rows.length + 1 };
    const dst = { Parent: table(), Child: table() };
    await expect(copyDatabase({ models, from: (m) => (m === 'Parent' ? grow : table()), to: (m) => dst[m as 'Parent'] })).rejects.toThrow(/stop the service and run again/);
  });
});
