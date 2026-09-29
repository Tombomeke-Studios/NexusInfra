// Moving a service's data from one database to another (#241) — the migration
// path for an installation that started on SQLite and moves to PostgreSQL.
//
// Prisma has no cross-provider data migration, and the schema migrations only
// create empty tables. This copies rows model by model through two clients of
// the same schema. Pure apart from the delegates it is handed, so the ordering
// and the refusals are tested without a database; scripts/sqlite-to-postgres.mjs
// wires it to the real clients.

/** The part of Prisma's DMMF this needs: each model and what it points at. */
export interface ModelInfo {
  name: string;
  /** Models this one holds a foreign key to (a relation with `relationFromFields`). */
  dependsOn: string[];
  /** Its primary key, to page through it in a stable order. */
  idFields: string[];
}

export interface TableDelegate {
  count(): Promise<number>;
  findMany(args?: { skip?: number; take?: number; orderBy?: unknown }): Promise<unknown[]>;
  createMany(args: { data: unknown[] }): Promise<{ count: number }>;
}

/** Read Prisma's DMMF into the shape above. */
export function modelsFromDmmf(dmmf: {
  datamodel: {
    models: Array<{
      name: string;
      primaryKey?: { fields: readonly string[] } | null;
      fields: Array<{ name: string; type: string; kind: string; isId?: boolean; relationFromFields?: readonly string[] }>;
    }>;
  };
}): ModelInfo[] {
  return dmmf.datamodel.models.map((m) => ({
    name: m.name,
    dependsOn: m.fields.filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0 && f.type !== m.name).map((f) => f.type),
    idFields: m.primaryKey?.fields?.length ? [...m.primaryKey.fields] : m.fields.filter((f) => f.isId).map((f) => f.name),
  }));
}

/**
 * Models in an order where everything a row points at is already copied.
 * Throws on a cycle rather than guessing: a cycle needs deferred constraints,
 * and silently getting it wrong would fail halfway through a real migration.
 */
export function copyOrder(models: ModelInfo[]): string[] {
  const byName = new Map(models.map((m) => [m.name, m]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const order: string[] = [];
  const visit = (name: string, path: string[]) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`the schema has a relation cycle: ${[...path, name].join(' → ')}`);
    visiting.add(name);
    for (const dep of byName.get(name)?.dependsOn ?? []) if (byName.has(dep)) visit(dep, [...path, name]);
    visiting.delete(name);
    done.add(name);
    order.push(name);
  };
  // Alphabetical first, so the order is the same on every run.
  for (const m of [...models].sort((a, b) => a.name.localeCompare(b.name))) visit(m.name, []);
  return order;
}

/** `ServerConfig` → `serverConfig`, the delegate's name on a Prisma client. */
export const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

export interface CopyResult {
  model: string;
  rows: number;
}

/**
 * Copy every row of every model, in dependency order, then check the counts.
 * Refuses a target that already has rows: merging two installations' data is
 * not a migration, and a half-finished earlier attempt should be cleared first.
 */
export async function copyDatabase(opts: {
  models: ModelInfo[];
  from: (model: string) => TableDelegate;
  to: (model: string) => TableDelegate;
  batchSize?: number;
  log?: (line: string) => void;
}): Promise<CopyResult[]> {
  const { models, from, to } = opts;
  const batchSize = opts.batchSize ?? 500;
  const log = opts.log ?? (() => undefined);
  const order = copyOrder(models);

  const occupied: string[] = [];
  for (const model of order) if ((await to(model).count()) > 0) occupied.push(model);
  if (occupied.length) {
    throw new Error(`the target database already has rows in ${occupied.join(', ')} — copy into a freshly migrated, empty database`);
  }

  const results: CopyResult[] = [];
  const byName = new Map(models.map((m) => [m.name, m]));
  for (const model of order) {
    let copied = 0;
    // Paging needs a total order, or a batch boundary can skip a row or repeat one.
    const orderBy = (byName.get(model)?.idFields ?? []).map((f) => ({ [f]: 'asc' }));
    for (let skip = 0; ; skip += batchSize) {
      const rows = await from(model).findMany({ skip, take: batchSize, ...(orderBy.length ? { orderBy } : {}) });
      if (rows.length === 0) break;
      copied += (await to(model).createMany({ data: rows })).count;
      if (rows.length < batchSize) break;
    }
    const [source, target] = [await from(model).count(), await to(model).count()];
    if (source !== target) throw new Error(`${model}: copied ${target} rows but the source has ${source} — the source changed during the copy; stop the service and run again`);
    log(`${model}: ${copied} row${copied === 1 ? '' : 's'}`);
    results.push({ model, rows: copied });
  }
  return results;
}
