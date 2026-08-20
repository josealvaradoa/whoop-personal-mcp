// Mocks the WHOOP REST API at the network layer via undici's MockAgent. The client
// (src/whoop/client.ts) uses the global `fetch`, whose dispatcher we swap here — so
// NO source change is needed to inject the mock. supertest is unaffected (it uses
// Node's http module, not undici's fetch dispatcher).
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import type { Cycle, Recovery, Sleep, Workout } from "../../src/whoop/types.js";

const WHOOP_ORIGIN = "https://api.prod.whoop.com";

export interface WhoopData {
  cycles?: Cycle[];
  recoveries?: Recovery[];
  sleeps?: Sleep[];
  workouts?: Workout[];
}

let originalDispatcher: Dispatcher | null = null;

/**
 * Install a MockAgent that answers every WHOOP collection endpoint with the given
 * fixtures (defaults to empty collections → exercises the missing-data path).
 * Interceptors are `.persist()`ed so the same endpoint can be hit across pages
 * and repeated tool calls.
 */
export function installWhoopMock(data: WhoopData = {}): MockAgent {
  if (originalDispatcher === null) originalDispatcher = getGlobalDispatcher();

  const agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);

  const pool = agent.get(WHOOP_ORIGIN);
  // Match on the path prefix, ignoring the (timestamp-bearing) query string.
  const at = (prefix: string) => (path: string) => path.split("?")[0] === prefix;
  const page = (records: unknown[]) => ({ records, next_token: null });

  const collections: Array<[string, unknown[]]> = [
    ["/developer/v2/cycle", data.cycles ?? []],
    ["/developer/v2/recovery", data.recoveries ?? []],
    ["/developer/v2/activity/sleep", data.sleeps ?? []],
    ["/developer/v2/activity/workout", data.workouts ?? []],
  ];

  for (const [prefix, records] of collections) {
    pool
      .intercept({ path: at(prefix), method: "GET" })
      .reply(200, page(records), { headers: { "content-type": "application/json" } })
      .persist();
  }

  return agent;
}

/** Restore the pre-test global dispatcher and close the mock agent. */
export async function uninstallWhoopMock(agent?: MockAgent): Promise<void> {
  if (agent) await agent.close();
  if (originalDispatcher) setGlobalDispatcher(originalDispatcher);
}
