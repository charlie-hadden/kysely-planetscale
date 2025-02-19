import {cast, Config, connect, Connection, Field} from '@planetscale/database'
import {parseJSON} from 'date-fns'
import {
  CompiledQuery,
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  Driver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  QueryCompiler,
  QueryResult,
} from 'kysely'

/**
 * Config for the PlanetScale dialect. It extends {@link Config} from `@planetscale/database`,
 * so you can pass any of those options to the constructor.
 *
 * @see https://github.com/planetscale/database-js#usage
 */
export interface PlanetScaleDialectConfig extends Config {}

/**
 * PlanetScale dialect that uses the [PlanetScale Serverless Driver for JavaScript][0].
 * The constructor takes an instance of {@link Config} from `@planetscale/database`.
 *
 * ```typescript
 * new PlanetScaleDialect({
 *   host: '<host>',
 *   username: '<username>',
 *   password: '<password>',
 * })
 *
 * // or with a connection URL
 *
 * new PlanetScaleDialect({
 *   url: process.env.DATABASE_URL ?? 'mysql://<username>:<password>@<host>/<database>'
 * })
 * ```
 *
 * See the [`@planetscale/database` documentation][1] for more information.
 *
 * [0]: https://github.com/planetscale/database-js
 * [1]: https://github.com/planetscale/database-js#readme
 */
export class PlanetScaleDialect implements Dialect {
  #config: PlanetScaleDialectConfig

  constructor(config: PlanetScaleDialectConfig) {
    this.#config = config
  }

  createAdapter() {
    return new MysqlAdapter()
  }

  createDriver(): Driver {
    return new PlanetScaleDriver(this.#config)
  }

  createQueryCompiler(): QueryCompiler {
    return new MysqlQueryCompiler()
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new MysqlIntrospector(db)
  }
}

class PlanetScaleDriver implements Driver {
  #config: PlanetScaleDialectConfig

  constructor(config: PlanetScaleDialectConfig) {
    this.#config = config
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new PlanetScaleConnection(this.#config)
  }

  async beginTransaction(conn: PlanetScaleConnection): Promise<void> {
    return await conn.beginTransaction()
  }

  async commitTransaction(conn: PlanetScaleConnection): Promise<void> {
    return await conn.commitTransaction()
  }

  async rollbackTransaction(conn: PlanetScaleConnection): Promise<void> {
    return await conn.rollbackTransaction()
  }

  async releaseConnection(_conn: PlanetScaleConnection): Promise<void> {}

  async destroy(): Promise<void> {}
}

class PlanetScaleConnection implements DatabaseConnection {
  #config: PlanetScaleDialectConfig
  #conn: Connection
  #transactionClient?: PlanetScaleConnection

  constructor(config: PlanetScaleDialectConfig) {
    this.#config = config
    this.#conn = connect({cast: inflateDates, ...config})
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    if (this.#transactionClient) return this.#transactionClient.executeQuery(compiledQuery)

    // If no custom formatter is provided, format dates as DB date strings
    const parameters = this.#config.format
      ? compiledQuery.parameters
      : compiledQuery.parameters.map((param) => (param instanceof Date ? formatDate(param) : param))

    const results = await this.#conn.execute(compiledQuery.sql, parameters)

    // @planetscale/database versions older than 1.3.0 return errors directly, rather than throwing
    if ((results as any).error) {
      throw (results as any).error
    }

    return {
      rows: results.rows as O[],
      numUpdatedOrDeletedRows: results.rowsAffected == null ? undefined : BigInt(results.rowsAffected),
    }
  }

  async beginTransaction() {
    this.#transactionClient = this.#transactionClient ?? new PlanetScaleConnection(this.#config)
    this.#transactionClient.#conn.execute('BEGIN')
  }

  async commitTransaction() {
    if (!this.#transactionClient) throw new Error('No transaction to commit')
    this.#transactionClient.#conn.execute('COMMIT')
    this.#transactionClient = undefined
  }

  async rollbackTransaction() {
    if (!this.#transactionClient) throw new Error('No transaction to rollback')
    this.#transactionClient.#conn.execute('ROLLBACK')
    this.#transactionClient = undefined
  }

  async *streamQuery<O>(_compiledQuery: CompiledQuery, _chunkSize: number): AsyncIterableIterator<QueryResult<O>> {
    throw new Error('PlanetScale Serverless Driver does not support streaming')
  }
}

/**
 * Converts dates returned from the database to JavaScript Date objects. This is the default
 * `cast` function passed to the `@planetscale/database` library, but you can override it by
 * passing your own alternative `cast` function to {@link Config}.
 */
export function inflateDates(field: Field, value: string | null) {
  if (field.type === 'DATETIME' && value) return parseJSON(value)
  if (field.type === 'TIMESTAMP' && value) return parseJSON(value)
  return cast(field, value)
}

function formatDate(date: Date): string {
  return date.toISOString().replace(/[TZ]/g, ' ').trim()
}
