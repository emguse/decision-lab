import { validateConnection, type Connection } from './connections.js';
import { LocalDecisionProvider } from './local-provider.js';
import type { ConfiguredDecisionProvider } from './provider.js';
import { SystemOneProvider } from './systemone-provider.js';

export class StrandsProvider
  extends LocalDecisionProvider
  implements ConfiguredDecisionProvider
{
  readonly connection: Connection;
  constructor(connection: Connection, fetcher: typeof fetch = fetch) {
    connection = validateConnection(connection);
    if (connection.adapter !== 'strands')
      throw new Error('Expected Strands connection');
    super(
      new URL(connection.endpoint).origin,
      connection.model,
      fetcher,
      connection.timeout_ms,
    );
    this.connection = connection;
  }
  get config() {
    return {
      configured: this.configured,
      model: this.connection.model,
      adapter: this.connection.adapter,
      label: this.connection.label,
      modelEditable: false,
      healthCheck: true,
      questionInteraction: this.connection.question_interaction,
      guidance:
        'Load the model in the Python service. Score criteria must be strings and Choice needs at least two options. Strict input overflow rejection is unverified.',
    };
  }
}

export function createConnectionProvider(
  connection: Connection,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): ConfiguredDecisionProvider {
  connection = validateConnection(connection);
  return connection.adapter === 'strands'
    ? new StrandsProvider(connection, fetcher)
    : new SystemOneProvider(
        connection,
        connection.api_key_env ? env[connection.api_key_env] : undefined,
        fetcher,
      );
}
